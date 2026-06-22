"""Tests for app.intel.pol — per-entity pattern-of-life analytics.

No network. The geometry/clustering analytic (``analyze_track``) is pure and is
exercised directly on hand-built synthetic tracks; the DB-backed entry point
(``pattern_of_life``) is exercised against a tmp SQLite positions DB seeded via
``history.override_db_path`` (the same pattern test_dossier.py / test_history.py
use). Covers:

* a CLUSTERED track (an entity that dwells at two recurring places, transiting
  between) → DBSCAN finds the places, dwell stats, an on-pattern score;
* a SCATTERED track (every fix far apart, never dwelling) → no recurring place,
  high off-pattern share;
* a baseline-then-excursion track → on-pattern history + a final break flagged;
* the honest short-track path (< _MIN_FIXES) → sufficient:false, no fabrication;
* determinism of the DBSCAN labelling;
* the DB-backed loader returning a real baseline / degrading when disabled.
"""

from __future__ import annotations

import math
import time

import numpy as np
import pytest

import app.history as H
from app.intel import pol

# ── fixtures / helpers ────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _isolate(tmp_path):
    """Restore history globals after each test so the rest of the suite isn't
    pointed at a vanished tmp DB."""
    yield
    H._buffer.clear()
    H._last.clear()
    H.override_db_path(None)


def _dwell_fixes(
    lon: float, lat: float, t0: float, n: int, step_s: float = 60.0, jitter_deg: float = 0.0008
) -> list[tuple[float, float, float]]:
    """`n` fixes loitering at (lon,lat) with small jitter (≈ <100 m) — a dwell.

    Jitter is deterministic (a fixed sinusoid, not RNG) so the test is stable.
    """
    out: list[tuple[float, float, float]] = []
    for i in range(n):
        dlon = jitter_deg * math.sin(i * 1.3)
        dlat = jitter_deg * math.cos(i * 0.7)
        out.append((t0 + i * step_s, lon + dlon, lat + dlat))
    return out


def _leg(
    lon_a: float, lat_a: float, lon_b: float, lat_b: float, t0: float, n: int, step_s: float = 60.0
) -> list[tuple[float, float, float]]:
    """`n` fixes evenly interpolated from A to B — a transit leg (no dwell)."""
    out: list[tuple[float, float, float]] = []
    for i in range(n):
        f = i / max(1, n - 1)
        out.append((t0 + i * step_s, lon_a + (lon_b - lon_a) * f, lat_a + (lat_b - lat_a) * f))
    return out


# ── DBSCAN core ───────────────────────────────────────────────────────────────

def test_dbscan_separates_two_dense_blobs_from_noise() -> None:
    """Two tight metre-space blobs + a couple of stragglers → 2 clusters + noise."""
    rng_pts = []
    # Blob A around origin, blob B 5 km east — both well inside eps of themselves,
    # far outside eps of each other.
    for i in range(8):
        rng_pts.append((10.0 * math.sin(i), 10.0 * math.cos(i)))          # A: ~10 m spread
    for i in range(8):
        rng_pts.append((5000.0 + 10.0 * math.sin(i), 10.0 * math.cos(i)))  # B
    rng_pts.append((100_000.0, 100_000.0))  # lone straggler → noise
    pts = np.array(rng_pts, dtype=np.float64)

    labels = pol._dbscan(pts, eps_m=pol._EPS_M, min_samples=pol._MIN_SAMPLES)

    n_clusters = len({int(x) for x in labels if x >= 0})
    assert n_clusters == 2, "two dense blobs must form two clusters"
    assert labels[-1] == -1, "the lone straggler must be noise"


def test_dbscan_is_deterministic() -> None:
    pts = np.array([(10.0 * math.sin(i), 10.0 * math.cos(i)) for i in range(12)], dtype=np.float64)
    a = pol._dbscan(pts, eps_m=pol._EPS_M, min_samples=pol._MIN_SAMPLES)
    b = pol._dbscan(pts, eps_m=pol._EPS_M, min_samples=pol._MIN_SAMPLES)
    assert np.array_equal(a, b)


