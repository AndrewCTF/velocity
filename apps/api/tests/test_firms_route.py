"""GET /api/firms — FIRMS CSV → GeoJSON.

Without MAP_KEY the route must return an empty FeatureCollection (so the
frontend can render the "no key configured" empty state).
"""

from __future__ import annotations

from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.config import Settings, get_settings
from app.main import create_app


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _client_with_key(key: str) -> TestClient:
    app = create_app()
    def _settings() -> Settings:
        return Settings(firms_map_key=key, cesium_ion_token="ion")
    app.dependency_overrides[get_settings] = _settings
    return TestClient(app)


def test_firms_without_key_returns_empty(client: TestClient) -> None:
    r = client.get("/api/firms")
    assert r.status_code == 200
    body = r.json()
    assert body["features"] == []
    assert "FIRMS_MAP_KEY" in body["note"]


def test_firms_csv_to_geojson_parses_rows() -> None:
    csv_text = (
        "latitude,longitude,brightness,confidence,frp,satellite,acq_date,acq_time,daynight\n"
        "35.12,-120.34,330.5,nominal,12.3,N,2026-05-23,1830,D\n"
        "junk,row,should,be,skipped,N,2026-05-23,1830,D\n"
    )

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(200, text=csv_text, request=httpx.Request("GET", url))

    with _client_with_key("KEY") as tc, patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = tc.get("/api/firms")
    assert r.status_code == 200
    body = r.json()
    assert len(body["features"]) == 1
    f = body["features"][0]
    assert f["geometry"]["coordinates"] == [-120.34, 35.12]
    assert f["properties"]["brightness"] == 330.5
    assert f["properties"]["frp"] == 12.3


def test_firms_days_param_validation(client: TestClient) -> None:
    r = client.get("/api/firms?days=20")
    assert r.status_code == 422
