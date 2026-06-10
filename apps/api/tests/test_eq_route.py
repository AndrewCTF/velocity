"""GET /api/eq — USGS quakes proxy."""

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


def _fake_feature_collection() -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "us7000m1234",
                "geometry": {"type": "Point", "coordinates": [-120.5, 35.2, 10.0]},
                "properties": {"mag": 4.7, "place": "20km SE of Test City", "time": 1716552000000},
            }
        ],
    }


def _make_response(payload: dict[str, Any]) -> httpx.Response:
    req = httpx.Request("GET", "https://earthquake.usgs.gov/...")
    return httpx.Response(200, json=payload, request=req)


def test_eq_returns_geojson_passthrough(client: TestClient) -> None:
    fc = _fake_feature_collection()
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _make_response(fc)
    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/eq?range=day")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["features"][0]["properties"]["mag"] == 4.7


def test_eq_validates_range_param(client: TestClient) -> None:
    r = client.get("/api/eq?range=century")
    assert r.status_code == 422


def test_eq_cache_dedupes_upstream(client: TestClient) -> None:
    calls = {"n": 0}
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        calls["n"] += 1
        return _make_response(_fake_feature_collection())
    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r1 = client.get("/api/eq?range=day")
        r2 = client.get("/api/eq?range=day")
    assert r1.status_code == 200 and r2.status_code == 200
    assert calls["n"] == 1, "cache should dedupe inside its TTL"
