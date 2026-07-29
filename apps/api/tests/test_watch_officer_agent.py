"""Watch-officer Stage 3 — agent wiring, per-cycle ceilings, idempotency, watchdog.

``incidents.brief``/``cue.run`` are stubbed (as in test_watch_officer.py); here
``agent.run_agent`` is ALSO stubbed so these tests exercise our dispatch/budget/
dedup contract, never a real LLM.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.intel import agent, cue, incidents, watch_officer
from app.intel.incident_store import incident_store
from app.intel.ontology import get_registry


def _incident(level: str, domains: list[str], lon: float, lat: float, iid: str = "x") -> dict[str, Any]:
    return {
        "id": iid,
        "threat_level": level,
        "score": 12.0,
        "domains": domains,
        "centroid": {"lon": lon, "lat": lat},
        "narrative": f"{level} {'+'.join(domains)}",
        "evidence": [{"domain": domains[0], "severity": "high", "summary": "s",
                      "lon": lon, "lat": lat, "ref": "r", "kind": "measured"}],
        "follow_up": ["look here"],
    }


def _reset(scope: str = "watch-officer") -> None:
    watch_officer.reset_state()
    incident_store._history.pop(scope, None)
    incident_store._last_changes.pop(scope, None)


def _stub_brief(incs: list[dict[str, Any]], monkeypatch) -> None:
    async def fake_brief(*a, **k) -> dict[str, Any]:
        return {"incidents": incs}
    monkeypatch.setattr(incidents, "brief", fake_brief)


def _stub_agent(monkeypatch, calls: list[Any]) -> None:
    async def fake_run_agent(q, bbox, **kwargs):
        calls.append((q, kwargs.get("ctx"), kwargs.get("interactive"), kwargs.get("max_steps")))
        yield {"type": "final", "assessment": "stubbed", "findings": [], "follow_up": []}
    monkeypatch.setattr(agent, "run_agent", fake_run_agent)


def _stub_cue(monkeypatch, calls: list[Any]) -> None:
    async def fake_cue(lon: float, lat: float) -> dict[str, Any]:
        calls.append((lon, lat))
        return {"status": "ok", "aoi": "hormuz"}
    monkeypatch.setattr(cue, "run", fake_cue)


def _wipe_ontology(*incident_ids: str) -> None:
    """Best-effort local-registry cleanup so a stable id from a prior test
    doesn't carry an ``agent_fired`` marker into this one."""
    reg = get_registry(watch_officer._LOCAL_CTX, __import__("app.config", fromlist=["get_settings"]).get_settings())

    async def _wipe() -> None:
        for oid in incident_ids:
            obj = await reg.get(oid)
            if obj is not None:
                await reg.assert_props(oid, {"agent_fired": False}, source="test")

    asyncio.run(_wipe())


# ── 3a: run_agent replaces the hardcoded branch, read-only (ctx=None) ────────


def test_actionable_incident_runs_agent_read_only(monkeypatch) -> None:
    _reset()
    agent_calls: list[Any] = []
    _stub_agent(monkeypatch, agent_calls)
    _stub_brief([_incident("high", ["military"], 5.0, 5.0, "a1")], monkeypatch)

    filed = asyncio.run(watch_officer.run_once())

    assert filed == 1
    assert len(agent_calls) == 1
    _q, ctx, interactive, max_steps = agent_calls[0]
    # ctx must be None (NOT the truthy _LOCAL_CTX) — withholds write-back tools.
    assert ctx is None
    assert interactive is False
    assert max_steps == 3
    brief = watch_officer.list_briefs()[0]
    assert brief["agent_assessment"] == "stubbed"


# ── check 1 + 2: fires once per convergence; new/absent/reappear dedup ───────


