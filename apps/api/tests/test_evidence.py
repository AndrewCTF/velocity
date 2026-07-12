"""Guards: the evidence locker captures with a verifying hash, logs an
append-only chain of custody, survives a tamper attempt, attaches into a
Situation, and round-trips a custody manifest (roadmap P1 acceptance).

Runs keyless (no Supabase from repo root, ALLOW_UNAUTHENTICATED=1 in conftest)
and offline — the only URL-capture test injects a fake httpx client, so no
route touches the network. The evidence dir is isolated per test by the autouse
``_isolate_evidence_dir`` fixture in conftest.
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.intel import evidence as ev
from app.intel.ontology import Object, get_registry
from app.keys import UserCtx

_CTX = UserCtx("local", "")


def _s() -> Settings:
    return get_settings()


# ── content addressing + custody (module level) ───────────────────────────────


def test_capture_bytes_hashes_and_logs_custody() -> None:
    async def run() -> None:
        data = b"the quick brown fox"
        obj = await ev.capture_bytes(
            _CTX,
            data=data,
            media_type="text/plain",
            capture_method=ev.METHOD_FILE,
            filename="fox.txt",
            source_context="unit test",
        )
        sha = hashlib.sha256(data).hexdigest()
        assert obj.id == f"evidence:{sha}"
        assert obj.props["kind"] == "evidence"  # list_by_kind filters on this
        assert obj.props["sha256"] == sha
        assert obj.props["size_bytes"] == len(data)
        assert obj.props["capture_method"] == ev.METHOD_FILE
        assert obj.props["captured_by"] == "local"
        # Blob written to disk and verifies.
        assert ev.verify_blob(_s(), sha) is True
        assert ev.read_blob(_s(), sha) == data
        # One custody event: created.
        _, custody = await ev.get_evidence(_CTX, sha)
        assert len(custody) == 1
        assert custody[0]["action"] == "created"
        assert custody[0]["sha256"] == sha

    asyncio.run(run())


def test_content_addressing_dedups_and_reobserves() -> None:
    async def run() -> None:
        data = b"same bytes twice"
        a = await ev.capture_bytes(
            _CTX, data=data, media_type="text/plain", capture_method=ev.METHOD_FILE
        )
        b = await ev.capture_bytes(
            _CTX,
            data=data,
            media_type="text/plain",
            capture_method=ev.METHOD_SCREENSHOT,
            source_context="second time, different context",
        )
        assert a.id == b.id  # identical bytes → one object
        _, custody = await ev.get_evidence(_CTX, a.props["sha256"])
        actions = sorted(e["action"] for e in custody)
        assert actions == ["created", "re-observed"]

    asyncio.run(run())


def test_concurrent_identical_capture_logs_single_created() -> None:
    """Two CONCURRENT captures of identical bytes must yield exactly one
    'created' custody event — the second is 're-observed'. Without the per-hash
    capture lock both coroutines read "no existing object" across the same await
    and both log 'created', corrupting the legal timeline."""

    async def run() -> None:
        data = b"race the same bytes"
        a, b = await asyncio.gather(
            ev.capture_bytes(
                _CTX, data=data, media_type="text/plain",
                capture_method=ev.METHOD_FILE,
            ),
            ev.capture_bytes(
                _CTX, data=data, media_type="text/plain",
                capture_method=ev.METHOD_SCREENSHOT,
            ),
        )
        assert a.id == b.id
        _, custody = await ev.get_evidence(_CTX, a.props["sha256"])
        actions = sorted(e["action"] for e in custody)
        assert actions == ["created", "re-observed"]

    asyncio.run(run())


def test_tamper_is_detected() -> None:
    async def run() -> None:
        obj = await ev.capture_bytes(
            _CTX, data=b"original", media_type="text/plain",
            capture_method=ev.METHOD_FILE,
        )
        sha = obj.props["sha256"]
        assert ev.verify_blob(_s(), sha) is True
        # Overwrite the stored blob with different bytes under the same name.
        ev.blob_path(_s(), sha).write_bytes(b"tampered")
        assert ev.verify_blob(_s(), sha) is False

    asyncio.run(run())


def test_size_cap_enforced() -> None:
    async def run() -> None:
        s = Settings(evidence_max_blob_bytes=8)
        with pytest.raises(ev.EvidenceError):
            await ev.capture_bytes(
                _CTX,
                data=b"way too many bytes",
                media_type="text/plain",
                capture_method=ev.METHOD_FILE,
                settings=s,
            )

    asyncio.run(run())


def test_feed_freeze_is_canonical() -> None:
    async def run() -> None:
        snap = {"lat": 1.0, "lon": 2.0, "callsign": "TEST123"}
        a = await ev.capture_feed_freeze(_CTX, entity_id="aircraft:abc", snapshot=snap)
        # Same state, keys in a different insertion order → same hash.
        b = await ev.capture_feed_freeze(
            _CTX,
            entity_id="aircraft:abc",
            snapshot={"callsign": "TEST123", "lon": 2.0, "lat": 1.0},
        )
        assert a.id == b.id
        assert a.props["capture_method"] == ev.METHOD_FEED_FREEZE
        assert a.props["entity_id"] == "aircraft:abc"

    asyncio.run(run())


def test_attach_and_manifest_round_trip() -> None:
    async def run() -> None:
        e1 = await ev.capture_bytes(
            _CTX, data=b"exhibit A", media_type="text/plain",
            capture_method=ev.METHOD_FILE,
        )
        e2 = await ev.capture_bytes(
            _CTX, data=b"exhibit B", media_type="text/plain",
            capture_method=ev.METHOD_FILE,
        )
        reg = get_registry(_CTX)
        await reg.upsert(
            Object(id="situation:case1", props={"kind": "situation", "name": "C1"})
        )
        await ev.attach_to_situation(_CTX, e1.props["sha256"], "situation:case1")
        _, custody = await ev.get_evidence(_CTX, e1.props["sha256"])
        assert any(x["action"] == "linked" for x in custody)

        man = await ev.custody_manifest(
            _CTX, [e1.props["sha256"], e2.id, "evidence:deadbeef"]
        )
        assert man["count"] == 2  # the missing one is dropped
        assert all(item["blob_present"] for item in man["items"])
        assert all(item["blob_verified"] for item in man["items"])
        # manifest_sha256 = sha256 of sorted member hashes joined by newline.
        member = sorted(i["sha256"] for i in man["items"])
        expect = hashlib.sha256("\n".join(member).encode()).hexdigest()
        assert man["manifest_sha256"] == expect
        assert man["berkeley_protocol"]["hash_algorithm"] == "SHA-256"

    asyncio.run(run())


# ── route surface (TestClient, keyless) ──────────────────────────────────────


def test_upload_list_detail_blob_verify_routes(client: TestClient) -> None:
    files = {"file": ("note.txt", b"routed evidence", "text/plain")}
    r = client.post("/api/evidence/upload", files=files, data={"context": "rt"})
    assert r.status_code == 200, r.text
    obj = r.json()
    sha = obj["props"]["sha256"]
    assert obj["id"] == f"evidence:{sha}"

    listing = client.get("/api/evidence").json()
    assert sha in [o["props"]["sha256"] for o in listing]

    detail = client.get(f"/api/evidence/{sha}").json()
    assert detail["blob_present"] is True
    assert detail["custody"][0]["action"] == "created"

    blob = client.get(f"/api/evidence/{sha}/blob")
    assert blob.status_code == 200
    assert blob.content == b"routed evidence"
    assert blob.headers["X-Content-SHA256"] == sha

    v = client.get(f"/api/evidence/{sha}/verify").json()
    assert v == {"ok": True, "sha256": sha}


def test_upload_attach_to_situation_shows_in_detail(client: TestClient) -> None:
    sit = client.post("/api/situations", json={"name": "Case Z"}).json()
    sid = sit["id"]
    files = {"file": ("a.txt", b"linked exhibit", "text/plain")}
    r = client.post(
        "/api/evidence/upload", files=files, data={"situation_id": sid}
    )
    sha = r.json()["props"]["sha256"]
    # Evidence appears in the situation's 1-hop neighbourhood.
    detail = client.get(f"/api/situations/{sid}").json()
    assert f"evidence:{sha}" in [o["id"] for o in detail["objects"]]


def test_blob_route_409_on_tamper(client: TestClient) -> None:
    files = {"file": ("x.txt", b"honest", "text/plain")}
    sha = client.post("/api/evidence/upload", files=files).json()["props"]["sha256"]
    ev.blob_path(get_settings(), sha).write_bytes(b"forged")
    assert client.get(f"/api/evidence/{sha}/blob").status_code == 409
    assert client.get(f"/api/evidence/{sha}/verify").json()["ok"] is False


def test_manifest_route(client: TestClient) -> None:
    sha = client.post(
        "/api/evidence/upload", files={"file": ("m.txt", b"m", "text/plain")}
    ).json()["props"]["sha256"]
    man = client.post(
        "/api/evidence/manifest", json={"evidence_ids": [sha]}
    ).json()
    assert man["count"] == 1
    assert man["items"][0]["sha256"] == sha


_HTML = b"<html><body>captured</body></html>"


def test_url_capture_route_offline(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """URL capture with the network fetch stubbed at the _fetch_guarded seam."""

    async def fake_fetch(url: str, settings: object, *, max_hops: int = 5) -> ev._Fetched:
        return ev._Fetched(
            status=200,
            headers={"content-type": "text/html; charset=utf-8", "server": "nginx"},
            final_url="https://example.test/page",
            body=_HTML,
        )

    monkeypatch.setattr(ev, "_fetch_guarded", fake_fetch)

    r = client.post(
        "/api/evidence/capture/url",
        json={"url": "https://example.test/page", "context": "src"},
    )
    assert r.status_code == 200, r.text
    props = r.json()["props"]
    assert props["capture_method"] == "url"
    assert props["source_url"] == "https://example.test/page"
    assert props["http_status"] == 200
    assert props["response_headers"]["content-type"].startswith("text/html")
    assert props["sha256"] == hashlib.sha256(_HTML).hexdigest()


def test_ssrf_guard_blocks_internal_addresses() -> None:
    """capture_url must refuse loopback/link-local/private hosts (no network)."""

    async def run() -> None:
        for bad in (
            "http://127.0.0.1:8000/",
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "http://10.0.0.5/",
            "http://[::1]/",
        ):
            with pytest.raises(ev.EvidenceError):
                await ev.capture_url(_CTX, bad)
        # non-http scheme also rejected
        with pytest.raises(ev.EvidenceError):
            await ev.capture_url(_CTX, "file:///etc/passwd")

    asyncio.run(run())


def test_ip_block_classifier() -> None:
    assert ev._ip_is_blocked("127.0.0.1") is True
    assert ev._ip_is_blocked("10.1.2.3") is True
    assert ev._ip_is_blocked("169.254.1.1") is True
    assert ev._ip_is_blocked("::1") is True
    assert ev._ip_is_blocked("8.8.8.8") is False
    assert ev._ip_is_blocked("not-an-ip") is True  # unparseable → blocked
    # IPv4-mapped / 6to4 IPv6 must be unwrapped and classified by the embedded
    # v4 — otherwise cloud metadata slips through on older CPython (the pinned
    # 3.12 container) that doesn't delegate mapped addresses to the is_* flags.
    assert ev._ip_is_blocked("::ffff:169.254.169.254") is True  # link-local meta
    assert ev._ip_is_blocked("::ffff:10.0.0.1") is True  # private
    assert ev._ip_is_blocked("::ffff:127.0.0.1") is True  # loopback
    assert ev._ip_is_blocked("::ffff:8.8.8.8") is False  # public stays allowed
    assert ev._ip_is_blocked("2002:a9fe:a9fe::") is True  # 6to4 wrapping 169.254


def test_blob_route_handles_non_ascii_filename(client: TestClient) -> None:
    """A Cyrillic filename must not 500 the download (Content-Disposition)."""
    files = {"file": ("документ.txt", b"unicode name", "text/plain")}
    sha = client.post("/api/evidence/upload", files=files).json()["props"]["sha256"]
    r = client.get(f"/api/evidence/{sha}/blob")
    assert r.status_code == 200
    assert r.content == b"unicode name"
    assert "filename*=UTF-8''" in r.headers["content-disposition"]


def test_custody_survives_assertion_cap() -> None:
    """The per-object cap must never trim prop='custody' (the legal record)."""

    async def run() -> None:
        s = Settings(ontology_max_assertions_per_object=3)
        reg = get_registry(_CTX, s)
        oid = "evidence:capproof"
        # 8 custody events + 8 noisy non-custody assertions, cap=3.
        for i in range(8):
            await reg.assert_props(oid, {"custody": {"n": i}}, source=f"custody:x{i}")
            await reg.assert_props(oid, {"noise": i}, source=f"feed{i}")
        custody = await reg.get_assertions(oid, prop="custody", limit=100)
        assert len(custody) == 8  # none trimmed
        noise = await reg.get_assertions(oid, prop="noise", limit=100)
        assert len(noise) <= 3  # non-custody still capped

    asyncio.run(run())


def test_double_attach_logs_two_custody_events() -> None:
    """The nonce prevents the store dedup from collapsing genuine events."""

    async def run() -> None:
        reg = get_registry(_CTX)
        await reg.upsert(Object(id="situation:dbl", props={"kind": "situation", "name": "D"}))
        e = await ev.capture_bytes(
            _CTX, data=b"dbl", media_type="text/plain", capture_method=ev.METHOD_FILE
        )
        sha = e.props["sha256"]
        await ev.attach_to_situation(_CTX, sha, "situation:dbl")
        await ev.attach_to_situation(_CTX, sha, "situation:dbl")
        _, custody = await ev.get_evidence(_CTX, sha)
        assert sum(1 for c in custody if c["action"] == "linked") == 2

    asyncio.run(run())


def test_attach_to_missing_situation_rejected() -> None:
    async def run() -> None:
        e = await ev.capture_bytes(
            _CTX, data=b"orphan", media_type="text/plain", capture_method=ev.METHOD_FILE
        )
        with pytest.raises(ev.EvidenceError):
            await ev.attach_to_situation(_CTX, e.props["sha256"], "situation:ghost")

    asyncio.run(run())


def test_attach_route_404_on_missing_situation(client: TestClient) -> None:
    sha = client.post(
        "/api/evidence/upload", files={"file": ("a.txt", b"x", "text/plain")}
    ).json()["props"]["sha256"]
    r = client.post(
        f"/api/evidence/{sha}/attach", json={"situation_id": "situation:nope"}
    )
    assert r.status_code == 404


def test_screenshot_and_feed_freeze_routes(client: TestClient) -> None:
    import base64

    png = base64.b64encode(b"\x89PNG fake bytes").decode()
    r = client.post(
        "/api/evidence/capture/screenshot",
        json={"data_base64": png, "title": "globe shot"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["props"]["capture_method"] == "screenshot"

    r2 = client.post(
        "/api/evidence/capture/feed-freeze",
        json={"entity_id": "vessel:123", "snapshot": {"speed": 12}},
    )
    assert r2.status_code == 200, r2.text
    frozen = json.loads(ev.read_blob(get_settings(), r2.json()["props"]["sha256"]))
    assert frozen["entity_id"] == "vessel:123"
