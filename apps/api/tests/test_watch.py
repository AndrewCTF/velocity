"""Standing-watchlist / geofence evaluator (Track C3) — hermetic units.

Covers the pieces that carry the logic, all WITHOUT a live snapshot or Supabase:
  - the geofence membership test (lon-first haversine, radius in nm),
  - candidate extraction from a fake aircraft snapshot + a fake fused brief,
  - the ENTER/EXIT transition diff (no per-tick spam; paired exit),
  - severity gating + kind-scoping of a rule,
  - the persistent Alert object shape + the RiskIndicator,
  - the session registry (no sessions → the sweep no-ops, the Supabase-unset case),
  - a full per-session evaluation over a mocked PostgREST: alert upsert + risk
    cache + a bus push onto the existing /ws/alerts transport.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import Settings
from app.correlate.bus import bus
from app.intel import watch
from app.intel.watch import (
    _Candidate,
    alert_object,
    candidates_from_brief,
    candidates_from_snapshot,
    candidates_from_vessels,
    evaluate_rules,
    evaluate_session,
    risk_indicator,
    standing_detections,
    within_geofence,
)
from app.keys import UserCtx


@pytest.fixture(autouse=True)
def _clean_state() -> None:
    """Every test starts with empty membership memory + no sessions."""
    watch.reset_state()
    watch._SESSIONS.clear()
    yield
    watch.reset_state()
    watch._SESSIONS.clear()


def _rule(**over: object) -> dict:
    base = {
        "id": "rule-1",
        "label": "Hormuz watch",
        "lat": 26.5,
        "lon": 56.3,
        "radius_nm": 50,
        "kinds": [],
        "min_severity": 1,
        "enabled": True,
    }
    base.update(over)
    return base


# ── geofence membership (lon-first haversine) ───────────────────────────────────


def test_within_geofence_inside_and_outside() -> None:
    r = _rule(lat=26.5, lon=56.3, radius_nm=50)
    # essentially at the centre → inside
    assert within_geofence(r, 56.3, 26.5) is True
    # ~5400 km away → outside
    assert within_geofence(r, 0.0, 0.0) is False


def test_within_geofence_is_lon_first() -> None:
    # A point just east of the centre (same lat) is well inside a 50 nm circle.
    # If the helper swapped lon/lat it would test the wrong point and miss.
    r = _rule(lat=26.5, lon=56.3, radius_nm=50)
    assert within_geofence(r, 56.5, 26.5) is True
    # The diagonally-mirrored point (lat/lon swapped: 26.5E, 56.3N) is far away —
    # proving order matters.
    assert within_geofence(r, 26.5, 56.3) is False


# ── candidate extraction ────────────────────────────────────────────────────────


def _feat(lon, lat, props) -> dict:
    return {"type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": props}


def test_candidates_from_snapshot_military_and_jamming() -> None:
    feats = [
        _feat(56.3, 26.5, {"icao24": "ae1234", "callsign": "RCH123"}),  # military callsign
        _feat(10.0, 50.0, {"icao24": "abc111", "callsign": "DLH4", "nac_p": 4}),  # degraded
        _feat(11.0, 51.0, {"icao24": "abc222", "callsign": "BAW9"}),  # plain airliner → nothing
    ]
    cands = candidates_from_snapshot(feats)
    kinds = {(c.entity_id, c.kind) for c in cands}
    assert ("aircraft:ae1234", "military_air") in kinds
    assert ("aircraft:abc111", "jamming") in kinds
    # the plain airliner produced no candidate
    assert not any(c.entity_id == "aircraft:abc222" for c in cands)


def test_candidates_from_brief_incident_and_domain_scoped() -> None:
    brief = {"incidents": [
        {"id": "inc1", "threat_level": "high", "centroid": {"lon": 56.3, "lat": 26.5},
         "domains": ["dark-vessel", "gps-jamming"], "narrative": "dark vessel under EW"},
        {"id": "inc2", "threat_level": "medium", "centroid": {"lon": 0.0, "lat": 0.0},
         "domains": ["quake"], "narrative": "M6 quake"},
    ]}
    cands = candidates_from_brief(brief)
    pairs = {(c.entity_id, c.kind) for c in cands}
    # generic 'incident' kind matches every incident
    assert ("incident:inc1", "incident") in pairs
    assert ("incident:inc2", "incident") in pairs
    # domain-scoped kinds only when the domain is present
    assert ("incident:inc1", "dark_vessel") in pairs
    assert ("incident:inc2", "quake") in pairs
    assert ("incident:inc1", "quake") not in pairs
    # high threat → rank 4
    di = next(c for c in cands if c.entity_id == "incident:inc1" and c.kind == "incident")
    assert di.severity_rank == 4


def test_candidates_from_vessels_military_only() -> None:
    feats = [
        _feat(56.3, 26.5, {"mmsi": "111", "name": "FRIGATE", "shipType": 35}),  # military
        _feat(56.4, 26.6, {"mmsi": "222", "name": "AUX", "shipType": 55}),  # mil law/aux
        _feat(56.5, 26.7, {"mmsi": "333", "name": "EVER GIVEN", "shipType": 70}),  # cargo
        _feat(56.6, 26.8, {"mmsi": "444", "name": "NO TYPE"}),  # unknown → skip
    ]
    cands = candidates_from_vessels(feats)
    pairs = {(c.entity_id, c.kind) for c in cands}
    assert ("vessel:111", "military_vessel") in pairs
    assert ("vessel:222", "military_vessel") in pairs
    # cargo + untyped vessels produce nothing
    assert not any(c.entity_id in {"vessel:333", "vessel:444"} for c in cands)


# ── LEVEL view: standing detections report presence, not a one-shot crossing ────


def test_standing_detections_is_level_not_edge() -> None:
    # The consistency guarantee: a contact SITTING inside an AOI is reported on
    # EVERY call — unlike evaluate_rules, which fires the ENTER once then goes quiet.
    r = _rule(lat=26.5, lon=56.3, radius_nm=50, kinds=["military_vessel"])
    inside = _Candidate("vessel:111", "military_vessel", 56.3, 26.5, 3, "military vessel FRIGATE")

    # edge path fires once, then nothing while it stays inside
    assert len(evaluate_rules([r], [inside])) == 1
    assert evaluate_rules([r], [inside]) == []

    # level path reports it every time, regardless of prior calls / membership state
    for _ in range(3):
        dets = standing_detections([r], [inside])
        assert len(dets) == 1
        assert dets[0]["entity_id"] == "vessel:111"
        assert dets[0]["kind"] == "military_vessel"
        assert dets[0]["severity_word"] == "medium"

    # a contact outside the AOI is not a standing detection
    outside = _Candidate("vessel:111", "military_vessel", 0.0, 0.0, 3, "x")
    assert standing_detections([r], [outside]) == []


def test_standing_detections_respects_kind_and_severity() -> None:
    # kind-scoped rule ignores a non-matching candidate; severity floor gates too.
    r = _rule(kinds=["military_vessel"], min_severity=4)
    mil_air = _Candidate("aircraft:a1", "military_air", 56.3, 26.5, 3, "jet")  # wrong kind
    low_sev = _Candidate("vessel:111", "military_vessel", 56.3, 26.5, 3, "ship")  # below floor
    assert standing_detections([r], [mil_air, low_sev]) == []
    # raise severity to the floor → it now reports
    hot = _Candidate("vessel:111", "military_vessel", 56.3, 26.5, 4, "ship")
    assert len(standing_detections([r], [hot])) == 1
    # disabled rule reports nothing
    assert standing_detections([_rule(enabled=False, kinds=["military_vessel"])], [hot]) == []


# ── transition diff: ENTER then EXIT, no per-tick spam ──────────────────────────


def test_evaluate_rules_fires_enter_then_silent_then_exit() -> None:
    r = _rule(lat=26.5, lon=56.3, radius_nm=50, kinds=["military_air"])
    inside = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    outside = _Candidate("aircraft:m1", "military_air", 0.0, 0.0, 3, "mil")

    # tick 1: contact appears inside → one ENTER firing
    f1 = evaluate_rules([r], [inside])
    assert [(rule["id"], c.entity_id, t) for rule, c, t in f1] == [
        ("rule-1", "aircraft:m1", "enter")
    ]

    # tick 2: still inside → NO new firing (membership unchanged)
    f2 = evaluate_rules([r], [inside])
    assert f2 == []

    # tick 3: now outside → one EXIT firing
    f3 = evaluate_rules([r], [outside])
    assert [(c.entity_id, t) for _, c, t in f3] == [("aircraft:m1", "exit")]

    # tick 4: still outside → silent again
    assert evaluate_rules([r], [outside]) == []


def test_evaluate_rules_severity_gate_blocks_enter() -> None:
    # rule wants severity >=4, candidate is only rank 3 → membership flips but NO firing
    r = _rule(min_severity=4, kinds=["military_air"])
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    assert evaluate_rules([r], [cand]) == []
    # the membership IS recorded (so it won't fire later either while inside)
    assert watch._STATE.inside[("rule-1", "aircraft:m1")] is True


def test_evaluate_rules_kind_scope_filters() -> None:
    # a jamming-only rule ignores a military candidate sitting inside the circle
    r = _rule(kinds=["jamming"])
    mil = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    assert evaluate_rules([r], [mil]) == []


def test_evaluate_rules_empty_kinds_matches_any() -> None:
    r = _rule(kinds=[])  # match any kind
    cand = _Candidate("incident:i1", "incident", 56.3, 26.5, 4, "x")
    f = evaluate_rules([r], [cand])
    assert len(f) == 1 and f[0][2] == "enter"


def test_evaluate_rules_skips_disabled_rule() -> None:
    r = _rule(enabled=False)
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    assert evaluate_rules([r], [cand]) == []


# ── alert object + risk indicator shape ─────────────────────────────────────────


def test_alert_object_shape_is_acknowledgeable() -> None:
    r = _rule()
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "military contact RCH1")
    obj = alert_object(r, cand, "enter", "2026-06-21T00:00:00Z")
    # ontology stores it as the catch-all kind, with the semantic kind in props
    assert obj.kind == "object"
    assert obj.props["kind"] == "alert"
    # acknowledgeable lifecycle: born open
    assert obj.props["state"] == "open"
    assert obj.props["transition"] == "enter"
    assert obj.props["rule_id"] == "rule-1"
    assert obj.props["entity_id"] == "aircraft:m1"
    assert "entered" in obj.props["message"]
    # deterministic id per (rule, entity, transition) so re-enters upsert, not dup
    assert obj.id == "alert:rule-1:aircraft:m1:enter"


def test_risk_indicator_shape() -> None:
    r = _rule()
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 4, "military contact RCH1")
    ri = risk_indicator(r, cand, "2026-06-21T00:00:00Z")
    assert ri["rule_id"] == "rule-1"
    assert ri["kind"] == "military_air"
    assert ri["severity"] == 4
    assert "RCH1" in ri["reason"]


# ── session registry: no sessions → no work (also the Supabase-unset case) ──────


def test_evaluate_all_noop_without_sessions() -> None:
    # No registered session → the sweep returns 0 and never touches a snapshot or
    # store. This is also exactly the graceful behaviour when Supabase is unset.
    assert asyncio.run(watch.evaluate_all()) == 0


def test_register_unregister_session() -> None:
    ctx = UserCtx("u1", "tok")
    watch.register_session(ctx)
    assert [c.user_id for c in watch.active_sessions()] == ["u1"]
    # re-register refreshes the token, doesn't duplicate
    watch.register_session(UserCtx("u1", "tok2"))
    assert len(watch.active_sessions()) == 1
    assert watch.active_sessions()[0].token == "tok2"
    watch.unregister_session("u1")
    assert watch.active_sessions() == []


# ── full per-session evaluation over a mocked PostgREST ─────────────────────────


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


# Shared accumulator: watch.py (rules fetch + bus) and ontology.py (object upserts)
# each build their own client per `async with _client()`.
_POSTS: list[tuple[str, dict]] = []


class _RecordingClient:
    """Records POSTs and serves a single enabled rule for the GET on alert_rules."""

    def __init__(self, rules: list[dict]) -> None:
        self._rules = rules

    async def __aenter__(self) -> _RecordingClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def get(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        if url.endswith("/alert_rules"):
            return _FakeResp(200, self._rules)
        # ontology get (risk-cache read-before-merge) → nothing persisted yet
        return _FakeResp(200, [])

    async def post(self, url: str, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        _POSTS.append((url, json))
        if url.endswith("/objects"):
            return _FakeResp(201, [{**json, "created_at": "2026-06-21T00:00:00Z"}])
        if url.endswith("/links"):
            return _FakeResp(201, [{**json, "id": "lnk-1"}])
        return _FakeResp(201, json)


def _settings() -> Settings:
    return Settings(supabase_url="http://x", supabase_anon_key="anon")


def test_evaluate_session_fires_persists_and_pushes(monkeypatch: pytest.MonkeyPatch) -> None:
    # Rules still come from the (mocked) PostgREST alert_rules table; ontology
    # writes land in the real local SQLite store (temp DB via conftest).
    from app.intel.ontology_local import SqliteRegistry

    _POSTS.clear()
    rules = [_rule(kinds=["military_air"])]
    monkeypatch.setattr(watch, "_client", lambda: _RecordingClient(rules))

    # a military contact sitting inside the AOI
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "military contact RCH1")

    # capture the bus push (the /ws/alerts transport we reuse)
    pushed: list = []
    off = bus.on_publish(lambda a: pushed.append(a))
    try:
        fired = asyncio.run(evaluate_session(UserCtx("u1", "tok"), _settings(), [cand]))
    finally:
        off()

    assert fired == 1
    reg = SqliteRegistry(UserCtx("u1", "tok"), _settings())
    # the Alert object was upserted …
    alerts = asyncio.run(reg.list_by_kind("alert"))
    assert alerts, "expected an alert object upsert"
    assert alerts[0].props["state"] == "open"
    # … and the RiskIndicator was cached onto the entity's object
    entity = asyncio.run(reg.get("aircraft:m1"))
    assert entity is not None, "expected a risk indicator cache on the entity"
    assert entity.props["risk_indicator"]["kind"] == "military_air"
    # Move 1: the mint is evidenced with the WATCH RULE as its provenance source
    # (a rule minted this, not a generic "analyst" write).
    ri_rows = asyncio.run(reg.get_assertions("aircraft:m1", prop="risk_indicator"))
    assert ri_rows and ri_rows[0].source == "rule:watchbox:rule-1"
    # … and it pushed onto the existing /ws/alerts bus
    assert len(pushed) == 1
    assert pushed[0].rule_id == "watch:rule-1"
    assert "entered" in pushed[0].message


def test_evaluate_session_noop_when_supabase_unset() -> None:
    # No supabase_url → _list_enabled_rules returns [] without raising, so the
    # session evaluates to zero firings (graceful degrade, no crash).
    cand = _Candidate("aircraft:m1", "military_air", 56.3, 26.5, 3, "mil")
    fired = asyncio.run(evaluate_session(UserCtx("u1", "tok"), Settings(), [cand]))
    assert fired == 0
