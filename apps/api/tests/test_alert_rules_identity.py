"""Per-identity watch rules (icao24/mmsi/callsign pin) — guard for P5.

Covers the two things a regression here would break silently:
  - ``AlertRuleIn`` accepts + normalizes icao24/mmsi/callsign (lowercased, blank
    → None), so ``evaluate_rules`` can do a plain case-insensitive match.
  - ``evaluate_rules`` treats an identity field as an ADDITIONAL gate on top of
    kinds/severity, and RELAXES the AOI geofence for an identity-pinned rule (it
    should follow the entity anywhere), while a legacy category+AOI rule (no
    identity fields) keeps behaving exactly as before.
"""

from __future__ import annotations

from app.intel.watch import _Candidate, evaluate_rules, reset_state
from app.routes.alert_rules import AlertRuleIn


def _rule(**over: object) -> dict:
    base = {
        "id": "rule-1",
        "label": "Track RCH1",
        "lat": 26.5,
        "lon": 56.3,
        "radius_nm": 50,
        "kinds": [],
        "min_severity": 1,
        "enabled": True,
    }
    base.update(over)
    return base


def setup_function() -> None:
    reset_state()


def teardown_function() -> None:
    reset_state()


# ── AlertRuleIn normalizes identity fields ──────────────────────────────────────


def test_alert_rule_in_lowercases_identity_fields() -> None:
    body = AlertRuleIn(
        label="watch a specific tail", lat=0, lon=0,
        icao24="ABC123", mmsi=None, callsign="RCH1",
    )
    assert body.icao24 == "abc123"
    assert body.callsign == "rch1"
    assert body.mmsi is None


def test_alert_rule_in_blank_identity_is_none() -> None:
    body = AlertRuleIn(label="no pin", lat=0, lon=0, icao24="   ")
    assert body.icao24 is None


# ── evaluate_rules: identity match is an additional gate + relaxes AOI ──────────


def test_identity_rule_fires_only_for_its_own_entity() -> None:
    # AOI is nowhere near either candidate — an identity rule must follow the
    # entity regardless (geofence relaxed), so it still must fire for the
    # matching icao24 and must NOT fire for a decoy aircraft sitting far away.
    r = _rule(lat=0.0, lon=0.0, radius_nm=1, icao24="abc123")
    target = _Candidate("aircraft:abc123", "military_air", 56.3, 26.5, 3,
                         "military contact RCH1", {"icao24": "abc123"})
    decoy = _Candidate("aircraft:def456", "military_air", 56.31, 26.51, 3,
                        "military contact RCH2", {"icao24": "def456"})
    firings = evaluate_rules([r], [target, decoy])
    assert len(firings) == 1
    fired_rule, fired_cand, transition = firings[0]
    assert fired_cand.entity_id == "aircraft:abc123"
    assert transition == "enter"


def test_identity_rule_matches_callsign_case_insensitively() -> None:
    r = _rule(lat=0.0, lon=0.0, radius_nm=1, callsign="RCH1")
    cand = _Candidate("aircraft:abc123", "military_air", 56.3, 26.5, 3,
                       "military contact rch1", {"icao24": "abc123"})
    firings = evaluate_rules([r], [cand])
    assert len(firings) == 1 and firings[0][2] == "enter"


def test_legacy_category_and_aoi_rule_unaffected() -> None:
    # No identity fields set → behaves exactly like before: geofence still
    # gates, and any candidate of a matching kind inside the AOI fires.
    r = _rule(lat=26.5, lon=56.3, radius_nm=50, kinds=["military_air"])
    inside = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    outside = _Candidate("aircraft:m2", "military_air", 10.0, 10.0, 3, "mil far away")
    firings = evaluate_rules([r], [inside, outside])
    assert len(firings) == 1
    assert firings[0][1].entity_id == "aircraft:m1"


def test_legacy_rule_ignores_identity_pinned_candidate_outside_kind() -> None:
    # An identity-less rule scoped to a kind must still ignore a non-matching
    # kind, identity fields notwithstanding.
    r = _rule(lat=26.5, lon=56.3, radius_nm=50, kinds=["quake"])
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    assert evaluate_rules([r], [cand]) == []


def test_identity_rule_with_no_aoi_still_fires() -> None:
    # P6.1: an identity-only rule (routes/alert_rules.py's model validator no
    # longer forces a fake AOI) persists lat/lon/radius_nm as None. The
    # entity-follows-anywhere behavior must be unchanged by having no AOI at
    # all, not just a distant one — has_identity is still the whole gate.
    r = _rule(lat=None, lon=None, radius_nm=None, icao24="abc123")
    cand = _Candidate("aircraft:abc123", "military_air", 100.0, -30.0, 3,
                       "military contact RCH1", {"icao24": "abc123"})
    firings = evaluate_rules([r], [cand])
    assert len(firings) == 1
    assert firings[0][2] == "enter"
