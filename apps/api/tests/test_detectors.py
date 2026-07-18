"""Behavioral-detector unit tests — synthetic tracks, no network/DB."""

from __future__ import annotations

from app.intel import detectors


def _track(tid, pts):
    return {"id": tid, "kind": "vessel", "points": pts}


def test_ais_gap_fires_for_dark_vessel_in_aoi():
    now = 10_000.0
    aoi = (50.0, 24.0, 58.0, 30.0)  # Strait of Hormuz-ish bbox
    tracks = [
        _track("vessel:1", [[54.0, 26.0, now - 60], [54.1, 26.1, now - 5_000]]),  # dark 5000s
        _track("vessel:2", [[54.0, 26.0, now - 30]]),                              # still live
        _track("vessel:3", [[10.0, 10.0, now - 9_000]]),                           # dark but OUTSIDE aoi
    ]
    hits = detectors.ais_gap(tracks, now=now, gap_seconds=600, aoi=aoi)
    ids = {h["id"] for h in hits}
    assert ids == {"vessel:1"}
    assert hits[0]["age_s"] >= 600


def test_ais_gap_no_aoi_considers_all():
    now = 100.0
    tracks = [_track("v", [[0.0, 0.0, now - 1_000]])]
    assert len(detectors.ais_gap(tracks, now=now, gap_seconds=600)) == 1


def test_proximity_pairs_close_tracks():
    now = 0.0
    # two vessels ~1 nm apart, one far away
    tracks = [
        _track("a", [[54.000, 26.000, now]]),
        _track("b", [[54.000, 26.017, now]]),  # ~1.0 nm north
        _track("c", [[40.000, 10.000, now]]),
    ]
    hits = detectors.proximity(tracks, max_nm=2.0)
    pairs = {frozenset((h["a"], h["b"])) for h in hits}
    assert pairs == {frozenset(("a", "b"))}


def test_proximity_none_when_far():
    tracks = [
        _track("a", [[54.0, 26.0, 0.0]]),
        _track("b", [[55.0, 27.0, 0.0]]),  # ~70+ nm
    ]
    assert detectors.proximity(tracks, max_nm=2.0) == []


def test_loiter_fires_for_stationary_track():
    now = 10_000.0
    pts = [[54.0, 26.0, now - 1_800], [54.001, 26.001, now - 900], [54.0, 26.0, now - 10]]
    hit = detectors.loiter(_track("v", pts), radius_nm=1.0, dwell_seconds=1_800, now=now)
    assert hit is not None and hit["id"] == "v"


def test_loiter_none_for_transiting_track():
    now = 10_000.0
    # moving steadily ~ many nm across the window → not loitering
    pts = [[54.0, 26.0, now - 1_800], [54.5, 26.5, now - 900], [55.0, 27.0, now - 10]]
    assert detectors.loiter(_track("v", pts), radius_nm=1.0, dwell_seconds=1_800, now=now) is None


def test_haversine_known_distance():
    # 1 degree of latitude ≈ 60 nm
    nm = detectors.haversine_nm(0.0, 0.0, 0.0, 1.0)
    assert 59.0 < nm < 61.0


def test_haversine_nm_handles_antipodal_without_domain_error() -> None:
    import math

    from app.intel.detectors import haversine_nm

    # Antipodal points sit at the asin(1.0) boundary; float error can push the
    # argument just past 1.0, which the min(1.0, ...) clamp absorbs. Must return a
    # finite ~half-circumference distance (~10,800 nm), never a domain ValueError.
    d = haversine_nm(0.0, 0.0, 180.0, 0.0)
    assert math.isfinite(d) and 10_000 < d < 11_000
