"""/api/adsb/global must honour a SUPPLIED bbox in EITHER spelling.

Two caller vocabularies exist for the same viewport box:
  * ``lamin/lomin/lamax/lomax`` — OpenSky-style, what the live Cesium + MapLibre
    globe sends (``LayerCompositor.viewportQuery``). This is the route's canonical
    python var name.
  * ``min_lat/min_lon/max_lat/max_lon`` — lat/lon-spelled, what API/curl callers
    (and the MCP/intel tools) send.

If the route accepts only ONE spelling, the other arrives as four None → the
no-bbox ``world`` gate flips True → the hot-blob fast path serves the WHOLE
snapshot and the bbox is silently ignored (mobile then receives the full ~13k
blob it cannot render). The handler coalesces both spellings into lamin/...; a
scoped request in either spelling must actually be scoped (and never take the
world-view fast path).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.routes import adsb


def _snapshot_spread() -> dict:
    # Aircraft on a diagonal: lon == lat == i (deg), i in 0..89. Only those with
    # 10 <= lat,lon <= 20 sit inside the test bbox below.
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": f"aircraft:{i:06x}",
                "geometry": {"type": "Point", "coordinates": [float(i), float(i)]},
                "properties": {"icao24": f"{i:06x}", "source": "adsb"},
            }
            for i in range(90)
        ],
    }


# Both wire spellings for the box lon/lat 10..20.
_LAMIN = {"lamin": 10, "lomin": 10, "lamax": 20, "lomax": 20}
_MINLAT = {"min_lat": 10, "min_lon": 10, "max_lat": 20, "max_lon": 20}


@pytest.mark.parametrize("box", [_LAMIN, _MINLAT], ids=["lamin-globe", "min_lat-api"])
def test_supplied_bbox_scopes_response_either_spelling(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, box: dict
) -> None:
    snap = _snapshot_spread()

    async def fake_global_snapshot() -> dict:
        return snap

    # A hot blob is present (the whole 90-feature snapshot). If the bbox were
    # dropped, the world gate would serve THIS verbatim — the test would see 90.
    blob, etag = adsb._build_hot_blob(snap)
    monkeypatch.setattr(adsb, "_HOT_BLOB", blob)
    monkeypatch.setattr(adsb, "_HOT_ETAG", etag)
    monkeypatch.setattr(adsb, "global_snapshot", fake_global_snapshot)

    r = client.get("/api/adsb/global", params=box, headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    lats = [f["geometry"]["coordinates"][1] for f in r.json()["features"]]
    # Only the i in 10..20 diagonal aircraft fall inside the box (11 of 90). The
    # bbox was honoured AND the world-view hot blob was NOT served.
    assert lats, "bbox request returned nothing — bbox not wired for this spelling"
    assert len(lats) == 11, f"expected the 11 in-box aircraft, got {len(lats)}"
    assert all(10 <= v <= 20 for v in lats), "an out-of-box aircraft leaked through"
    assert r.headers.get("etag") != etag, "scoped request wrongly served the world blob"


def test_no_bbox_still_serves_world_blob(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Sanity: dual-vocabulary acceptance must not break the no-bbox world path. A
    # limit-only poll still hits the full hot blob (the world gate is True only when
    # all eight bbox params are truly absent).
    snap = _snapshot_spread()
    blob, etag = adsb._build_hot_blob(snap)
    monkeypatch.setattr(adsb, "_HOT_BLOB", blob)
    monkeypatch.setattr(adsb, "_HOT_ETAG", etag)

    r = client.get("/api/adsb/global?limit=4000", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200
    assert r.headers.get("etag") == etag
    assert len(r.json()["features"]) == 90
