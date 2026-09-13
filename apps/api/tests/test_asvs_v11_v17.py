"""ASVS 5.0 L2, chapters V11–V16: backend findings from the 2026-09-13 audit.

One test (or a small group) per finding id; the id is in each section header.
"""

from __future__ import annotations

import asyncio
import logging
import os
import stat
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import auth
from app.config import Settings, get_settings
from app.main import create_app
from tests._authkit import bearer, mint, multi_user

LONG_KEY = "static-key-for-the-v11-v17-tests-0123456789"


def _keyed(monkeypatch, **env: str) -> TestClient:
    monkeypatch.setenv("API_KEY", LONG_KEY)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    auth.reset_state()
    return TestClient(create_app())


# ── V13.2.4 / V15.3.2: /tiler?url= is not an SSRF or a local-file probe ──────


tiler = pytest.importorskip("app.imagery.tiler")


@pytest.mark.parametrize(
    "url",
    [
        "/etc/hostname",
        "file:///etc/hostname",
        "/vsicurl/http://127.0.0.1:9/x.tif",
        "http://127.0.0.1:9/probe.tif",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/x.tif",
        "ftp://example.com/x.tif",
    ],
)
def test_tiler_refuses_local_paths_and_non_public_hosts(client: TestClient, url: str):
    if tiler.build_tiler_app() is None:
        pytest.skip("titiler not installed")
    r = client.get("/tiler/info", params={"url": url})
    assert r.status_code in (400, 403), (r.status_code, r.text)
    # The refusal names no GDAL internals (the probe used to echo them).
    assert "CURL" not in r.text and "not recognized" not in r.text


def test_tiler_url_guard_rechecks_every_redirect_hop(monkeypatch):
    hops = {
        "https://cog.example/a.tif": httpx.Response(302, headers={"location": "http://10.0.0.5/b.tif"}),
    }
    monkeypatch.setattr(tiler, "_resolve", lambda host: ["93.184.216.34"] if host == "cog.example" else ["10.0.0.5"])

    def _head(url: str) -> httpx.Response:
        return hops.get(url, httpx.Response(200))

    monkeypatch.setattr(tiler, "_head_no_redirect", _head)
    tiler._checked.clear()
    with pytest.raises(tiler.CogUrlRefused):
        tiler.check_cog_url("https://cog.example/a.tif")


def test_tiler_fails_closed_on_a_keyless_box(monkeypatch):
    if tiler.build_tiler_app() is None:
        pytest.skip("titiler not installed")
    monkeypatch.setenv("ALLOW_UNAUTHENTICATED", "0")
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        assert c.get("/tiler/healthz").status_code == 503


def test_tiler_is_rate_limited(monkeypatch):
    if tiler.build_tiler_app() is None:
        pytest.skip("titiler not installed")
    monkeypatch.setenv("API_RATELIMIT_PER_MIN", "3")
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        codes = [c.get("/tiler/healthz").status_code for _ in range(4)]
    assert codes[-1] == 429, codes


# ── V13.4.5: API docs are not handed to unauthenticated callers ─────────────


def test_docs_need_a_credential_when_auth_is_on(monkeypatch):
    with _keyed(monkeypatch) as c:
        for path in ("/docs", "/openapi.json", "/redoc"):
            assert c.get(path).status_code == 401, path
        assert c.get("/openapi.json", headers={"X-API-Key": LONG_KEY}).status_code == 200


def test_docs_stay_open_on_a_keyless_dev_box(client: TestClient):
    assert client.get("/openapi.json").status_code == 200


# ── V16.2.3 / V16.1.1: GET /api/audit shows what audit_mutation wrote ───────


def test_a_mutation_appears_in_the_keyless_audit_read(client: TestClient):
    r = client.post("/api/foundry/datasets", json={"name": "audited"})
    assert r.status_code == 200, r.text
    rows = client.get("/api/audit").json()
    assert any(
        row.get("action", "").startswith("POST") and "/api/foundry/datasets" in str(row)
        for row in rows
    ), rows[:3]


