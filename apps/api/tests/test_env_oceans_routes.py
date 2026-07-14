"""GET /api/env/* and /api/maritime/{buoys,chokepoints} (2026-07-14 data-layers wave)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.routes import oceans


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _json(payload: Any) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://x"))


def _text(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, request=httpx.Request("GET", "https://x"))


def test_air_quality_batched_cities(client: TestClient) -> None:
    # Open-Meteo returns one object per requested coord; return a short list — the
    # route zips against its city table so extra cities are simply dropped.
    payload = [
        {"current": {"time": "2026-07-14T12:00", "us_aqi": 168, "pm2_5": 88.1, "pm10": 120.0}},
        {"current": {"time": "2026-07-14T12:00", "us_aqi": 155, "pm2_5": 65.0, "pm10": 90.0}},
    ]

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _json(payload)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/env/air-quality")
    assert r.status_code == 200
    feats = r.json()["features"]
    assert feats[0]["id"] == "airquality:delhi"
    assert feats[0]["properties"]["us_aqi"] == 168
    assert feats[0]["properties"]["kind"] == "airquality"


def test_buoys_parse_text_table(client: TestClient) -> None:
    body = (
        "#STN  LAT     LON      YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE\n"
        "#text units...\n"
        "41008 31.400 -80.870 2026 07 14 12 00 180 5.0 7.0 1.5 8.0 6.0 MM 1015.0 MM 27.0 28.0 MM MM MM\n"
    )

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _text(body)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/maritime/buoys")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["id"] == "buoy:41008"
    assert f["geometry"]["coordinates"] == [-80.87, 31.4]
    assert f["properties"]["wave_height_m"] == 1.5
    assert f["properties"]["water_temp_c"] == 28.0


def test_chokepoints_count_vessels_in_bbox(client: TestClient) -> None:
    fake_snapshot = {
        "type": "FeatureCollection",
        "features": [
            # inside Strait of Hormuz bbox, moving
            {"geometry": {"type": "Point", "coordinates": [56.3, 26.6]}, "properties": {"sog": 12}},
            # inside Hormuz, stationary
            {"geometry": {"type": "Point", "coordinates": [56.4, 26.5]}, "properties": {"sog": 0.2}},
            # mid-Atlantic, in nothing
            {"geometry": {"type": "Point", "coordinates": [-30.0, 20.0]}, "properties": {"sog": 10}},
        ],
    }
    with patch.object(oceans, "vessel_snapshot", return_value=fake_snapshot):
        r = client.get("/api/maritime/chokepoints")
    assert r.status_code == 200
    feats = {f["properties"]["name"]: f["properties"] for f in r.json()["features"]}
    hormuz = feats["Strait of Hormuz"]
    assert hormuz["vessels"] == 2
    assert hormuz["stationary"] == 1
    assert feats["Panama Canal"]["vessels"] == 0
