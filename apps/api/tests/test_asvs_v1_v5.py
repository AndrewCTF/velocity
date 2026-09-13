"""ASVS 5.0 L2, chapters V1–V5: backend findings from the 2026-09-13 audit.

One test (or a small group) per finding id; the id is in each section header.
"""

from __future__ import annotations

import asyncio
import io
import tarfile
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import auth
from app.config import get_settings
from app.main import create_app

LONG_KEY = "static-key-for-the-v1-v5-tests-0123456789abc"


def _app(monkeypatch, **env: str) -> TestClient:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    auth.reset_state()
    return TestClient(create_app())


# ── V3.5.1 / V3.5.2 / V4.4.2: cross-site writes, WS hijack, DNS rebinding ────


def test_a_foreign_origin_cannot_post_to_a_keyless_box(monkeypatch):
    with _app(monkeypatch, ALLOWED_HOSTS="testserver") as c:
        files = {"file": ("x.csv", b"a,b\n1,2\n", "text/csv")}
        r = c.post("/api/foundry/datasets/upload", files=files, data={"name": "x"},
                   headers={"Origin": "https://evil.example"})
        assert r.status_code == 403
        r = c.post("/api/foundry/datasets/upload", files=files, data={"name": "x"},
                   headers={"Referer": "https://evil.example/page"})
        assert r.status_code == 403
        # Same-host origin, an allowed CORS origin, and no Origin at all (curl,
        # server-to-server) all still work.
        for i, h in enumerate(({"Origin": "http://testserver"}, {"Origin": "http://localhost:5173"}, {})):
            r = c.post("/api/foundry/datasets/upload", files=files, data={"name": f"ok{i}"}, headers=h)
            assert r.status_code == 200, (h, r.text)
        # Reads are not state-changing.
        assert c.get("/api/health", headers={"Origin": "https://evil.example"}).status_code == 200


def test_a_foreign_origin_cannot_open_a_websocket(monkeypatch):
    from starlette.testclient import WebSocketDenialResponse
    from starlette.websockets import WebSocketDisconnect

    with _app(monkeypatch, ALLOWED_HOSTS="testserver") as c:
        with pytest.raises((WebSocketDenialResponse, WebSocketDisconnect)):
            with c.websocket_connect("/ws/alerts", headers={"Origin": "https://evil.example"}) as ws:
                ws.receive_json()
        with c.websocket_connect("/ws/alerts", headers={"Origin": "http://localhost:5173"}) as ws:
            assert ws is not None


def test_unknown_host_headers_are_refused(monkeypatch):
    with _app(monkeypatch, ALLOWED_HOSTS="") as c:
        assert c.get("/api/health", headers={"Host": "attacker.example"}).status_code == 400
        assert c.get("/api/health", headers={"Host": "localhost:8000"}).status_code == 200
        assert c.get("/api/health", headers={"Host": "127.0.0.1:8000"}).status_code == 200
    with _app(monkeypatch, ALLOWED_HOSTS="*") as c:
        assert c.get("/api/health", headers={"Host": "anything.example"}).status_code == 200
    with _app(monkeypatch, ALLOWED_HOSTS="", CORS_ORIGINS="https://velocity.example") as c:
        assert c.get("/api/health", headers={"Host": "velocity.example"}).status_code == 200


# ── V3.4.4 / V3.4.5: security headers on every response, errors included ────


