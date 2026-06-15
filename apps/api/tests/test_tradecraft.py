"""Deception detection, emitter geolocation, activity baselines."""

from __future__ import annotations

from app.intel import deception, emitter
from app.intel.baseline import BaselineStore

# ── deception ─────────────────────────────────────────────────────────────────


def _ac(icao, lon, lat):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"icao24": icao}}


def test_detect_gps_spoof_cluster():
    # >=5 distinct aircraft at the SAME position = a GPS-spoofing footprint.
    feats = [_ac(f"x{i}", 30.0, 45.0) for i in range(6)]
    out = deception.detect_gps(None, feats)
    hits = [f for f in out if f["type"] == "gps-spoof-cluster"]
    assert hits and hits[0]["count"] >= 5


def test_detect_gps_ignores_normal_spread():
    feats = [_ac(f"x{i}", 30.0 + i * 0.5, 45.0) for i in range(6)]  # spread out
    out = deception.detect_gps(None, feats)
    assert not any(f["type"] == "gps-spoof-cluster" for f in out)


# ── emitter geolocation ───────────────────────────────────────────────────────


def test_emitter_estimate_centroid_and_cep():
    pts = [(30.0, 45.0, 1.0), (30.2, 45.0, 2.0), (30.1, 45.2, 1.0), (30.0, 45.1, 1.0)]
    est = emitter.estimate_from_points(pts)
    assert est is not None
    assert 29.9 < est["lon"] < 30.3 and 44.9 < est["lat"] < 45.3
    assert est["cep_km"] >= 0 and 0.2 <= est["confidence"] <= 0.9
    assert est["n_degraded"] == 4


def test_emitter_needs_three_points():
    assert emitter.estimate_from_points([(0.0, 0.0, 1.0), (1.0, 1.0, 1.0)]) is None


# ── baselines ─────────────────────────────────────────────────────────────────


def test_baseline_flags_spike_and_handles_insufficient():
    bs = BaselineStore()
    # insufficient until _MIN_SAMPLES
    bs.sample("g", {"vessels": 10.0})
    assert bs.assess("g", {"vessels": 10.0})["metrics"]["vessels"]["baseline"] == "insufficient"
    # build a varied baseline (~mean 10, non-zero std), then assess a big spike
    for v in (8, 9, 10, 11, 12, 9, 10, 11):
        bs.sample("g", {"vessels": float(v)})
    normal = bs.assess("g", {"vessels": 10.0})["metrics"]["vessels"]
    assert normal["state"] == "normal"
    spike = bs.assess("g", {"vessels": 40.0})["metrics"]["vessels"]
    assert spike["state"] == "high"
    assert spike["z"] >= 2.0
