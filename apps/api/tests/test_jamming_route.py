"""Tests for /api/jamming/nacp — GPS jamming heat layer.

Verifies:
- Bucketing into 1° cells with the GPSJam.org bad-fix definition.
- Cells below the high-severity floor still surface at lower severity.
- Aircraft without integrity fields are excluded entirely.
- The route hands back GeoJSON the frontend adapter can consume directly.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import upstream
from app.routes.jamming import _aggregate_jamming, _bucket_key, _severity


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    upstream.cache._data.clear()
    upstream.cache._locks.clear()


def _f(
    lon: float, lat: float, *, nac_p: int | None = None, nic: int | None = None
) -> dict[str, Any]:
    return {
        "type": "Feature",
        "id": f"aircraft:{lon}:{lat}",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"nac_p": nac_p, "nic": nic},
    }


def test_bucket_key_uses_floor_not_truncation() -> None:
    # int() of -0.5 is 0 (truncates toward zero), floor is -1. We need floor.
    assert _bucket_key(-0.5, -0.5) == (-1, -1)
    assert _bucket_key(0.5, 0.5) == (0, 0)


def test_bucket_key_handles_antimeridian() -> None:
    # +179.9 stays in (179, …), -179.9 stays in (-180, …) — no collision.
    assert _bucket_key(179.9, 0.0) == (179, 0)
    assert _bucket_key(-179.9, 0.0) == (-180, 0)


def test_severity_thresholds() -> None:
    # Continuous score = sqrt(min(1, total / MIN_TOTAL_FOR_HIGH)) * pct/100,
    # then bucketed: high ≥ 0.5 AND total ≥ MIN_TOTAL_FOR_HIGH, medium ≥ 0.3,
    # else low. The hard population gate keeps lone-fix outliers from
    # escalating to 'high'.
    assert _severity(3, 60.0) == "high"      # 1.0 * 0.6 = 0.60, total≥3
    assert _severity(2, 100.0) == "medium"   # score 0.82 but total < min
    assert _severity(10, 35.0) == "medium"   # 1.0 * 0.35 = 0.35
    assert _severity(10, 5.0) == "low"       # 1.0 * 0.05 = 0.05
    assert _severity(10, 0.0) == "none"      # pct = 0 → none


def test_aggregate_emits_high_severity_for_all_bad_cluster() -> None:
    feats = [
        _f(56.1, 26.2, nac_p=0, nic=0),
        _f(56.5, 26.5, nac_p=4, nic=2),
        _f(56.9, 26.9, nac_p=6, nic=5),
    ]
    fc = _aggregate_jamming(feats)
    assert fc["type"] == "FeatureCollection"
    assert len(fc["features"]) == 1
    f = fc["features"][0]
    assert f["properties"]["severity"] == "high"
    assert f["properties"]["total"] == 3
    assert f["properties"]["bad"] == 3
    assert f["properties"]["percent_bad"] == 100.0
    # Geometry is now a Polygon hexagon centred on (56.5, 26.5).
    assert f["geometry"]["type"] == "Polygon"
    ring = f["geometry"]["coordinates"][0]
    # 7 points (6 vertices + closing repeat).
    assert len(ring) == 7
    assert ring[0] == ring[-1], "ring must be closed"
    # Centre of the bounding box of the hexagon should be ~(56.5, 26.5).
    lons = [p[0] for p in ring[:-1]]
    lats = [p[1] for p in ring[:-1]]
    assert abs(sum(lons) / 6 - 56.5) < 1e-9
    assert abs(sum(lats) / 6 - 26.5) < 1e-9


def test_aggregate_skips_aircraft_without_integrity() -> None:
    feats = [
        _f(0.5, 0.5, nac_p=None, nic=None),  # excluded entirely
        _f(0.6, 0.6, nac_p=0, nic=0),
    ]
    fc = _aggregate_jamming(feats)
    # Only one aircraft with integrity (total=1, pct=100%). Continuous score
    # = sqrt(1/3) * 1.0 ≈ 0.577, but the population gate blocks 'high' below
    # MIN_TOTAL_FOR_HIGH=3 — so it falls to 'medium'.
    assert len(fc["features"]) == 1
    assert fc["features"][0]["properties"]["total"] == 1
    assert fc["features"][0]["properties"]["severity"] == "medium"


def test_aggregate_omits_clean_cells() -> None:
    # All aircraft above thresholds → percent_bad = 0 → severity 'none' → dropped.
    feats = [
        _f(10.5, 10.5, nac_p=10, nic=8),
        _f(10.6, 10.6, nac_p=11, nic=9),
        _f(10.7, 10.7, nac_p=10, nic=8),
    ]
    fc = _aggregate_jamming(feats)
    assert fc["features"] == []


def test_route_returns_aggregated_cells(client: TestClient) -> None:
    # Mock the snapshot by patching global_snapshot (the seam jamming reads).
    async def fake_global() -> dict[str, Any]:
        return {
            "type": "FeatureCollection",
            "features": [
                _f(56.1, 26.2, nac_p=0, nic=0),
                _f(56.5, 26.5, nac_p=4, nic=2),
                _f(56.9, 26.9, nac_p=6, nic=5),
            ],
        }

    from app.routes import adsb as adsb_routes
    with patch.object(adsb_routes, "global_snapshot", new=fake_global):
        r = client.get("/api/jamming/nacp")
    assert r.status_code == 200
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 1
    assert body["features"][0]["properties"]["severity"] == "high"
