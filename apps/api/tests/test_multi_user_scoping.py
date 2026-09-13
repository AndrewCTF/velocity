"""ASVS V8.2.2 / V8.2.1: one user's data and actions are not another's, once
the deployment can tell two humans apart (Supabase configured).

Every test uses two distinct users, ALICE and BOB, with real signed tokens
(``tests/_authkit.py``). Single-user modes keep their open behaviour; the
last tests pin that.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app.correlate.bus import bus
from app.correlate.types import Alert
from app.intel import action_proposals_local, alert_rules_local
from app.main import create_app
from app.routes import actions as actions_mod
from tests._authkit import ALICE, BOB, bearer, mint, multi_user

A = bearer(mint(ALICE))
B = bearer(mint(BOB))


def _alert(owner: str | None, msg: str) -> Alert:
    return Alert(
        id=msg, rule_id="watch:r", severity="high", t=time.time(), lon=1.0, lat=2.0,
        confidence=0.9, message=msg, owner=owner,
    )


# ── /api/alerts/deliveries: sink URLs are secrets ───────────────────────────


def test_deliveries_show_only_the_callers_sinks(monkeypatch):
    multi_user(monkeypatch, url=False)
    for owner, url in ((ALICE, "https://discord.com/api/webhooks/alice"), (BOB, "https://hooks.example/bob")):
        asyncio.run(alert_rules_local.record_delivery(
            rule_id="r", entity_id="e", transition="enter", channel="webhook",
            target=url, ok=True, status=200, error=None, message="m", user_id=owner,
        ))
    with TestClient(create_app()) as c:
        got = c.get("/api/alerts/deliveries", headers=A).json()["deliveries"]
    assert [d["target"] for d in got] == ["https://discord.com/api/webhooks/alice"]


def test_watch_sweep_records_the_rule_owner_on_each_delivery(monkeypatch):
    from app.intel import watch
    from app.keys import UserCtx
    from app.workflows import control

    multi_user(monkeypatch, url=False)

    class _Res:
        error = None
        status = 204

    async def _send(*a, **k):
        return _Res()

    monkeypatch.setattr(control, "send", _send)
    monkeypatch.setattr(control, "check_sink_url", lambda url: None)
    rule = {"id": "r1", "channel": "webhook", "sink_url": "https://hooks.example/x", "label": "x"}
    cand = watch._Candidate(entity_id="aircraft:1", kind="military_air", lon=1.0, lat=2.0, severity_rank=3, summary="s")
    asyncio.run(watch._deliver_sinks(rule, cand, "enter", owner=UserCtx(BOB, "t").user_id))
    rows = asyncio.run(alert_rules_local.recent_deliveries(10, user_id=BOB))
    assert len(rows) == 1
    assert asyncio.run(alert_rules_local.recent_deliveries(10, user_id=ALICE)) == []


# ── /api/alerts and /ws/alerts: private geofence firings ────────────────────


def test_alert_buffer_hides_other_users_geofence_hits(monkeypatch):
    multi_user(monkeypatch, url=False)
    bus.publish(_alert(ALICE, "alice-private"))
    bus.publish(_alert(BOB, "bob-private"))
    bus.publish(_alert(None, "system-wide"))
    with TestClient(create_app()) as c:
        msgs = {a["message"] for a in c.get("/api/alerts?limit=50", headers=A).json()["alerts"]}
    assert "alice-private" in msgs and "system-wide" in msgs
    assert "bob-private" not in msgs
    # The wire shape the web client reads is unchanged (no owner field leaks).
    assert "owner" not in _alert(ALICE, "x").to_json()


def test_alert_socket_backfill_and_live_push_are_owner_filtered(monkeypatch):
    multi_user(monkeypatch, url=False)
    bus.publish(_alert(BOB, "bob-backfill"))
    bus.publish(_alert(ALICE, "alice-backfill"))
    with TestClient(create_app()) as c:
        with c.websocket_connect(f"/ws/alerts?key={mint(ALICE)}") as ws:
            seen = []
            while True:
                m = ws.receive_json()
                seen.append(m.get("message"))
                if m.get("message") == "alice-backfill":
                    break
            assert "bob-backfill" not in seen
            bus.publish(_alert(BOB, "bob-live"))
            bus.publish(_alert(ALICE, "alice-live"))
            assert ws.receive_json()["message"] == "alice-live"


def test_the_watch_evaluator_stamps_the_owner_on_bus_alerts():
    from app.intel import watch

    cand = watch._Candidate(entity_id="aircraft:1", kind="military_air", lon=1.0, lat=2.0, severity_rank=3, summary="s")
    assert watch._to_bus_alert({"id": "r"}, cand, "enter", owner=BOB).owner == BOB


# ── workflows: definitions, runs and memory ─────────────────────────────────


def test_an_analyst_cannot_read_workflows_runs_or_memory(monkeypatch):
    from app.workflows.store import WorkflowStore

    multi_user(monkeypatch, url=False, roles={ALICE: ["admin"]})
    from app.config import get_settings

    wf = asyncio.run(WorkflowStore(get_settings()).create_workflow("secret-wf", "", {"nodes": [], "edges": []}))
    with TestClient(create_app()) as c:
        for path in ("/api/workflows", f"/api/workflows/{wf['id']}", f"/api/workflows/{wf['id']}/runs",
                     f"/api/workflows/{wf['id']}/memory", "/api/workflows/schedules"):
            assert c.get(path, headers=B).status_code == 403, path
            assert c.get(path, headers=A).status_code == 200, path
        # The block catalog is not user data.
        assert c.get("/api/workflows/blocks", headers=B).status_code == 200


# ── action proposals ────────────────────────────────────────────────────────


def test_proposals_are_listed_and_decided_by_their_owner_or_an_admin(monkeypatch):
    from app.keys import UserCtx

    multi_user(monkeypatch, url=False, roles={"33333333-3333-4333-8333-333333333333": ["admin"]})
    dispatched: list[str] = []

    async def _dispatch(name, params, ctx):
        dispatched.append(ctx.user_id)
        return {"ok": True, "action": name, "target_id": "v:1", "audit": {}}

    monkeypatch.setattr(actions_mod, "dispatch", _dispatch)
    pid = asyncio.run(actions_mod.propose("flag_entity", {"entity_id": "v:1"}, UserCtx(ALICE, "t")))
    admin = bearer(mint("33333333-3333-4333-8333-333333333333"))
    with TestClient(create_app()) as c:
        assert [p["id"] for p in c.get("/api/actions/proposals", headers=B).json()] == []
        assert [p["id"] for p in c.get("/api/actions/proposals", headers=A).json()] == [pid]
        assert c.post(f"/api/actions/proposals/{pid}/approve", headers=B).status_code == 404
        assert c.post(f"/api/actions/proposals/{pid}/reject", headers=B).status_code == 404
        # Bob's refusals did not consume it.
        assert [p["id"] for p in c.get("/api/actions/proposals", headers=admin).json()] == [pid]
        assert c.post(f"/api/actions/proposals/{pid}/approve", headers=A).status_code == 200
    assert dispatched == [ALICE]


def test_a_proposal_is_taken_exactly_once_under_concurrent_approvals():
    """ASVS V2.3.4: two approvals racing on one proposal execute it once."""
    pid = asyncio.run(action_proposals_local.add("flag_entity", {}, 0.0, 900))

    async def _race():
        return await asyncio.gather(*(action_proposals_local.take(pid, 900) for _ in range(8)))

    got = asyncio.run(_race())
    assert sum(r is not None for r in got) == 1


# ── /ws/cop rooms ───────────────────────────────────────────────────────────


def _save_map(c: TestClient, headers: dict[str, str]) -> str:
    r = c.post("/api/maps", json={"name": "cop", "viewport": {"lon": 0, "lat": 0, "height": 1000}}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_cop_room_refuses_a_user_who_cannot_load_the_map(monkeypatch):
    from starlette.testclient import WebSocketDenialResponse
    from starlette.websockets import WebSocketDisconnect

    multi_user(monkeypatch, url=False)
    with TestClient(create_app()) as c:
        map_id = _save_map(c, A)
        with c.websocket_connect(f"/ws/cop?map={map_id}&key={mint(ALICE)}") as ws:
            assert ws.receive_json()["kind"] == "joined"
        with pytest.raises((WebSocketDenialResponse, WebSocketDisconnect)):
            with c.websocket_connect(f"/ws/cop?map={map_id}&key={mint(BOB)}") as ws:
                ws.receive_json()


# ── /api/audit with only a JWT secret ───────────────────────────────────────


def test_audit_requires_auditor_or_admin_with_only_a_jwt_secret(monkeypatch):
    multi_user(monkeypatch, url=False, roles={ALICE: ["auditor"]})
    with TestClient(create_app()) as c:
        assert c.get("/api/audit", headers=B).status_code == 403
        assert c.get("/api/audit", headers=A).status_code == 200


# ── Foundry mutations ───────────────────────────────────────────────────────


def test_foundry_mutations_need_the_operator_reads_do_not(monkeypatch):
    multi_user(monkeypatch, url=False, roles={ALICE: ["admin"]})
    with TestClient(create_app()) as c:
        assert c.post("/api/foundry/datasets", json={"name": "d"}, headers=B).status_code == 403
        assert c.get("/api/foundry/datasets", headers=B).status_code == 200
        r = c.post("/api/foundry/datasets", json={"name": "d"}, headers=A)
        assert r.status_code == 200, r.text


def test_every_foundry_mutation_carries_the_operator_gate():
    """Anti-rot: walks the ROUTER (app.routes hides leaves), with a floor so an
    empty walk cannot pass."""
    from app.routes import foundry

    mutating = {"POST", "PUT", "DELETE", "PATCH"}
    gated = 0
    for route in foundry.router.routes:
        methods = getattr(route, "methods", set()) & mutating
        has_gate = any(
            getattr(getattr(d, "dependency", None), "__name__", "") == "require_operator"
            for d in getattr(route, "dependencies", [])
        )
        assert bool(methods) == has_gate, f"{sorted(methods) or ['GET']} {route.path}"
        gated += has_gate
    assert gated >= 30, gated


# ── watch-officer triage ────────────────────────────────────────────────────


def test_watch_officer_triage_requires_a_user_and_is_audited(monkeypatch):
    from app.routes import watch_officer as wo

    names = {
        r.path: {getattr(d.call, "__name__", "") for d in r.dependant.dependencies}
        for r in wo.router.routes if r.path.endswith(("/dismiss", "/ack"))
    }
    assert len(names) == 2
    for deps in names.values():
        assert "current_user_or_local" in deps

    multi_user(monkeypatch, url=False, api_key="static-key-for-a-multi-user-deploy-0123")
    with TestClient(create_app()) as c:
        # A static key is not a person: triage of a shared queue needs one.
        r = c.post("/api/watch-officer/briefs/nope/ack", headers={"X-API-Key": "static-key-for-a-multi-user-deploy-0123"})
        assert r.status_code == 401
        assert c.post("/api/watch-officer/briefs/nope/ack", headers=A).status_code == 404


# ── single-user modes are unchanged ─────────────────────────────────────────


def test_keyless_single_user_still_sees_everything(client: TestClient):
    bus.publish(_alert("someone", "keyless-visible"))
    msgs = {a["message"] for a in client.get("/api/alerts").json()["alerts"]}
    assert "keyless-visible" in msgs
    assert client.get("/api/workflows").status_code == 200
    assert client.get("/api/alerts/deliveries").status_code == 200
