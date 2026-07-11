"""Guards for the infrastructure/military facility layer (bbox routes +
category filter + ID CONTRACT)."""

from __future__ import annotations

import pytest

from app import places

ROWS = [
    {"id": "WRI0001", "category": "power", "subcategory": "nuclear power station", "fuel": "Nuclear",
     "nuclear": True, "name": "Test NPP", "lat": 50.0, "lon": 10.0, "capacity_mw": 1200.0,
     "source": "wri-gppd-v1.3"},
    {"id": "WRI0002", "category": "power", "subcategory": "wind turbine farm", "fuel": "Wind",
     "nuclear": False, "name": "Test Wind Farm", "lat": 51.0, "lon": 11.0, "capacity_mw": 80.0,
     "source": "wri-gppd-v1.3"},
    {"id": "satnogs-1", "category": "ground_station", "subcategory": "satellite ground station (SatNOGS)",
     "name": "GS-1", "lat": 52.0, "lon": 12.0, "source": "satnogs-network"},
    {"id": "bad-row", "category": "power", "name": "No coords", "lat": None, "lon": None},
]
MIL_ROWS = [
    {"id": "mirta-1", "category": "military_installation", "name": "Fort Test", "lat": 35.0, "lon": -79.0,
     "component": "USA", "operational_status": "act", "source": "esri-federal-mirta"},
    {"id": "wd-Q1", "category": "garrison", "name": "Test Garrison", "lat": 36.0, "lon": -78.0,
     "source": "wikidata"},
]


@pytest.fixture(autouse=True)
def _fake_data(monkeypatch):
    monkeypatch.setattr(places, "infrastructure", lambda: ROWS)
    monkeypatch.setattr(places, "military", lambda: MIL_ROWS)
    places._facility_index.cache_clear()
    yield
    places._facility_index.cache_clear()


def test_bbox_and_id_contract():
    fc = places.facility_bbox_features("infrastructure", 0, 40, 20, 60, limit=100)
    ids = {f["id"] for f in fc["features"]}
    assert ids == {"facility:WRI0001", "facility:WRI0002", "facility:satnogs-1"}
    for f in fc["features"]:
        assert f["properties"]["kind"] == "facility"
        assert f["properties"]["category"]


def test_category_filter_and_nuclear_pseudo_category():
    fc = places.facility_bbox_features("infrastructure", 0, 40, 20, 60, limit=100, category="power")
    assert {f["id"] for f in fc["features"]} == {"facility:WRI0001", "facility:WRI0002"}
    fc_n = places.facility_bbox_features("infrastructure", 0, 40, 20, 60, limit=100, category="nuclear")
    assert {f["id"] for f in fc_n["features"]} == {"facility:WRI0001"}
    fc_g = places.facility_bbox_features("infrastructure", 0, 40, 20, 60, limit=100, category="ground_station")
    assert {f["id"] for f in fc_g["features"]} == {"facility:satnogs-1"}


def test_military_dataset_prefix():
    fc = places.facility_bbox_features("military", -90, 30, -70, 40, limit=100)
    assert {f["id"] for f in fc["features"]} == {"military:mirta-1", "military:wd-Q1"}
    fc_g = places.facility_bbox_features("military", -90, 30, -70, 40, limit=100, category="garrison")
    assert [f["id"] for f in fc_g["features"]] == ["military:wd-Q1"]


def test_routes_and_entity(client):
    r = client.get("/api/places/infrastructure", params={"bbox": "0,40,20,60", "category": "nuclear"})
    assert r.status_code == 200
    assert [f["id"] for f in r.json()["features"]] == ["facility:WRI0001"]
    # malformed bbox degrades to empty FC
    r2 = client.get("/api/places/infrastructure", params={"bbox": "nope"})
    assert r2.status_code == 200 and r2.json()["features"] == []
    r3 = client.get("/api/places/military", params={"bbox": "-90,30,-70,40"})
    assert r3.status_code == 200 and len(r3.json()["features"]) == 2
    # facility detail + entity enrichment
    r4 = client.get("/api/places/facility/WRI0001")
    assert r4.status_code == 200 and r4.json()["name"] == "Test NPP"
    r5 = client.get("/api/entity/facility:WRI0001")
    assert r5.status_code == 200
    body = r5.json()
    assert body["kind"] == "facility" and body["capacity_mw"] == 1200.0
    r6 = client.get("/api/entity/military:mirta-1")
    assert r6.status_code == 200 and r6.json()["component"] == "USA"
