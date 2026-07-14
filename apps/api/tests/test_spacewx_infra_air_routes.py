"""GET /api/weather/swpc/space, /api/infra/powerplants, /api/aviation/sigmet."""

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


def _json(payload: Any) -> httpx.Response:
    return httpx.Response(200, json=payload, request=httpx.Request("GET", "https://x"))


def _text(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, request=httpx.Request("GET", "https://x"))


def test_space_weather_aurora_flares_alerts(client: TestClient) -> None:
    flares = [{"max_class": "M1.2", "begin_time": "2026-07-14T10:00", "satellite": 16}]
    alerts = [{"product_id": "K04A", "issue_datetime": "2026-07-14T11:00", "message": "Kp=5"}]
    aurora = {
        "coordinates": [
            [200.0, 65.0, 40.0],  # kept: >= min, stride 0
            [201.0, 66.0, 5.0],   # dropped: below min
            [202.0, 67.0, 55.0],  # dropped by stride (i=2 % 3 != 0? i=2 -> kept only if i%3==0)
        ]
    }

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        if "xray-flares" in url:
            return _json(flares)
        if "alerts.json" in url:
            return _json(alerts)
        if "ovation" in url:
            return _json(aurora)
        return _json({})

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/weather/swpc/space")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert body["flares"][0]["class"] == "M1.2"
    assert body["alerts"][0]["product"] == "K04A"
    # First aurora cell kept, lon wrapped 200 -> -160.
    kept = [f for f in body["features"] if f["properties"]["kind"] == "aurora"]
    assert kept and kept[0]["geometry"]["coordinates"][0] == -160.0


def test_space_weather_survives_subfeed_failure(client: TestClient) -> None:
    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        if "ovation" in url:
            return _json({"coordinates": [[10.0, 60.0, 50.0]]})
        # flares + alerts both 500 -> caught, endpoint still returns aurora
        return httpx.Response(500, text="x", request=httpx.Request("GET", "https://x"))

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/weather/swpc/space")
    assert r.status_code == 200
    body = r.json()
    assert body["flares"] == []
    assert any(f["properties"]["kind"] == "aurora" for f in body["features"])


def test_powerplants_csv_filter(client: TestClient) -> None:
    csv_body = (
        "country,country_long,name,gppd_idnr,capacity_mw,latitude,longitude,primary_fuel\n"
        "USA,United States,Big Coal,USA0001,850.0,40.0,-90.0,Coal\n"
        "USA,United States,Tiny Solar,USA0002,12.0,41.0,-91.0,Solar\n"
        "FRA,France,Nuke One,FRA0003,1300.0,47.0,2.0,Nuclear\n"
    )

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _text(csv_body)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/infra/powerplants?min_mw=200")
    assert r.status_code == 200
    feats = r.json()["features"]
    ids = {f["id"] for f in feats}
    assert "powerplant:USA0001" in ids
    assert "powerplant:USA0002" not in ids  # filtered by min_mw
    nuke = next(f for f in feats if f["id"] == "powerplant:FRA0003")
    assert nuke["properties"]["category"] == "nuclear"


def test_sigmet_polygons(client: TestClient) -> None:
    ring = [[-100.0, 35.0], [-100.0, 37.0], [-98.0, 37.0], [-98.0, 35.0], [-100.0, 35.0]]
    payload = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "KKCI-CONV-1",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {"hazard": "CONVECTIVE", "severity": "SEV", "airSigmetType": "SIGMET"},
            }
        ],
    }

    async def fake_get(self: object, url: str, **_: object) -> httpx.Response:
        return _json(payload)

    with patch.object(httpx.AsyncClient, "get", new=fake_get):
        r = client.get("/api/aviation/sigmet")
    assert r.status_code == 200
    f = r.json()["features"][0]
    assert f["geometry"]["type"] == "Polygon"
    assert f["properties"]["kind"] == "sigmet"
    assert f["properties"]["hazard"] == "CONVECTIVE"
    assert f["id"].startswith("sigmet:KKCI-CONV-1")