def test_dbscan_empty() -> None:
    labels = pol._dbscan(np.empty((0, 2)), eps_m=pol._EPS_M, min_samples=pol._MIN_SAMPLES)
    assert labels.shape == (0,)


# ── clustered track → recurring places + dwell ─────────────────────────────────

def test_clustered_track_finds_two_recurring_places() -> None:
    """An entity that dwells at base, transits to a patrol point, dwells, and
    returns → two recurring places, real dwell, an on-pattern (low) score."""
    now = time.time()
    t = now - 3 * 3600
    base = (12.50, 41.90)   # "home"
    spot = (12.80, 42.10)   # "patrol point" ~30 km away
    track: list[tuple[float, float, float]] = []
    # dwell at base, transit out, dwell at spot, transit back, dwell at base again
    track += _dwell_fixes(*base, t, 12)
    t = track[-1][0] + 60
    track += _leg(base[0], base[1], spot[0], spot[1], t, 8)
    t = track[-1][0] + 60
    track += _dwell_fixes(*spot, t, 12)
    t = track[-1][0] + 60
    track += _leg(spot[0], spot[1], base[0], base[1], t, 8)
    t = track[-1][0] + 60
    track += _dwell_fixes(*base, t, 10)

    res = pol.analyze_track("aircraft:patrol1", track)

    assert res["found"] is True and res["sufficient"] is True
    assert res["place_count"] == 2, "two distinct dwell locations must cluster"
    # Each recurring place carries a centroid, visits, dwell, and a spread.
    places = res["recurring_places"]
    assert all(p["dwell_minutes"] > 0 for p in places)
    assert all(p["radius_km"] < 1.0 for p in places), "dwell jitter is sub-km"
    # The base is visited twice (left and came back) — it tops the ranking.
    assert places[0]["visits"] >= 2
    # Dwell dominates this track → not classified as a pure transit.
    assert res["dwell"]["dwell_fraction"] > 0.4
    assert res["profile"] in ("patrol / recurring-orbit", "anchored / station-keeping")
    # It is doing what it always does → on/elevated, not a full break.
    assert res["anomaly"]["state"] in ("on-pattern", "elevated")
    assert res["anomaly"]["score"] < 0.66


def test_recurring_place_centroid_matches_dwell_location() -> None:
    now = time.time()
    base = (8.0, 50.0)
    track = _dwell_fixes(*base, now - 1800, 16)
    res = pol.analyze_track("vessel:111", track)
    assert res["place_count"] == 1
    c = res["recurring_places"][0]["centroid"]
    assert abs(c["lon"] - base[0]) < 0.01 and abs(c["lat"] - base[1]) < 0.01


# ── scattered track → no recurring place, off-pattern ──────────────────────────

def test_scattered_track_has_no_recurring_place() -> None:
    """Every fix kilometres from the last, never dwelling → DBSCAN finds no
    dense place; the anomaly score reads the track as off-pattern."""
    now = time.time()
    track: list[tuple[float, float, float]] = []
    for i in range(16):
        # Walk ~5 km per step in a non-repeating spiral → no point has _MIN_SAMPLES
        # neighbours within eps.
        track.append((now - 3600 + i * 120, 20.0 + i * 0.05, 55.0 + i * 0.03))

    res = pol.analyze_track("aircraft:scatter1", track)

    assert res["sufficient"] is True
    assert res["place_count"] == 0, "a scattered track has no recurring place"
    assert res["anomaly"]["off_pattern_share"] == 1.0
    assert res["anomaly"]["state"] == "off-pattern"
    assert res["profile"] in ("transiting", "mixed")


# ── baseline + excursion → flagged break ───────────────────────────────────────

