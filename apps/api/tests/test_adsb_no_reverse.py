"""Guards: the served ADS-B snapshot must never fly an aircraft BACKWARDS.

Measured on a warm backend 2026-07-14, BEFORE these guards: 9.2% of airborne
consecutive moves in /api/adsb/global regressed along the aircraft's own
track_deg (median -3.8 km, worst -161 km), across 5,531 distinct aircraft in
60 s. Root cause: the snapshot tier merge was last-writer-wins, and tier 3
(firehose) serves a CACHED list that never expires — from this egress the only
reachable firehose verb takes >60 s to download, so a minutes-old fix overwrote
the 0.1 s-old sidecar fix, then flipped back whenever the aircraft fell outside
the firehose's smaller coverage.

Two independent guards, both exercised here:
  1. _merge_raw_into keeps the FRESHEST OBSERVATION → the union is
     order-independent, so no tier can clobber a fresher one by merging later.
  2. _regresses / _merge_with_previous drop a fix that moves a fast airborne
     contact backwards along its own track, whatever tier produced it.

See docs/decisions.md and the module comments in routes/adsb.py.
"""

from __future__ import annotations

import math
import time

from app.routes.adsb import (
    _BACKWARD_MAX_HOLD_S,
    _along_track_delta_m,
    _feat_obs_at,
    _merge_raw_into,
    _merge_with_previous,
    _regresses,
)

# ── helpers ────────────────────────────────────────────────────────────────────

_LAT = 40.0
_LON = -75.0


def _raw(hexid="abc123", lon=_LON, lat=_LAT, seen_pos=0.1, seen_at=1000.0, gs=485.0, track=90.0):
    """A readsb-shaped raw aircraft dict (the shape _aircraft_geojson parses)."""
    return {
        "hex": hexid,
        "lat": lat,
        "lon": lon,
        "gs": gs,  # knots
        "track": track,
        "alt_baro": 35000,
        "category": "A3",
        "flight": "TEST123",
        "seen_pos": seen_pos,
        "_seen_at": seen_at,
    }


def _feat(lon=_LON, lat=_LAT, seen_at=None, seen_pos=0.1, gs_ms=250.0, track=90.0, ground=False):
    """A snapshot feature (the shape _merge_with_previous handles).

    seen_at defaults to REAL now: _merge_with_previous reads time.time() itself,
    so a fixed epoch would look decades stale and trip the escape hatch.
    """
    if seen_at is None:
        seen_at = time.time()
    return {
        "type": "Feature",
        "id": "aircraft:abc123",
        "geometry": {"type": "Point", "coordinates": [lon, lat, 10000.0]},
        "properties": {
            "icao24": "abc123",
            "velocity_ms": gs_ms,
            "track_deg": track,
            "on_ground": ground,
            "seen_at": seen_at,
            "seen_pos_s": seen_pos,
        },
    }


def _shift_east(lon, lat, metres):
    """Move a lon/lat east by `metres` (small-step, good enough for a fixture)."""
    n = 6378137.0 / math.sqrt(1 - 6.69437999014e-3 * math.sin(math.radians(lat)) ** 2)
    return lon + math.degrees(metres / (n * math.cos(math.radians(lat)))), lat


# ── guard 1: the union is freshest-wins, not last-writer-wins ──────────────────


def test_stale_tier_merged_last_does_not_clobber_a_fresher_fix():
    """THE REGRESSION. Tier 3 (a cached firehose) must not overwrite tier 2's
    fresher fix just by merging later."""
    by_id: dict = {}
    # Fresh: received at t=1000, position was 0.1s old inside → observed ~999.9.
    _merge_raw_into(by_id, [_raw(lon=_LON, seen_at=1000.0, seen_pos=0.1)])
    fresh_lon = by_id["aircraft:abc123"]["geometry"]["coordinates"][0]
    # Stale cached tier: pulled 90s ago; it still CLAIMS seen_pos=0.3 (the lie —
    # that is the age at UPSTREAM serve time, not at our use time).
    stale_lon, _ = _shift_east(_LON, _LAT, -20_000)
    _merge_raw_into(by_id, [_raw(lon=stale_lon, seen_at=910.0, seen_pos=0.3)])
    assert by_id["aircraft:abc123"]["geometry"]["coordinates"][0] == fresh_lon, (
        "a cached tier merged last overwrote a fresher fix — the reverse bug"
    )


def test_fresher_tier_merged_last_does_win():
    """The flip side: freshness, not order, decides — a genuinely fresher fix
    merged later must still land (otherwise we'd just freeze the map)."""
    by_id: dict = {}
    _merge_raw_into(by_id, [_raw(lon=_LON, seen_at=910.0, seen_pos=0.3)])
    newer_lon, _ = _shift_east(_LON, _LAT, 20_000)
    _merge_raw_into(by_id, [_raw(lon=newer_lon, seen_at=1000.0, seen_pos=0.1)])
    assert by_id["aircraft:abc123"]["geometry"]["coordinates"][0] == newer_lon


def test_merge_order_does_not_change_the_result():
    """Order-independence is the actual invariant — assert it directly."""
    a = _raw(lon=_LON, seen_at=1000.0, seen_pos=0.1)
    b_lon, _ = _shift_east(_LON, _LAT, -20_000)
    b = _raw(lon=b_lon, seen_at=910.0, seen_pos=0.3)
    ab: dict = {}
    _merge_raw_into(ab, [a])
    _merge_raw_into(ab, [b])
    ba: dict = {}
    _merge_raw_into(ba, [b])
    _merge_raw_into(ba, [a])
    assert (
        ab["aircraft:abc123"]["geometry"]["coordinates"]
        == ba["aircraft:abc123"]["geometry"]["coordinates"]
    )


