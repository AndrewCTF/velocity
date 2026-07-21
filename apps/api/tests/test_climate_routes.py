"""GET /api/climate/anomalies (worldmonitor-gaps B1d).

The route isn't wired into ``main.create_app()`` yet (owner boundary — this
task owns only ``app/routes/climate.py`` + this test file), so each test
builds a minimal FastAPI app around ``climate.router`` directly rather than
using the shared ``client`` fixture.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import upstream
from app.routes import climate


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


@pytest.fixture
def app_client() -> TestClient:
    app = FastAPI()
    app.include_router(climate.router)
    return TestClient(app)


def _era5_row(lat: float, lon: float, temps: list[float], precs: list[float]) -> dict[str, Any]:
    n = len(temps)
    return {
        "latitude": lat,
        "longitude": lon,
        "daily": {
            "time": [f"2026-01-{i + 1:02d}" for i in range(n)],
            "temperature_2m_mean": temps,
            "precipitation_sum": precs,
        },
    }


def _conflict_features(pairs: list[tuple[str, float, float, int]]) -> dict[str, Any]:
    """Build a conflict_events()-shaped payload: iso3, lat, lon, event count."""
    feats = []
    for iso3, lat, lon, count in pairs:
        for _ in range(count):
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {"kind": "conflict", "iso3": iso3},
                }
            )
    return {"type": "FeatureCollection", "features": feats}


def _patch_era5(recent: list[dict[str, Any]], baseline_per_year: list[dict[str, Any]]):
    """Fake httpx GET: first call = recent window, next 5 calls = one per
    baseline year (all identical rows unless the caller varies them)."""
    calls: list[int] = [0]
    responses = [recent] + [baseline_per_year] * climate._BASELINE_YEARS

    async def fake_get(self: object, url: str, **kwargs: object) -> httpx.Response:
        payload = responses[calls[0]]
        calls[0] += 1
        return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    return patch.object(httpx.AsyncClient, "get", new=fake_get)


# Six chronic-conflict countries with only their own centroids so we don't have
# to fabricate 25 rows of upstream data.
_STATIC = climate._STATIC_COUNTRIES


def test_anomaly_math_hand_computed(app_client: TestClient) -> None:
    countries = _STATIC[:2]
    recent = [_era5_row(c[1], c[2], [20.0, 22.0], [5.0, 5.0]) for c in countries]
    # baseline: temp mean 20.0 (recent mean is 21.0 -> anomaly +1.0), precip
    # total 8.0 per year (recent total 10.0 -> 125% of normal).
    baseline = [_era5_row(c[1], c[2], [19.0, 21.0], [4.0, 4.0]) for c in countries]

    with patch.object(
        climate, "conflict_events", new=lambda hours=72: _async_return({"unavailable": True})
    ), _patch_era5(recent, baseline):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 200
    body = r.json()
    assert body["degraded"] is True
    feats = {f["properties"]["iso3"]: f["properties"] for f in body["features"]}
    for c in countries:
        props = feats[c[0]]
        assert props["anomaly_c"] == pytest.approx(1.0)
        assert props["precip_pct_of_normal"] == pytest.approx(125.0)
        assert props["window_days"] == climate._WINDOW_DAYS
        assert props["kind"] == "climate_anomaly"


def test_feature_ids_and_geometry(app_client: TestClient) -> None:
    countries = _STATIC[:1]
    rows = [_era5_row(c[1], c[2], [10.0], [0.0]) for c in countries]

    with patch.object(
        climate, "conflict_events", new=lambda hours=72: _async_return({"unavailable": True})
    ), _patch_era5(rows, rows):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 200
    f = r.json()["features"][0]
    iso3, lat, lon = countries[0]
    assert f["id"] == f"climate_anomaly:{iso3}"
    assert f["type"] == "Feature"
    assert f["geometry"] == {"type": "Point", "coordinates": [lon, lat]}
    assert f["properties"]["iso3"] == iso3


def test_conflict_feed_down_falls_back_to_static_list(app_client: TestClient) -> None:
    countries = _STATIC
    rows = [_era5_row(c[1], c[2], [15.0], [1.0]) for c in countries]

    async def boom(hours: int = 72) -> dict[str, Any]:
        raise RuntimeError("gdelt unreachable")

    with patch.object(climate, "conflict_events", new=boom), _patch_era5(rows, rows):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 200
    body = r.json()
    assert body["degraded"] is True
    got_iso3 = {f["properties"]["iso3"] for f in body["features"]}
    assert got_iso3 == {c[0] for c in countries}


def test_too_few_conflict_countries_pads_with_static_list(app_client: TestClient) -> None:
    # Only 2 distinct conflict countries -> below _MIN_CONFLICT_COUNTRIES (5),
    # so the route should fall back to the static list rather than rank 2.
    conflict_payload = _conflict_features([("UKR", 49.0, 32.0, 9), ("SYR", 35.0, 38.0, 3)])
    rows = [_era5_row(c[1], c[2], [15.0], [1.0]) for c in _STATIC]

    with patch.object(
        climate, "conflict_events", new=lambda hours=72: _async_return(conflict_payload)
    ), _patch_era5(rows, rows):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 200
    body = r.json()
    assert body["degraded"] is True
    got_iso3 = {f["properties"]["iso3"] for f in body["features"]}
    assert got_iso3 == {c[0] for c in _STATIC}


def test_enough_conflict_countries_uses_conflict_centroids(app_client: TestClient) -> None:
    # 6 distinct conflict countries meets _MIN_CONFLICT_COUNTRIES -> ranked by
    # event count, not the static list, and centroid = mean of that country's
    # event coordinates.
    pairs = [
        ("UKR", 49.0, 32.0, 10),
        ("SYR", 35.0, 38.0, 8),
        ("YEM", 15.5, 47.5, 7),
        ("SDN", 15.0, 30.0, 6),
        ("SOM", 5.0, 46.0, 5),
        ("MLI", 17.0, -4.0, 4),
    ]
    # give UKR two distinct event coords so the centroid is the mean, not a copy
    conflict_payload = _conflict_features(pairs)
    conflict_payload["features"].append(
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [34.0, 51.0]},
            "properties": {"kind": "conflict", "iso3": "UKR"},
        }
    )
    countries = [(p[0], p[1], p[2]) for p in pairs]
    rows = [_era5_row(lat, lon, [15.0], [1.0]) for _, lat, lon in countries]

    with patch.object(
        climate, "conflict_events", new=lambda hours=72: _async_return(conflict_payload)
    ), _patch_era5(rows, rows):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 200
    body = r.json()
    assert body["degraded"] is False
    got_iso3 = {f["properties"]["iso3"] for f in body["features"]}
    assert got_iso3 == {p[0] for p in pairs}


def test_upstream_down_is_502(app_client: TestClient) -> None:
    async def bad(self: object, url: str, **_: object) -> httpx.Response:
        return httpx.Response(503, text="down", request=httpx.Request("GET", url))

    with patch.object(
        climate, "conflict_events", new=lambda hours=72: _async_return({"unavailable": True})
    ), patch.object(httpx.AsyncClient, "get", new=bad):
        r = app_client.get("/api/climate/anomalies")

    assert r.status_code == 502


async def _async_return(value: Any) -> Any:
    return value
