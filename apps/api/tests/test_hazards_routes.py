"""GET /api/hazards/* — keyless global-hazard feeds (2026-07-14 data-layers wave)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _resp(payload: Any) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://x"))


def _patch(payload: Any):
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _resp(payload)

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


def test_gdacs_normalises_to_disaster_points(client: TestClient) -> None:
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [120.5, -5.2]},
                "properties": {
                    "eventid": "1102983",
                    "eventtype": "EQ",
                    "alertlevel": "Orange",
                    "name": "Earthquake in Indonesia",
                    "country": "Indonesia",
                    "severitydata": {"severity": 6.1},
                },
            }
        ],
    }
    with _patch(payload):
        r = client.get("/api/hazards/gdacs")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    f = body["features"][0]
    assert f["id"] == "disaster:EQ1102983"
    assert f["properties"]["kind"] == "disaster"
    assert f["properties"]["event_type"] == "earthquake"
    assert f["properties"]["alert"] == "orange"


def test_fire_perimeters_explode_multipolygon(client: TestClient) -> None:
    ring = [[-120.0, 39.0], [-120.0, 39.5], [-119.5, 39.5], [-119.5, 39.0], [-120.0, 39.0]]
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "MultiPolygon", "coordinates": [[ring], [ring]]},
                "properties": {"poly_IncidentName": "Test Fire", "attr_IncidentSize": 1234.0},
            }
        ],
    }
    with _patch(payload):
        r = client.get("/api/hazards/fire-perimeters")
    assert r.status_code == 200
    feats = r.json()["features"]
    assert len(feats) == 2  # one Feature per ring
    assert feats[0]["geometry"]["type"] == "Polygon"
    assert feats[0]["properties"]["kind"] == "fireperim"
    assert feats[0]["properties"]["size_acres"] == 1234.0


def test_cyclones_use_numeric_center(client: TestClient) -> None:
    payload = {
        "activeStorms": [
            {
                "id": "al012025",
                "name": "Alpha",
                "classification": "HU",
                "latitudeNumeric": 25.4,
                "longitudeNumeric": -71.2,
                "intensity": "90",
                "pressure": "960",
            }
        ]
    }
    with _patch(payload):
        r = client.get("/api/hazards/cyclones")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["id"] == "cyclone:al012025"
    assert f["geometry"]["coordinates"] == [-71.2, 25.4]
    assert f["properties"]["intensity_kt"] == 90.0


def test_volcanoes_from_wfs(client: TestClient) -> None:
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [14.999, 40.821]},
                "properties": {
                    "Volcano_Number": "211010",
                    "Volcano_Name": "Vesuvius",
                    "Primary_Volcano_Type": "Somma",
                    "Country": "Italy",
                    "Elevation": 1281,
                },
            }
        ],
    }
    with _patch(payload):
        r = client.get("/api/hazards/volcanoes")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["id"] == "volcano:211010"
    assert f["properties"]["name"] == "Vesuvius"


def test_radiation_from_list(client: TestClient) -> None:
    payload = [
        {"id": 8812731, "latitude": 37.42, "longitude": 140.99, "value": 0.12, "unit": "usv"}
    ]
    with _patch(payload):
        r = client.get("/api/hazards/radiation")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["id"] == "radiation:8812731"
    assert f["properties"]["value"] == 0.12


def test_reliefweb_uses_country_location(client: TestClient) -> None:
    payload = {
        "data": [
            {
                "id": "12345",
                "fields": {
                    "name": "Flood - Country X",
                    "status": "current",
                    "type": [{"name": "Flood"}],
                    "country": [{"name": "Country X", "location": {"lat": 9.1, "lon": 40.5}}],
                    "date": {"created": "2026-07-01T00:00:00+00:00"},
                },
            }
        ]
    }
    with _patch(payload):
        r = client.get("/api/hazards/reliefweb")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["id"] == "relief:12345"
    assert f["properties"]["disaster_type"] == "Flood"


def test_feed_objects_resolve_at_entity(client: TestClient) -> None:
    # Linkage contract: every feed kind resolves at /api/entity (200, not 404) so
    # the object is clickable and correlatable, even with colon/hyphen raw ids.
    for eid in [
        "disaster:EQ1102983",
        "chokepoint:strait-of-hormuz",
        "sigmet:KKCI-CONV-1:0",
        "powerplant:USA0001",
        "aurora:10:60",
        "buoy:41008",
    ]:
        r = client.get(f"/api/entity/{eid}")
        assert r.status_code == 200, eid
        body = r.json()
        assert body["kind"] == eid.split(":", 1)[0]
        assert body["source"].startswith("/api/")


def test_gdacs_bad_upstream_is_502(client: TestClient) -> None:
    async def bad(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(503, text="down", request=httpx.Request("GET", "https://x"))

    with patch.object(httpx.AsyncClient, "get", new=bad):
        r = client.get("/api/hazards/gdacs")
    assert r.status_code == 502
