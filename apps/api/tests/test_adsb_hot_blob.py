"""Hot-blob fast path for the world-view aircraft poll.

The frontend's dominant request — ``GET /api/adsb/global?limit=4000`` (no bbox) —
is served from a gzipped blob the background refresher builds ONCE per cycle, so
the hot route does no per-request decimate/serialize/gzip (constant latency =
uniform refresh cadence). ETag/304 lets a poll inside the same cycle return ~no
bytes. The bare full snapshot (MCP/intel back-compat) and bbox queries are
unaffected.
"""

from __future__ import annotations

import gzip
import json

import pytest
from fastapi.testclient import TestClient

from app.routes import adsb


def _fake_snapshot(n: int) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": f"aircraft:{i:06x}",
                "geometry": {"type": "Point", "coordinates": [i * 0.001, i * 0.001]},
                "properties": {"icao24": f"{i:06x}", "source": "adsb"},
            }
            for i in range(n)
        ],
    }


def test_build_hot_blob_decimates_above_cap_and_roundtrips() -> None:
    # Snapshot larger than the ceiling → decimated to exactly _WORLD_LIMIT.
    blob, etag = adsb._build_hot_blob(_fake_snapshot(adsb._WORLD_LIMIT + 500))
    decoded = json.loads(gzip.decompress(blob))
    assert len(decoded["features"]) == adsb._WORLD_LIMIT
    assert etag and isinstance(etag, str)


def test_build_hot_blob_passes_full_snapshot_below_cap() -> None:
    # A typical ~13k union sits below the 20k ceiling → ships in FULL, no thinning
    # (this is the "I want my 13k back, not 4000" guarantee).
    n = adsb._WORLD_LIMIT - 7000
    blob, _ = adsb._build_hot_blob(_fake_snapshot(n))
    decoded = json.loads(gzip.decompress(blob))
    assert len(decoded["features"]) == n


def test_world_view_served_from_prebuilt_blob(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    blob, etag = adsb._build_hot_blob(_fake_snapshot(9000))
    monkeypatch.setattr(adsb, "_HOT_BLOB", blob)
    monkeypatch.setattr(adsb, "_HOT_ETAG", etag)

    r = client.get("/api/adsb/global?limit=4000", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("etag") == etag
    # The fast path serves the pre-built blob for any no-bbox request with a limit
    # (so an old frontend asking 4000 still gets the full blob). httpx inflates the
    # gzip body; a clean round-trip proves the middleware did NOT double-encode.
    assert len(r.json()["features"]) == 9000


def test_world_view_304_on_matching_etag(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    blob, etag = adsb._build_hot_blob(_fake_snapshot(5000))
    monkeypatch.setattr(adsb, "_HOT_BLOB", blob)
    monkeypatch.setattr(adsb, "_HOT_ETAG", etag)

    r = client.get(
        "/api/adsb/global?limit=4000",
        headers={"Accept-Encoding": "gzip", "If-None-Match": etag},
    )
    assert r.status_code == 304


def test_bare_snapshot_bypasses_blob(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The blob is the DECIMATED 4000; the bare (no-param) call must still return
    # the FULL snapshot for the MCP/intel tools.
    full = _fake_snapshot(7000)

    async def fake_global_snapshot() -> dict:
        return full

    monkeypatch.setattr(adsb, "_HOT_BLOB", b"should-not-be-served")
    monkeypatch.setattr(adsb, "global_snapshot", fake_global_snapshot)

    r = client.get("/api/adsb/global")
    assert r.status_code == 200
    assert len(r.json()["features"]) == 7000


def test_ws_adsb_pushes_blob_on_connect(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    blob, _ = adsb._build_hot_blob(_fake_snapshot(3000))
    monkeypatch.setattr(adsb, "_HOT_BLOB", blob)

    async def _noop() -> None:  # don't start the real refresher (no network)
        return None

    monkeypatch.setattr(adsb, "start_snapshot", _noop)

    with client.websocket_connect("/ws/adsb") as ws:
        first = ws.receive_bytes()
    assert first == blob


def test_broadcast_drops_failing_socket() -> None:
    import asyncio

    class _DeadWS:
        async def send_bytes(self, _: bytes) -> None:
            raise RuntimeError("socket gone")

    bad = _DeadWS()
    adsb._WS_SUBSCRIBERS.add(bad)  # type: ignore[arg-type]
    try:
        asyncio.run(adsb._broadcast_blob(b"payload"))
        # A send failure must drop that socket, never raise — so one dead client
        # can't wedge the subscriber set or stall the snapshot loop.
        assert bad not in adsb._WS_SUBSCRIBERS
    finally:
        adsb._WS_SUBSCRIBERS.discard(bad)  # type: ignore[arg-type]