def test_merge_still_adds_aircraft_nobody_else_has():
    """Breadth must be unchanged: an id with no incumbent is always taken."""
    by_id: dict = {}
    _merge_raw_into(by_id, [_raw(hexid="aaa111", seen_at=1000.0)])
    _merge_raw_into(by_id, [_raw(hexid="bbb222", seen_at=500.0, seen_pos=99.0)])
    assert set(by_id) == {"aircraft:aaa111", "aircraft:bbb222"}


def test_feat_obs_at_ages_a_cached_tier():
    """_feat_obs_at must age a cached tier by its ORIGINAL receipt stamp."""
    fresh = _feat(seen_at=1000.0, seen_pos=0.1)
    cached = _feat(seen_at=910.0, seen_pos=0.3)  # same claimed seen_pos, 90s stale
    assert _feat_obs_at(fresh) > _feat_obs_at(cached)
    assert _feat_obs_at({"properties": {}}) is None


# ── guard 2: along-track regression is rejected ────────────────────────────────


def test_regressing_fix_is_dropped_and_previous_held():
    """A fix that puts a fast airborne contact 3 km behind its last served
    position is upstream noise — hold the previous fix."""
    now = time.time()
    prev = _feat(lon=_LON, seen_at=now)
    back_lon, _ = _shift_east(_LON, _LAT, -3000)
    new = _feat(lon=back_lon, seen_at=now + 1)
    merged = _merge_with_previous({"features": [new]}, {"features": [prev]})
    assert merged["features"][0]["geometry"]["coordinates"][0] == _LON


def test_forward_fix_is_always_accepted():
    """The guard must not freeze the map: forward motion always lands."""
    now = time.time()
    prev = _feat(lon=_LON, seen_at=now)
    fwd_lon, _ = _shift_east(_LON, _LAT, 1500)
    new = _feat(lon=fwd_lon, seen_at=now + 1)
    merged = _merge_with_previous({"features": [new]}, {"features": [prev]})
    assert merged["features"][0]["geometry"]["coordinates"][0] == fwd_lon


def test_small_backward_jitter_is_tolerated():
    """ADS-B position noise is ~10-30 m — under the 250 m threshold it must not
    trip the guard, or we'd hold on noise."""
    now = time.time()
    prev = _feat(lon=_LON, seen_at=now)
    jitter_lon, _ = _shift_east(_LON, _LAT, -30)
    new = _feat(lon=jitter_lon, seen_at=now + 1)
    merged = _merge_with_previous({"features": [new]}, {"features": [prev]})
    assert merged["features"][0]["geometry"]["coordinates"][0] == jitter_lon


def test_guard_releases_once_the_held_fix_goes_stale():
    """Escape hatch: never pin a contact to a wrong spot forever. Past
    _BACKWARD_MAX_HOLD_S the new fix is accepted even if it regresses."""
    now = time.time()
    prev = _feat(lon=_LON, seen_at=now - _BACKWARD_MAX_HOLD_S - 5)
    back_lon, _ = _shift_east(_LON, _LAT, -3000)
    new = _feat(lon=back_lon, seen_at=now)
    assert _regresses(prev, new, now) is False


def test_on_ground_and_slow_contacts_are_exempt():
    """Taxiing aircraft legitimately move against a stale track_deg; pushback is
    literally backwards. The guard is for FAST AIRBORNE contacts only."""
    now = time.time()
    back_lon, _ = _shift_east(_LON, _LAT, -3000)
    grounded_prev = _feat(lon=_LON, seen_at=now, ground=True)
    assert _regresses(grounded_prev, _feat(lon=back_lon, ground=True), now + 1) is False
    slow_prev = _feat(lon=_LON, seen_at=now, gs_ms=10.0)
    assert _regresses(slow_prev, _feat(lon=back_lon, gs_ms=10.0), now + 1) is False


def test_regresses_tolerates_malformed_features():
    """Never 500 the snapshot on a junk upstream record."""
    assert _regresses({"properties": {}}, _feat(), time.time()) is False
    assert _along_track_delta_m({"geometry": {"coordinates": []}}, _feat()) is None
    assert _along_track_delta_m(_feat(), {"geometry": {"coordinates": [None, None]}}) is None


def test_along_track_delta_sign_and_magnitude():
    """Sanity-check the projection itself: east-bound contact, moved 1 km east."""
    prev = _feat(lon=_LON, track=90.0)
    east_lon, _ = _shift_east(_LON, _LAT, 1000)
    d = _along_track_delta_m(prev, _feat(lon=east_lon))
    assert d is not None and abs(d - 1000.0) < 5.0
    west_lon, _ = _shift_east(_LON, _LAT, -1000)
    d_back = _along_track_delta_m(prev, _feat(lon=west_lon))
    assert d_back is not None and abs(d_back + 1000.0) < 5.0


def test_carry_forward_still_works():
    """The guard must not break the existing carry-forward (missing contacts are
    held up to max_age_s so icons don't blink out)."""
    prev = _feat(lon=_LON, seen_at=time.time())
    merged = _merge_with_previous({"features": []}, {"features": [prev]})
    assert len(merged["features"]) == 1
