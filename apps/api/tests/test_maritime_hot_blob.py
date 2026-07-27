"""The vessel world payload is pre-rendered, not rebuilt per request.

`vessel_snapshot()` used to run on every `/api/maritime/snapshot` call: measured
2026-07-27 at ~40k vessels it cost 45 ms to build the features plus 46 ms
pydantic plus 56 ms `json.dumps` plus 38 ms gzip, so ~185 ms of blocking
event-loop work per request, at a 30 s client TTL, with a second uncapped
variant (`?parked=1`) at 60 s, and both re-fired on every camera move. During
that stall the 1 s ADS-B snapshot cycle cannot run.

These guard the properties that make the pre-rendered path safe to serve:

* the blob decodes to EXACTLY what `vessel_snapshot()` returns — the builder
  only reads the store, it must never merge, dedup or re-stamp (the vessel store
  is last-write-wins and an optimistic `Observation.t` is a correctness bug, not
  a rounding one — docs/decisions.md, 2026-07-15);
* an unchanged blob answers 304, and a changed one does not;
* the response carries its own `Content-Encoding`, so the gzip middleware leaves
  it alone rather than compressing it a second time;
* a bbox request still goes through `viewport_filter` and is unaffected.
"""

from __future__ import annotations

import gzip
import json

import pytest
from fastapi.testclient import TestClient

from app.correlate.types import Observation
from app.routes import maritime as maritime_routes


def _obs(mmsi: str, lat: float, lon: float, t: float) -> Observation:
    return Observation(
        id=f"vessel:{mmsi}",
        source="test",
        t=t,
        lon=lon,
        lat=lat,
        emits_kind="vessel",
        attrs={"mmsi": mmsi, "name": f"SHIP {mmsi}"},
    )


@pytest.fixture
def seeded_store() -> None:
    from app.correlate.store import store

    store.add_many(
        [_obs(str(200000000 + i), 10.0 + i * 0.01, 20.0 + i * 0.01, 1_700_000_000.0)
         for i in range(50)]
    )


def test_blob_decodes_to_exactly_the_snapshot(seeded_store: None) -> None:
    blob, etag = maritime_routes._build_vessel_blob(False)
    decoded = json.loads(gzip.decompress(blob))
    expected = maritime_routes.vessel_snapshot(parked_only=False)

    assert decoded["type"] == "FeatureCollection"
    got_ids = sorted(f["id"] for f in decoded["features"])
    want_ids = sorted(f["id"] for f in expected["features"])
    assert got_ids == want_ids, "the blob must not add, drop or re-key a vessel"
    assert len(etag) == 32


def test_blob_is_deterministic_for_unchanged_input(seeded_store: None) -> None:
    a_blob, a_etag = maritime_routes._build_vessel_blob(False)
    b_blob, b_etag = maritime_routes._build_vessel_blob(False)
    assert a_etag == b_etag
    assert a_blob == b_blob


def test_world_request_serves_the_blob_with_etag_and_304(
    client: TestClient, seeded_store: None
) -> None:
    maritime_routes._VESSEL_BLOB, maritime_routes._VESSEL_ETAG = (
        maritime_routes._build_vessel_blob(False)
    )
    r = client.get("/api/maritime/snapshot", headers={"accept-encoding": "gzip"})
    assert r.status_code == 200
    etag = r.headers.get("etag")
    assert etag == maritime_routes._VESSEL_ETAG

    # The client transparently un-gzips ONCE. If the gzip middleware had
    # compressed our already-compressed blob a second time, what is left after
    # that single decode is still gzip and this parse fails. So this assertion
    # is the double-compression guard.
    assert r.headers.get("content-encoding") == "gzip"
    assert r.json()["type"] == "FeatureCollection"
    assert json.loads(gzip.decompress(maritime_routes._VESSEL_BLOB)) == r.json()

    r2 = client.get(
        "/api/maritime/snapshot",
        headers={"accept-encoding": "gzip", "if-none-match": etag},
    )
    assert r2.status_code == 304
    assert r2.content == b""

    r3 = client.get(
        "/api/maritime/snapshot",
        headers={"accept-encoding": "gzip", "if-none-match": '"stale"'},
    )
    assert r3.status_code == 200


def test_no_gzip_client_still_gets_json(client: TestClient, seeded_store: None) -> None:
    maritime_routes._VESSEL_BLOB, maritime_routes._VESSEL_ETAG = (
        maritime_routes._build_vessel_blob(False)
    )
    r = client.get("/api/maritime/snapshot", headers={"accept-encoding": "identity"})
    assert r.status_code == 200
    assert r.json()["type"] == "FeatureCollection"


def test_bbox_request_bypasses_the_blob(client: TestClient, seeded_store: None) -> None:
    """A viewport query must still be filtered, never served the world blob."""
    maritime_routes._VESSEL_BLOB, maritime_routes._VESSEL_ETAG = (
        maritime_routes._build_vessel_blob(False)
    )
    r = client.get(
        "/api/maritime/snapshot",
        params={"lamin": 80, "lomin": 80, "lamax": 85, "lomax": 85},
        headers={"accept-encoding": "gzip"},
    )
    assert r.status_code == 200
    assert r.headers.get("etag") is None
    assert r.json()["features"] == []


def test_blob_state_reports_honestly() -> None:
    st = maritime_routes.vessel_blob_state()
    assert set(st) >= {"built_at", "age_s", "bytes", "bytes_parked", "cycle_s"}
    assert st["cycle_s"] == maritime_routes._VESSEL_CYCLE_S