# ── V16.3.1–V16.3.4: security events are logged, credentials never are ─────


def test_auth_failures_rate_limits_and_ssrf_refusals_are_logged(monkeypatch, caplog):
    caplog.set_level(logging.WARNING)
    monkeypatch.setenv("API_RATELIMIT_PER_MIN", "2")
    with _keyed(monkeypatch) as c:
        c.get("/api/watch-officer/status", headers={"X-API-Key": "wrong-guess-123"})
        for _ in range(3):
            c.get("/api/watch-officer/status", headers={"X-API-Key": LONG_KEY})
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "auth failure" in text and "path=/api/watch-officer/status" in text
    assert "rate limit" in text
    assert "wrong-guess-123" not in text and LONG_KEY not in text

    caplog.clear()
    from app.workflows import control
    from app.workflows.store import WorkflowError

    with pytest.raises(WorkflowError):
        control.check_sink_url("http://127.0.0.1:9/hook")
    assert any("ssrf refused" in r.getMessage() for r in caplog.records)


def test_forbidden_responses_are_logged(monkeypatch, caplog):
    caplog.set_level(logging.WARNING)
    multi_user(monkeypatch, url=False)
    with TestClient(create_app()) as c:
        assert c.get("/api/workflows", headers=bearer(mint())).status_code == 403
    assert any("forbidden" in r.getMessage() and "/api/workflows" in r.getMessage() for r in caplog.records)


def test_logging_config_uses_utc_iso_timestamps_and_log_level():
    from app import logging_setup

    fmt = logging_setup.build_formatter()
    rec = logging.LogRecord("x", logging.WARNING, __file__, 1, "hello", None, None)
    rec.created = 0.0
    line = fmt.format(rec)
    assert line.startswith("1970-01-01T00:00:00")
    assert "Z" in line.split(" ")[0] or "+00:00" in line.split(" ")[0]
    assert logging_setup.level_for("debug") == logging.DEBUG
    assert logging_setup.level_for("nonsense") == logging.INFO


# ── V13.3.2 / V15.3.1: browser keys only to authenticated callers ───────────


def test_config_withholds_upstream_keys_from_anonymous_callers(monkeypatch):
    with _keyed(monkeypatch, CESIUM_ION_TOKEN="ion-secret", GMAPS_KEY="gmaps-secret") as c:
        anon = c.get("/api/config").json()
        assert anon["cesiumIonToken"] == "" and anon["googleApiKey"] == ""
        authed = c.get("/api/config", headers={"X-API-Key": LONG_KEY}).json()
        assert authed["cesiumIonToken"] == "ion-secret" and authed["googleApiKey"] == "gmaps-secret"


def test_config_is_unchanged_on_a_keyless_box(monkeypatch):
    monkeypatch.setenv("CESIUM_ION_TOKEN", "ion-open")
    get_settings.cache_clear()
    with TestClient(create_app()) as c:
        assert c.get("/api/config").json()["cesiumIonToken"] == "ion-open"


# ── V15.3.3: evidence custody props are not writable through the generic route ─


def test_generic_object_route_refuses_evidence_ids_and_custody_props(client: TestClient):
    r = client.post("/api/ontology/object", json={"id": "evidence:abc", "kind": "evidence", "props": {"sha256": "0" * 64}})
    assert r.status_code == 403
    r = client.post("/api/ontology/object", json={"id": "note:1", "props": {"sha256": "0" * 64}})
    assert r.status_code == 403
    r = client.post("/api/ontology/object", json={"id": "investigation:1", "props": {"nodes": []}})
    assert r.status_code == 200, r.text


def test_ontology_mutations_are_audited():
    from app.routes import ontology

    deps = {getattr(d.dependency, "__name__", "") for d in ontology.router.dependencies}
    assert "audit_mutation" in deps


# ── V14.3.2 / V14.2.2: no caching of API responses by default ───────────────


def test_api_responses_default_to_no_store(client: TestClient):
    assert client.get("/api/health").headers["cache-control"] == "no-store"


