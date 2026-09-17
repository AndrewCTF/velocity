"""Tests for app.intel.project — projected position cone + chokepoint ETA.

The pure analytic (``project``) is exercised directly on synthetic fixes, the
same posture as test_pol.py: no network, no DB, deterministic geometry. A
small hand-rolled ray-cast point-in-polygon (shapely is not a dependency of
this repo) verifies the cone actually contains the extrapolated point, the
same technique scripts/backtest_projection.py uses to score real tracks.

The route test (``GET /api/history/project``) seeds app.history's tmp SQLite
positions DB the way test_history_track_by_id.py does and drives it through
the FastAPI TestClient.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

import app.history as H
from app.intel import project
from app.intel.geo import NM_TO_KM

# ── helpers ───────────────────────────────────────────────────────────────

def _point_in_polygon(lon: float, lat: float, polygon: dict) -> bool:
    """Standard ray-cast point-in-polygon over a GeoJSON Polygon's exterior
    ring. Treats lon/lat as planar, which is fine for the few-nm cones these
    tests build."""
    ring = polygon["coordinates"][0]
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_at = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_at:
                inside = not inside
        j = i
    return inside


def _straight_track(
    lon0: float, lat0: float, bearing_deg: float, speed_kn: float, n: int, step_s: float = 60.0
) -> list[tuple[float, float, float]]:
    """``n`` fixes, ``step_s`` apart, moving at a constant bearing/speed from
    (lon0, lat0). Built with project._destination so the geometry is exact;
    ``project()`` measures it back out with the independent haversine/bearing
    inverse, so mean_kn/mean_hdg coming back close to the inputs is a real
    check, not a tautology."""
    dist_km_per_step = speed_kn * NM_TO_KM * (step_s / 3600.0)
    out: list[tuple[float, float, float]] = []
    lon, lat = lon0, lat0
    t0 = 1_700_000_000.0
    for i in range(n):
        out.append((lon, lat, t0 + i * step_s))
        lon, lat = project._destination(lon, lat, bearing_deg, dist_km_per_step)
    return out


def _chokepoint_ahead_of(
    origin_lon: float, origin_lat: float, bearing_deg: float, dist_nm: float, name: str = "Test Strait"
) -> tuple[str, float, float, float, float, float, float]:
    clon, clat = project._destination(origin_lon, origin_lat, bearing_deg, dist_nm * NM_TO_KM)
    return (name, 0.0, 0.0, 0.0, 0.0, clon, clat)


# ── project() on synthetic tracks ────────────────────────────────────────

class TestProjectStraightTrack:
    def test_status_ok_with_mean_heading_and_speed_recovered(self) -> None:
        pts = _straight_track(0.0, 0.0, 90.0, 10.0, 20)
        result = project.project(pts, horizon_s=3600, chokepoints=[])
        assert result["status"] == "ok"
        assert result["mean_hdg"] == pytest.approx(90.0, abs=0.5)
        assert result["mean_kn"] == pytest.approx(10.0, abs=0.2)

    def test_extrapolated_point_lies_inside_the_cone(self) -> None:
        pts = _straight_track(0.0, 0.0, 90.0, 10.0, 20)
        horizon_s = 3600.0
        result = project.project(pts, horizon_s=horizon_s, chokepoints=[])
        assert result["status"] == "ok"
        origin_lon, origin_lat, _t = result["origin"]
        dist_km = result["mean_kn"] * NM_TO_KM * (horizon_s / 3600.0)
        ext_lon, ext_lat = project._destination(origin_lon, origin_lat, result["mean_hdg"], dist_km)
        assert _point_in_polygon(ext_lon, ext_lat, result["cone"])

    def test_chokepoint_on_bearing_ahead_has_positive_eta_and_in_cone(self) -> None:
        pts = _straight_track(0.0, 0.0, 90.0, 10.0, 20)
        result_probe = project.project(pts, horizon_s=3600, chokepoints=[])
        origin_lon, origin_lat, _t = result_probe["origin"]
        # Placed at the mean projected distance for this horizon — inside
        # [r_min, r_max] by construction (see intel/project.py's cone maths).
        ahead = _chokepoint_ahead_of(origin_lon, origin_lat, 90.0, dist_nm=10.0, name="Ahead Strait")
        result = project.project(pts, horizon_s=3600, chokepoints=[ahead])
        assert len(result["eta"]) == 1
        entry = result["eta"][0]
        assert entry["name"] == "Ahead Strait"
        assert entry["eta_s"] > 0
        assert entry["in_cone"] is True

    def test_chokepoint_behind_is_absent(self) -> None:
        pts = _straight_track(0.0, 0.0, 90.0, 10.0, 20)
        result_probe = project.project(pts, horizon_s=3600, chokepoints=[])
        origin_lon, origin_lat, _t = result_probe["origin"]
        behind = _chokepoint_ahead_of(origin_lon, origin_lat, 270.0, dist_nm=10.0, name="Behind Strait")
        result = project.project(pts, horizon_s=3600, chokepoints=[behind])
        assert result["eta"] == []

    def test_eta_list_sorted_by_eta(self) -> None:
        pts = _straight_track(0.0, 0.0, 90.0, 10.0, 20)
        result_probe = project.project(pts, horizon_s=7200, chokepoints=[])
        origin_lon, origin_lat, _t = result_probe["origin"]
        far = _chokepoint_ahead_of(origin_lon, origin_lat, 90.0, dist_nm=18.0, name="Far")
        near = _chokepoint_ahead_of(origin_lon, origin_lat, 90.0, dist_nm=6.0, name="Near")
        result = project.project(pts, horizon_s=7200, chokepoints=[far, near])
        names = [e["name"] for e in result["eta"]]
        assert names == ["Near", "Far"]


class TestProjectInsufficient:
    def test_two_fixes_is_insufficient(self) -> None:
        pts = [(0.0, 0.0, 1_700_000_000.0), (0.1, 0.0, 1_700_000_060.0)]
        result = project.project(pts, horizon_s=3600)
        assert result["status"] == "insufficient"
        assert "2 fix" in result["reason"] or "need" in result["reason"]

    def test_short_span_is_insufficient(self) -> None:
        # 3 fixes, all within a 10s span — below the 120s floor.
        pts = [(0.0, 0.0, 1_700_000_000.0), (0.001, 0.0, 1_700_000_005.0), (0.002, 0.0, 1_700_000_010.0)]
        result = project.project(pts, horizon_s=3600)
        assert result["status"] == "insufficient"
        assert "span" in result["reason"]

    def test_no_segment_survives_gating_is_insufficient(self) -> None:
        # 6 fixes spanning >120s overall (5 gaps of 25s = 125s), but every
        # CONSECUTIVE gap is under the 30s segment floor — no real segment to
        # measure speed/heading from, so this must report insufficient rather
        # than crash or guess.
        pts = [(0.0001 * i, 0.0, 1_700_000_000.0 + i * 25.0) for i in range(6)]
        result = project.project(pts, horizon_s=3600)
        assert result["status"] == "insufficient"
        assert "gate" in result["reason"] or "noisy" in result["reason"]


class TestProjectStationary:
    def test_stationary_track_is_ok_with_a_small_cone_no_division_by_zero(self) -> None:
        pts = [(5.0, 30.0, 1_700_000_000.0 + i * 60.0) for i in range(10)]
        result = project.project(pts, horizon_s=3600, chokepoints=[])
        assert result["status"] == "ok"
        assert result["mean_kn"] == 0.0
        assert result["sd_kn"] == 0.0
        assert result["eta"] == []
        # A real, non-degenerate polygon: at least 3 distinct coordinates.
        ring = result["cone"]["coordinates"][0]
        assert len(ring) >= 3
        assert result["params"]["r_max_nm"] == pytest.approx(0.5, abs=1e-6)


# ── route ─────────────────────────────────────────────────────────────────

def _reset_module(tmp_db: str) -> None:
    H._buffer.clear()
    H._last.clear()
    H._rows_written = 0
    H._flush_task = None
    H._coverage_cache = None
    H.override_db_path(tmp_db)


def test_route_returns_cone_for_a_seeded_track(client: TestClient, tmp_path: pytest.TempPathFactory) -> None:
    db = str(tmp_path / "project_route.db")
    _reset_module(db)
    try:
        now = time.time()
        target = "vessel:244770688"
        rows = [
            ("vessel", target, now - 20 * 60 + i * 60, 10.0 + i * 0.01, 50.0, 90.0, "{}")
            for i in range(20)
        ]
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(loop.run_in_executor(None, H._flush_sync, rows))
        finally:
            loop.close()

        r = client.get("/api/history/project", params={"id": target, "horizon_s": 3600})
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert "cone" in body
        assert body["cone"]["type"] == "Polygon"
    finally:
        H.override_db_path(None)


def test_route_404_for_unknown_id(client: TestClient, tmp_path: pytest.TempPathFactory) -> None:
    db = str(tmp_path / "project_route_empty.db")
    _reset_module(db)
    try:
        r = client.get("/api/history/project", params={"id": "vessel:000000001"})
        assert r.status_code == 404
    finally:
        H.override_db_path(None)


def test_route_422_for_horizon_below_minimum(client: TestClient) -> None:
    r = client.get("/api/history/project", params={"id": "vessel:000000001", "horizon_s": 10})
    assert r.status_code == 422
