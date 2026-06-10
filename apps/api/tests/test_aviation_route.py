"""GET /api/aviation/states — OpenSky proxy.

We verify:
- Anonymous works when no client_id/secret is set (zero-setup default).
- bbox validation: all four bounds required if any are supplied.
- State-vector → GeoJSON normalization is correct, drops rows with null lat/lon.
- Cache dedupes within TTL.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.ingest.opensky import states_to_geojson


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()
    # also reset module-level token manager so each test is isolated
    from app.routes import aviation
    aviation._TM = None


def _opensky_payload(states: list[list[Any]]) -> dict[str, Any]:
    return {"time": 1716552000, "states": states}


def _ok(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://opensky-network.org/api/states/all"))


def test_states_anonymous_works_without_credentials(client: TestClient) -> None:
    # callsign is index 1; lon=5, lat=6
    payload = _opensky_payload(
        [
            ["a1b2c3d4", "DAL123  ", "United States", 0, 0, -73.8, 40.6, 11000.0, False, 230.0, 90.0, 0.0, None, 11200.0, "1200", False, 0, None],
        ]
    )
    captured: dict[str, Any] = {}
    async def fake_get(self: object, url: str, **kwargs: Any) -> httpx.Response:
        captured["url"] = url
        captured["headers"] = kwargs.get("headers") or {}
        return _ok(payload)
    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/aviation/states")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1
    f = body["features"][0]
    assert f["id"] == "aircraft:a1b2c3d4"
    assert f["properties"]["callsign"] == "DAL123"
    assert f["geometry"]["coordinates"][:2] == [-73.8, 40.6]
    assert "Authorization" not in captured["headers"]  # anonymous, no token


def test_states_bbox_requires_all_four(client: TestClient) -> None:
    r = client.get("/api/aviation/states?lamin=10&lomin=20")
    assert r.status_code == 400


def test_states_skips_rows_with_null_position() -> None:
    payload = _opensky_payload(
        [
            ["ok1", "OK1", "X", 0, 0, 1.0, 2.0, None, False, None, None, None, None, None, None, False, 0, None],
            ["bad", "BAD", "X", 0, 0, None, None, None, False, None, None, None, None, None, None, False, 0, None],
        ]
    )
    fc = states_to_geojson(payload)
    assert len(fc["features"]) == 1
    assert fc["features"][0]["id"] == "aircraft:ok1"


def test_states_cache_dedupes(client: TestClient) -> None:
    payload = _opensky_payload([])
    calls = {"n": 0}
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        calls["n"] += 1
        return _ok(payload)
    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        client.get("/api/aviation/states")
        client.get("/api/aviation/states")
    assert calls["n"] == 1