def test_routes_that_set_their_own_cache_control_keep_it_and_imagery_is_private():
    root = Path(__file__).resolve().parents[1] / "app" / "routes"
    for name in ("imagery.py", "cams.py", "ground.py", "places.py"):
        assert "public, max-age" not in (root / name).read_text(), name


# ── V12.3.1: https upstreams, and no https→http downgrade ───────────────────


def test_known_upstreams_use_https():
    app_dir = Path(__file__).resolve().parents[1] / "app"
    assert '"https://data.gdeltproject.org/gdeltv2"' in (app_dir / "intel" / "conflict.py").read_text()
    assert "http://web.archive.org" not in (app_dir / "osint" / "sources" / "infra.py").read_text()
    assert "http://ip-api.com" not in (app_dir / "osint" / "connectors.py").read_text()
    assert "http://www.xinhuanet.com" not in (app_dir / "news" / "feeds_register.py").read_text()


def test_shared_client_refuses_an_https_to_http_redirect():
    from app import upstream

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.scheme == "https":
            return httpx.Response(301, headers={"location": "http://plain.example/x"})
        return httpx.Response(200, text="downgraded")

    async def go():
        async with upstream._InstrumentedClient(transport=httpx.MockTransport(handler)) as c:
            return await c.get("https://secure.example/x")

    with pytest.raises(httpx.HTTPError):
        asyncio.run(go())


def test_shared_client_still_follows_http_to_https_upgrades():
    from app import upstream

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.scheme == "http":
            return httpx.Response(301, headers={"location": "https://secure.example/x"})
        return httpx.Response(200, text="ok")

    async def go():
        async with upstream._InstrumentedClient(transport=httpx.MockTransport(handler)) as c:
            return await c.get("http://secure.example/x")

    assert asyncio.run(go()).text == "ok"


# ── V11.2.2: BYOK keys rotate with MultiFernet ──────────────────────────────


def test_byok_decrypts_under_an_old_key_after_rotation():
    from cryptography.fernet import Fernet

    from app import keys

    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    ct = keys.encrypt_value("sk-user", Settings(byok_enc_key=old))
    rotated = Settings(byok_enc_key=f"{new},{old}")
    assert keys.decrypt_value(ct, rotated) == "sk-user"
    # New writes use the first key, so dropping the old one later is safe.
    ct2 = keys.encrypt_value("sk-user", rotated)
    assert keys.decrypt_value(ct2, Settings(byok_enc_key=new)) == "sk-user"
    assert keys.decrypt_value(ct, Settings(byok_enc_key=new)) is None
    assert keys.decrypt_value(keys.rotate_value(ct, rotated), Settings(byok_enc_key=new)) == "sk-user"


# ── V13.2.1–V13.2.3: MAVLink token, dead DSN default ────────────────────────


def test_mavlink_bridge_compares_in_constant_time_and_refuses_an_armed_uplink_without_token():
    from app import mavlink_bridge as mb

    src = Path(mb.__file__).read_text()
    assert "compare_digest" in src
    with pytest.raises(RuntimeError, match="MAVLINK_BRIDGE_TOKEN"):
        mb.build_server(0, connect="udpout:127.0.0.1:14550", token="")
    mb.build_server(0, connect="", token="").server_close()  # log-only stays usable


def test_no_default_database_credentials():
    assert Settings.model_fields["database_url"].default == ""


# ── evidence storage permissions ────────────────────────────────────────────


def test_evidence_dir_and_blobs_are_private(tmp_path):
    from app.intel import evidence

    root = tmp_path / "ev"
    evidence.override_evidence_dir(str(root))
    s = Settings(evidence_dir=str(root))
    old = os.umask(0o022)
    try:
        evidence._write_blob(s, "a" * 64, b"bytes")
    finally:
        os.umask(old)
    blob = evidence.blob_path(s, "a" * 64)
    assert stat.S_IMODE(os.stat(blob).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(blob.parent).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(root).st_mode) == 0o700