def test_excursion_from_established_base_is_flagged() -> None:
    """A long dwell at one place (the baseline) followed by a sudden long-range
    departure raises the anomaly score above the dwell-only case."""
    now = time.time()
    base = (30.0, 60.0)
    # Strong baseline: 30 fixes loitering at base.
    track = _dwell_fixes(*base, now - 7200, 30)
    on_pattern = pol.analyze_track("aircraft:exc1", list(track))
    # Now append a single fix ~300 km away (far beyond the base radius).
    track.append((now, 33.0, 61.5))
    broke = pol.analyze_track("aircraft:exc1", track)

    assert on_pattern["place_count"] >= 1
    assert broke["anomaly"]["excursion_radii"] > pol._OFF_PATTERN_RADII
    assert broke["anomaly"]["score"] > on_pattern["anomaly"]["score"]
    assert broke["anomaly"]["state"] in ("elevated", "off-pattern")


# ── honesty: short tracks are not baselined ────────────────────────────────────

def test_short_track_reports_insufficient_not_fabricated() -> None:
    now = time.time()
    track = _dwell_fixes(5.0, 45.0, now - 300, pol._MIN_FIXES - 1)
    res = pol.analyze_track("aircraft:short1", track)
    assert res["sufficient"] is False
    assert res["found"] is True  # there ARE fixes, just too few
    assert res["recurring_places"] == []
    assert res["anomaly"]["state"] == "insufficient"
    assert res["fixes"] == pol._MIN_FIXES - 1


def test_empty_track_is_not_found() -> None:
    res = pol.analyze_track("aircraft:none", [])
    assert res["found"] is False
    assert res["sufficient"] is False


# ── DB-backed entry point ───────────────────────────────────────────────────────

def _seed_db(db: str, eid: str, pts: list[tuple[float, float, float]]) -> None:
    """Write (t, lon, lat) fixes for `eid` into a fresh tmp positions DB."""
    H._buffer.clear()
    H._last.clear()
    H.override_db_path(db)
    kind = eid.split(":", 1)[0]
    rows = [(kind, eid, t, lon, lat, 0.0, "{}") for (t, lon, lat) in pts]
    H._flush_sync(rows)


async def test_pattern_of_life_reads_db_track(tmp_path) -> None:
    """The async entry point loads an entity's DB track and clusters it."""
    now = time.time()
    eid = "vessel:311000111"
    base = (56.2, 26.4)
    pts = _dwell_fixes(*base, now - 3600, 20)
    _seed_db(str(tmp_path / "pol.db"), eid, pts)

    res = await pol.pattern_of_life(eid)
    assert res["found"] is True and res["sufficient"] is True
    assert res["place_count"] == 1
    assert res["fixes"] == 20


async def test_pattern_of_life_degrades_when_history_disabled(tmp_path, monkeypatch) -> None:
    """When history is disabled the analytic returns an honest insufficient
    result rather than crashing."""
    monkeypatch.setattr(H, "stats", lambda: {"enabled": False})
    res = await pol.pattern_of_life("aircraft:whatever")
    assert res["found"] is False
    assert res["sufficient"] is False
    assert res["recurring_places"] == []


# ── helper unit checks ──────────────────────────────────────────────────────────

def test_mean_std_population_convention() -> None:
    mean, std = pol._mean_std([2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0])
    # Population std of this classic sample is exactly 2.0.
    assert abs(mean - 5.0) < 1e-9
    assert abs(std - 2.0) < 1e-9
    assert pol._mean_std([]) == (0.0, 0.0)


def test_segment_speeds_drops_subfloor_and_impossible() -> None:
    now = time.time()
    # A 30s segment moving 1 km → ~64.8 kn (kept); a 5s desync of 3 km → >1000 kn
    # would be dropped, and a sub-30s delta is dropped outright.
    pts = [
        (now, 0.0, 0.0),
        (now + 5, 0.02, 0.0),     # 5s → sub-floor, dropped
        (now + 35, 0.03, 0.0),    # 30s, ~1.1 km → kept
    ]
    speeds = pol._segment_speeds_kn(pts)
    assert len(speeds) == 1
    assert 30.0 < speeds[0] < 200.0