def test_401_429_and_preflight_carry_security_headers(monkeypatch):
    with _app(monkeypatch, API_KEY=LONG_KEY, API_RATELIMIT_PER_MIN="1") as c:
        r = c.get("/api/watch-officer/status")
        assert r.status_code == 401
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
        r = c.get("/api/watch-officer/status")
        assert r.status_code == 429 and r.headers["x-frame-options"] == "DENY"
        r = c.options("/api/foundry/datasets", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
        assert r.headers["x-content-type-options"] == "nosniff"


# ── V2.3.2: the recon job cap cannot be raced past ──────────────────────────


def test_recon_active_cap_holds_under_concurrent_submits(monkeypatch, tmp_path):
    from app.routes import recon

    (tmp_path / ".venv").mkdir()
    monkeypatch.setattr(recon, "_FUSION", tmp_path)
    monkeypatch.setattr(recon, "_JOBS_ROOT", tmp_path / ".recon_jobs")
    monkeypatch.setattr(recon, "_JOBS", {})
    monkeypatch.setenv("RECON_MAX_ACTIVE_JOBS", "2")
    get_settings.cache_clear()

    async def _slow_write(uf, dest, cap, used):
        await asyncio.sleep(0.05)
        Path(dest).write_bytes(b"\xff\xd8\xff\xe0" + b"0" * 64)  # noqa: ASYNC240
        return used + 68

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(recon, "write_capped", _slow_write)
    monkeypatch.setattr(recon, "_pipeline", _noop)
    monkeypatch.setattr(recon, "_pipeline_mapany", _noop)

    class _UF:
        filename = "a.jpg"

    class _Req:
        headers: dict[str, str] = {}
        client = None

    async def _one():
        try:
            await recon.create_job(_Req(), files=[_UF()], steps=7000, sh=3, down=1,
                                   matcher="sequential", mode="full")
            return 200
        except HTTPException as exc:
            return exc.status_code

    async def _race():
        return await asyncio.gather(*(_one() for _ in range(6)))

    codes = asyncio.run(_race())
    assert codes.count(200) == 2 and codes.count(429) == 4, codes


# ── V5.2.2: recon uploads are images or video, by extension AND content ─────


def test_recon_upload_refuses_wrong_type_and_mismatched_magic(monkeypatch, tmp_path):
    from app.routes import recon

    assert recon._content_matches(".jpg", b"\xff\xd8\xff\xe0rest")
    assert recon._content_matches(".png", b"\x89PNG\r\n\x1a\nrest")
    assert recon._content_matches(".mp4", b"\x00\x00\x00\x18ftypmp42")
    assert not recon._content_matches(".jpg", b"<?php echo 1; ?>")
    assert not recon._content_matches(".sh", b"#!/bin/sh")
    assert not recon._allowed_name("payload.sh")
    assert recon._allowed_name("frame.JPG")


# ── V2.3.3: concurrent appends to one dataset lose nothing ──────────────────


def test_concurrent_appends_keep_every_row(client: TestClient):
    from app.foundry.store import FoundryStore

    r = client.post(
        "/api/foundry/datasets/upload",
        files={"file": ("seed.csv", b"n\n0\n", "text/csv")}, data={"name": "race"},
    )
    ds = r.json().get("dataset_id") or r.json()["id"]
    store = FoundryStore(get_settings())

    async def _race():
        await asyncio.gather(*(store.append_version(ds, [{"n": i}]) for i in range(1, 9)))

    asyncio.run(_race())
    rows = client.get(f"/api/foundry/datasets/{ds}/rows?limit=100").json()
    got = rows.get("rows", rows) if isinstance(rows, dict) else rows
    assert len(got) == 9, got


# ── V1.2.4 / V1.3.3 / V2.2.1: Overpass/WFS bbox is four numbers ─────────────


@pytest.mark.parametrize(
    "bbox",
    [
        "1,2,3,4);out;node(1",
        "a,b,c,d",
        "0,0,200,10",
        "0,95,1,96",
        "0,10,1,5",
        "nan,0,1,1",
        "1,2,3",
    ],
)
def test_bbox_routes_reject_anything_but_a_valid_box(client: TestClient, bbox: str):
    for path in ("/api/osm/military", "/api/osm/wikimapia", "/api/infra/mines"):
        assert client.get(path, params={"bbox": bbox}).status_code in (400, 422), (path, bbox)


def test_overpass_query_is_built_from_parsed_floats(monkeypatch):
    from app.routes import mega_feeds

    assert mega_feeds._strict_bbox(" -10.5, 20 ,30,40.25") == (-10.5, 20.0, 30.0, 40.25)


# ── V1.3.10: monitor prompt templates cannot reach object attributes ────────


def test_monitor_prompt_template_is_not_str_format():
    from app.foundry import monitors

    out = monitors.render_prompt("{dataset.__class__.__mro__} {dataset} {rows} {trigger}", "ds", "[1]", "t")
    assert "__mro__" in out and "<class" not in out
    assert "ds [1] t" in out


# ── V1.2.2: op.http row values are URL-encoded into the URL ─────────────────


def test_op_http_url_template_encodes_row_values():
    from app.workflows import blocks

    url = blocks._template_row("http://h/items/{id}?q={q}", {"id": "../admin", "q": "a&b=c"}, url=True)
    assert url == "http://h/items/..%2Fadmin?q=a%26b%3Dc"
    # Non-URL templates (alerts, bodies) keep raw substitution.
    assert blocks._template_row("{id}", {"id": "../x"}) == "../x"


# ── V3.2.1: the ground photo proxy never serves SVG inline ──────────────────


def test_ground_photo_refuses_svg(monkeypatch, client: TestClient):
    from app.intel import ground as ground_lib
    from app.routes import ground

    monkeypatch.setattr(ground_lib, "proxy_url", lambda *a: "https://img.example/x")

    class _C:
        async def get(self, url, headers=None):
            return httpx.Response(200, content=b"<svg onload=alert(1)>", headers={"content-type": "image/svg+xml"})

    monkeypatch.setattr(ground, "get_client", lambda: _C())
    r = client.get("/api/ground/photo/mapillary/svgtest1")
    assert r.status_code in (415, 502)
    assert "svg" not in r.headers.get("content-type", "")


# ── V5.2.3: archives are bounded before they are read ───────────────────────


def _zip(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def test_gdelt_zip_is_size_and_member_capped(monkeypatch):
    from app.intel import conflict

    monkeypatch.setattr(conflict, "_GDELT_MAX_UNZIPPED", 1024)
    big = _zip({"x.CSV": b"0" * 4096})

    class _C:
        async def get(self, url, headers=None):
            return httpx.Response(200, content=big)

    monkeypatch.setattr(conflict, "get_client", lambda: _C())
    assert asyncio.run(conflict._fetch_slice("20260101000000")) == []


def test_kmz_member_count_is_capped():
    from app.foundry import ingest
    from app.foundry.store import FoundryError

    many = _zip({f"f{i}.txt": b"" for i in range(ingest.MAX_ARCHIVE_MEMBERS + 1)} | {"doc.kml": b"<kml/>"})
    with pytest.raises(FoundryError):
        ingest.parse_kmz(many)


def test_llama_tar_extraction_is_capped(tmp_path, monkeypatch):
    from app.localllm import binary

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        data = b"0" * 4096
        info = tarfile.TarInfo("llama-b1/llama-server")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))
        evil = tarfile.TarInfo("llama-b1/../../escape")
        evil.size = 1
        tf.addfile(evil, io.BytesIO(b"x"))
    buf.seek(0)
    monkeypatch.setattr(binary, "_MAX_EXTRACT_BYTES", 1024)
    with tarfile.open(fileobj=buf, mode="r:gz") as tf:
        with pytest.raises(ValueError):
            binary.check_archive_bounds(tf)
    assert not (tmp_path.parent / "escape").exists()


# ── V4.1.1: KML export declares its charset ─────────────────────────────────


def test_kml_export_has_charset():
    from app.routes import export

    assert "charset=utf-8" in export._MEDIA["kml"][0]


# ── V2.4.1: X-Velocity-Tier is believed only from a trusted proxy ───────────


def test_tier_header_ignored_from_untrusted_peers(monkeypatch):
    from app import tier

    monkeypatch.setenv("COMMERCIAL_MODE", "0")
    monkeypatch.setenv("TRUSTED_PROXIES", "127.0.0.1")
    get_settings.cache_clear()

    class _Req:
        def __init__(self, host):
            self.client = type("C", (), {"host": host})()

    assert tier.commercial_request(_Req("203.0.113.9"), "paid") is False
    assert tier.commercial_request(_Req("127.0.0.1"), "paid") is True