def test_action_fires_once_then_not_again_when_resolved_then_reappears(monkeypatch) -> None:
    _reset()
    agent_calls: list[Any] = []
    cue_calls: list[Any] = []
    _stub_agent(monkeypatch, agent_calls)
    _stub_cue(monkeypatch, cue_calls)

    inc = _incident("elevated", ["dark-vessel"], 56.3, 26.5, "v1")
    from app.intel import promotion
    _wipe_ontology(promotion._stable_incident_id(inc))

    # Sweep 1: incident present + actionable → agent + cue both fire once.
    _stub_brief([inc], monkeypatch)
    filed1 = asyncio.run(watch_officer.run_once())
    assert filed1 == 1
    assert len(agent_calls) == 1
    assert len(cue_calls) == 1

    # Sweep 2: incident resolved (absent this sweep) → no action attempt.
    _stub_brief([], monkeypatch)
    filed2 = asyncio.run(watch_officer.run_once())
    assert filed2 == 0
    assert len(agent_calls) == 1
    assert len(cue_calls) == 1

    # Sweep 3: SAME incident_key reappears → incident_store reports it "new"
    # again, but the persisted fired-marker must prevent a second real action.
    _stub_brief([inc], monkeypatch)
    filed3 = asyncio.run(watch_officer.run_once())
    # A brief may legitimately re-file (operator should still see it again),
    # but the action must NOT re-fire.
    assert len(agent_calls) == 1, "agent must not re-fire for an already-fired incident"
    assert len(cue_calls) == 1, "cue must not re-fire for an already-fired incident"
    assert filed3 in (0, 1)


# ── check 4: per-cycle ceilings drop + log ────────────────────────────────────


def test_agent_run_cap_drops_and_logs(monkeypatch, caplog) -> None:
    _reset()
    agent_calls: list[Any] = []
    _stub_agent(monkeypatch, agent_calls)
    monkeypatch.setattr(watch_officer, "_MAX_AGENT_RUNS_PER_CYCLE", 1)

    from app.intel import promotion
    incs = [
        _incident("high", ["military"], 1.0, 1.0, "n1"),
        _incident("high", ["military"], 2.0, 2.0, "n2"),
    ]
    _wipe_ontology(*(promotion._stable_incident_id(i) for i in incs))
    _stub_brief(incs, monkeypatch)

    with caplog.at_level(logging.INFO, logger="app.watch_officer"):
        filed = asyncio.run(watch_officer.run_once())

    assert filed == 2  # both still get briefs filed
    assert len(agent_calls) == 1  # but only ONE agent run happened
    assert any("agent-run cap" in r.message for r in caplog.records)


def test_cue_cap_drops_and_logs(monkeypatch, caplog) -> None:
    _reset()
    agent_calls: list[Any] = []
    cue_calls: list[Any] = []
    _stub_agent(monkeypatch, agent_calls)
    _stub_cue(monkeypatch, cue_calls)
    monkeypatch.setattr(watch_officer, "_MAX_CUES_PER_CYCLE", 1)

    from app.intel import promotion
    incs = [
        _incident("elevated", ["dark-vessel"], 10.0, 10.0, "d1"),
        _incident("elevated", ["dark-vessel"], 11.0, 11.0, "d2"),
    ]
    _wipe_ontology(*(promotion._stable_incident_id(i) for i in incs))
    _stub_brief(incs, monkeypatch)

    with caplog.at_level(logging.INFO, logger="app.watch_officer"):
        filed = asyncio.run(watch_officer.run_once())

    assert filed == 2
    assert len(cue_calls) == 1
    assert any("cue cap" in r.message for r in caplog.records)


# ── 3d: a wedged run_once gets the loop restarted, not left frozen ───────────


def test_watchdog_restarts_wedged_loop(monkeypatch) -> None:
    _reset()
    monkeypatch.setattr(watch_officer, "_CYCLE_S", 0.02)
    monkeypatch.setattr(watch_officer, "_STALL_CYCLES", 1)

    hung = asyncio.Event()
    calls = {"n": 0}

    async def fake_run_once() -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            await hung.wait()  # never set — this call hangs forever
            return 0
        watch_officer._LAST_SWEEP_AT = __import__("time").time()
        return 0

    monkeypatch.setattr(watch_officer, "run_once", fake_run_once)

    async def _drive() -> None:
        await watch_officer.start()
        try:
            # Give the wedged first sweep a moment to start, then let the
            # supervisor (interval = _CYCLE_S = 0.02s) notice the stall
            # (age >= _CYCLE_S * _STALL_CYCLES) and restart the loop task.
            for _ in range(200):
                await asyncio.sleep(0.02)
                if calls["n"] >= 2:
                    break
        finally:
            await watch_officer.stop()

    asyncio.run(_drive())
    assert calls["n"] >= 2, "watchdog never restarted the wedged loop task"
