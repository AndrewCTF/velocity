"""GET /api/eq?lat=&lon=&radius_km= — server-side radius filter.

"Quakes near a city" was impossible without client-side filtering; the
route now filters the (still fully cached) USGS FeatureCollection to a
radius when lat/lon/radius_km are all supplied. Omitting any of the three
must leave the passthrough behavior exactly as before.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.routes.eq import filter_by_radius


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _feature(fid: str, lon: float, lat: float) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": fid,
        "geometry": {"type": "Point", "coordinates": [lon, lat, 5.0]},
        "properties": {"mag": 3.0, "place": fid},
    }


def _fake_feature_collection() -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            _feature("near", -122.42, 37.77),  # San Francisco
            _feature("far", 139.69, 35.68),  # Tokyo
        ],
    }


def _make_response(payload: dict[str, Any]) -> httpx.Response:
    req = httpx.Request("GET", "https://earthquake.usgs.gov/...")
    return httpx.Response(200, json=payload, request=req)


def test_filter_by_radius_helper_keeps_only_in_radius_features() -> None:
    fc = _fake_feature_collection()
    filtered = filter_by_radius(fc, lat=37.77, lon=-122.42, radius_km=100.0)
    ids = {f["id"] for f in filtered["features"]}
    assert ids == {"near"}, "helper must drop the out-of-radius feature"
    assert filtered["type"] == "FeatureCollection"


def test_eq_route_no_geo_params_is_unchanged_passthrough(client: TestClient) -> None:
    fc = _fake_feature_collection()

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _make_response(fc)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/eq?range=day")
    assert r.status_code == 200
    body = r.json()
    ids = {f["id"] for f in body["features"]}
    assert ids == {"near", "far"}, "no-param path must not filter anything"


def test_eq_route_with_geo_params_filters_to_radius(client: TestClient) -> None:
    fc = _fake_feature_collection()

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _make_response(fc)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get(
            "/api/eq?range=day&lat=37.77&lon=-122.42&radius_km=100"
        )
    assert r.status_code == 200
    body = r.json()
    ids = {f["id"] for f in body["features"]}
    assert ids == {"near"}, "geo-filtered route must drop the far feature"


def test_eq_route_partial_geo_params_ignored(client: TestClient) -> None:
    """Only lat set (no lon/radius_km) must not attempt a filter."""
    fc = _fake_feature_collection()

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _make_response(fc)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/eq?range=day&lat=37.77")
    assert r.status_code == 200
    body = r.json()
    ids = {f["id"] for f in body["features"]}
    assert ids == {"near", "far"}, "partial geo params must not filter"
