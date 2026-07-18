"""Phase-2 wiring tests: position-history tracks → behavioral candidates →
geofence firing, plus the tip-and-cue AOI mapping. Pure + synchronous (no
network/DB) — exercises the same `evaluate_rules` the live evaluator runs."""

from __future__ import annotations

import pytest

from app.intel import cue, watch


@pytest.fixture(autouse=True)
def _fresh_state():
    watch.reset_state()
    yield
    watch.reset_state()


def _dark_track(tid, lon, lat, now):
    # last fix is 1h old → AIS-dark past the 30-min default
    return {"id": tid, "kind": "vessel", "points": [[lon, lat, now - 7200], [lon, lat, now - 3600]]}


def _rule(kind, lon, lat, radius_nm=50, sev=1):
    return {"id": "r1", "label": "AOI", "lon": lon, "lat": lat,
            "radius_nm": radius_nm, "kinds": [kind], "min_severity": sev, "enabled": True}


def test_ais_gap_candidate_is_produced():
    now = 1_000_000.0
    cands = watch.candidates_from_tracks([_dark_track("vessel:1", 56.6, 26.6, now)], now)
    kinds = {c.kind for c in cands}
    assert "ais_gap" in kinds
    gap = next(c for c in cands if c.kind == "ais_gap")
    assert gap.entity_id == "vessel:1"


def test_dark_vessel_in_aoi_fires_once_on_enter():
    now = 1_000_000.0
    cands = watch.candidates_from_tracks([_dark_track("vessel:1", 56.6, 26.6, now)], now)
    rule = _rule("ais_gap", 56.6, 26.6)  # AOI centred on the dark vessel
    firings = watch.evaluate_rules([rule], cands)
    enters = [f for f in firings if f[2] == "enter" and f[1].kind == "ais_gap"]
    assert len(enters) == 1
    # second sweep with the contact still inside → no duplicate enter (transition)
    again = watch.evaluate_rules([rule], cands)
    assert [f for f in again if f[2] == "enter"] == []


def test_dark_vessel_outside_aoi_does_not_fire():
    now = 1_000_000.0
    cands = watch.candidates_from_tracks([_dark_track("vessel:1", 56.6, 26.6, now)], now)
    rule = _rule("ais_gap", 0.0, 0.0)  # AOI far away (Gulf of Guinea-ish)
    firings = watch.evaluate_rules([rule], cands)
    assert firings == []


def test_kind_filter_excludes_unmatched():
    now = 1_000_000.0
    cands = watch.candidates_from_tracks([_dark_track("vessel:1", 56.6, 26.6, now)], now)
    rule = _rule("rendezvous", 56.6, 26.6)  # only wants rendezvous; we have ais_gap
    assert watch.evaluate_rules([rule], cands) == []


def test_cue_maps_point_to_known_aoi():
    # Strait of Hormuz bbox is configured in sar_vessels.AOIS
    assert cue.aoi_for_point(56.6, 26.6) == "hormuz"
    assert cue.aoi_for_point(0.0, 0.0) is None


def test_geofence_exit_pops_state_key() -> None:
    # On exit the (rule, entity) key must be DROPPED, not stored as False: a False
    # entry per distinct entity that ever transited an AOI grows _STATE.inside
    # without bound over uptime. get(key, False) already treats absent as outside.
    now = 1_000_000.0
    rule = _rule("ais_gap", 56.6, 26.6)
    inside = watch.candidates_from_tracks([_dark_track("vessel:1", 56.6, 26.6, now)], now)
    watch.evaluate_rules([rule], inside)  # enter → key stored
    assert watch._STATE.inside  # non-empty after enter
    outside = watch.candidates_from_tracks([_dark_track("vessel:1", 0.0, 0.0, now)], now)
    firings = watch.evaluate_rules([rule], outside)  # far outside the AOI → exit
    assert any(f[2] == "exit" for f in firings)
    assert watch._STATE.inside == {}  # key popped, not left as a False entry
