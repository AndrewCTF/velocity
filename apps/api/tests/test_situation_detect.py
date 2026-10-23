"""Detected situation: densest anchored cluster in a box + sanctions join."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.intel import anchorage
from app.intel import sanctions as sx
from app.routes import situations as sit_route


def _f(i: int, lon: float, lat: float, **props: object) -> dict:
    return {
        "type": "Feature",
        "id": f"vessel:{i}",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"mmsi": i, "name": f"V{i}", **props},
    }


# Five hulls within ~3 km off Fujairah, two isolated ones, one outside the box.
FEATS = [_f(100 + k, 56.40 + 0.01 * k, 25.15) for k in range(5)] + [
    _f(200, 55.0, 25.0),
    _f(201, 57.5, 26.5),
    _f(300, 10.0, 10.0),
]


def test_densest_cluster_picks_the_anchorage() -> None:
    hit = anchorage.densest_cluster(FEATS, (54.0, 24.0, 58.0, 27.0), r_km=10)
    assert hit is not None and hit["n"] == 5
    assert {f["properties"]["mmsi"] for f in hit["members"]} == set(range(100, 105))
    assert hit["lon"] == pytest.approx(56.42) and hit["lat"] == pytest.approx(25.15)


def test_densest_cluster_empty_box() -> None:
    assert anchorage.densest_cluster(FEATS, (0.0, 0.0, 1.0, 1.0)) is None


def test_detect_route_joins_sanctions_on_identifier(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sit_route, "vessel_snapshot", lambda parked_only=False: {"features": FEATS})
    idx = sx.SanctionsIndex(fetched_at=0.0, rows=1, lists=["OFAC SDN"], failed={"UK": "HTTP 503"})
    idx.by_mmsi[102] = [
        sx.Designation(ent_num=1, name="X", sdn_type="vessel", programs=(), mmsi=102)
    ]

    async def _idx() -> sx.SanctionsIndex:
        return idx

    monkeypatch.setattr(sx, "get_index", _idx)
    r = client.get("/api/situations/detect", params={"bbox": "54,24,58,27"})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] and j["n"] == 5 and j["sanctioned"] == 1
    assert [m["mmsi"] for m in j["members"] if m["sanctioned"]] == [102]
    assert j["sanctions_failed"] == ["UK"]


def test_detect_route_rejects_bad_bbox(client: TestClient) -> None:
    assert client.get("/api/situations/detect", params={"bbox": "a,b"}).status_code == 400
    assert client.get("/api/situations/detect", params={"bbox": "58,24,54,27"}).status_code == 400
