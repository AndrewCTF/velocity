"""Agent write-back + app control (Track C6) — hermetic unit tests.

The streaming analyst agent (``intel/agent.py``) gained three ADDITIVE tool
families on top of its read-only ReAct loop:

  • AUDITED write-back actions (flag_entity / promote_incident / nominate_target /
    add_watch) that dispatch through ``intel/actions.dispatch`` — the SAME path
    /api/actions uses, so every write lands an ``action_log`` audit row.
  • a ``control_view`` tool that emits a NEW ``app_var`` SSE event driving the
    operator's map (camera / selection / filter).
  • a ``request_clarification`` tool that pauses the loop for the operator.

These tests are fully hermetic: the LLM is replaced by a SCRIPTED fake (no
network, no MiniMax/DeepSeek/Ollama), the brief seed + news + history are
stubbed, and ``actions.dispatch`` is mocked so no Supabase is touched. They
prove (a) an action tool actually dispatches + the audit flows back as an
``action`` event, and (b) ``control_view`` emits an ``app_var`` event — plus the
keyless-gate, clarification-stop, and the pure control→app_var translation.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.intel import agent
from app.intel.actions import ActionResult
from app.intel.geo import BBox
from app.keys import UserCtx

# ── scripted-LLM fake ───────────────────────────────────────────────────────────


class _FakeLlmResult:
    """Mimics ``llm.LlmResult`` enough for the agent: ``ok`` + ``usage`` +
    ``backend``/``model``/``error``."""

    def __init__(self, text: str | None) -> None:
        self.text = text
        self.usage: dict[str, Any] = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        self.backend = "fake"
        self.model = "fake/scripted"
        self.error = None

    @property
    def ok(self) -> bool:
        return bool(self.text)


def _script_llm(monkeypatch: pytest.MonkeyPatch, turns: list[dict[str, Any]]) -> list[dict]:
    """Replace ``agent.llm.chat_json`` with a fake that returns ``turns`` in order.

    Each entry is the JSON object the model would emit (a tool call / done /
    final). After the list is exhausted it returns a benign ``done`` so the loop
    and synthesis always terminate. Returns a list that records the kwargs of
    every call (so a test can assert synthesis was / was not invoked)."""
    calls: list[dict] = []
    queue = list(turns)

    async def fake_chat_json(messages: list[dict], **kwargs: Any) -> tuple[Any, _FakeLlmResult]:
        calls.append({"messages": messages, **kwargs})
        if queue:
            obj = queue.pop(0)
        else:
            obj = {"action": "done", "say": "done."}
        return obj, _FakeLlmResult(text="{}")

    monkeypatch.setattr(agent.llm, "chat_json", fake_chat_json)
    return calls


def _stub_seed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Neutralise the agent's seed I/O (brief / news / history) so the loop is
    hermetic — no global_snapshot fetch, no news engine, no watch loop."""

    async def fake_brief(_bbox: BBox | None, **_k: Any) -> dict[str, Any]:
        return {
            "incident_count": 0,
            "by_level": {},
            "top_threat_level": None,
            "signals_considered": 0,
            "incidents": [],
        }

    monkeypatch.setattr(agent.incidents, "brief", fake_brief)
    # _world_news takes no args; patch it to the disabled shape (a fresh coroutine
    # each call so a re-await never raises "cannot reuse already awaited").
    monkeypatch.setattr(agent, "_world_news", _disabled_news)
    monkeypatch.setattr(
        agent.incident_store, "last_changes", lambda _scope: {"had_baseline": False}
    )


async def _disabled_news() -> dict[str, Any]:
    return {"enabled": False, "note": "off"}


async def _drain(q: str, bbox: BBox | None, ctx: UserCtx | None) -> list[dict[str, Any]]:
    """Run the agent to completion, collecting every emitted event."""
    return [ev async for ev in agent.run_agent(q, bbox, ctx)]


# ── pure unit: control → app_var translation ────────────────────────────────────


def test_app_var_translation_passes_valid_fields() -> None:
    out = agent._app_var_from_control(
        {
            "fly_to": {"lat": 26.5, "lon": 56.3, "alt_m": 200_000},
            "select": "vessel:636092000",
            "filter": {"facet": "vesselType", "value": "tanker", "mode": "only"},
        }
    )
    assert out is not None
    assert out["fly_to"] == {"lat": 26.5, "lon": 56.3, "alt_m": 200_000.0}
    assert out["select"] == "vessel:636092000"
    assert out["filter"] == {"facet": "vesselType", "value": "tanker", "mode": "only"}


def test_app_var_translation_rejects_bad_coords_and_facets() -> None:
    # Out-of-range lat/lon dropped; unknown facet dropped; clear honoured.
    assert agent._app_var_from_control({"fly_to": {"lat": 999, "lon": 0}}) is None
    assert agent._app_var_from_control({"filter": {"facet": "nope", "value": "x"}}) is None
    cleared = agent._app_var_from_control({"filter": {"clear": True}})
    assert cleared == {"filter": {"clear": True}}
    # Nothing actionable → None (so the loop emits no app_var).
    assert agent._app_var_from_control({}) is None


def test_app_var_clamps_altitude() -> None:
    out = agent._app_var_from_control({"fly_to": {"lat": 0, "lon": 0, "alt_m": 1}})
    assert out is not None
    assert out["fly_to"]["alt_m"] == 1000.0  # clamped up to the floor


def test_filter_mode_defaults_to_only_and_normalises() -> None:
    out = agent._app_var_from_control({"filter": {"facet": "squawk", "value": "7700"}})
    assert out is not None and out["filter"]["mode"] == "only"
    out2 = agent._app_var_from_control(
        {"filter": {"facet": "squawk", "value": "7700", "mode": "garbage"}}
    )
    assert out2 is not None and out2["filter"]["mode"] == "only"  # unknown → only


# ── catalog gating ───────────────────────────────────────────────────────────────


def test_catalog_hides_actions_without_user() -> None:
    cat = agent._tool_catalog(with_actions=False)
    assert "control_view" in cat and "request_clarification" in cat
    assert "flag_entity" not in cat and "nominate_target" not in cat


def test_catalog_shows_actions_with_user() -> None:
    cat = agent._tool_catalog(with_actions=True)
    for name in ("flag_entity", "promote_incident", "nominate_target", "add_watch"):
        assert name in cat


# ── action tool dispatches + audit flows back ───────────────────────────────────


def test_action_tool_dispatches_and_emits_action_event(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    # Drive the model: call flag_entity, then stop.
    _script_llm(
        monkeypatch,
        [
            {
                "action": "tool",
                "tool": "flag_entity",
                "args": {"target_id": "aircraft:abc", "note": "loitering", "severity": 4},
                "say": "Flagging it.",
            },
            {"action": "done", "say": "Done."},
        ],
    )

    dispatched: list[tuple[str, dict, UserCtx]] = []

    async def fake_dispatch(
        name: str, params: dict, ctx: UserCtx, settings: Any = None
    ) -> ActionResult:
        dispatched.append((name, params, ctx))
        audit = {
            "user_id": ctx.user_id,
            "action": name,
            "target_id": params["target_id"],
            "params": params,
            "ts": "2026-06-21T00:00:00Z",
        }
        return ActionResult(
            action=name, target_id=params["target_id"], audit=audit, detail={"object": {}}
        )

    monkeypatch.setattr(agent.actions, "dispatch", fake_dispatch)

    events = asyncio.run(_drain("flag aircraft abc as loitering", None, UserCtx("u1", "tok")))

    # The action actually dispatched, with the agent's user ctx (audit-of-who).
    assert len(dispatched) == 1
    name, params, ctx = dispatched[0]
    assert name == "flag_entity"
    assert params == {"target_id": "aircraft:abc", "note": "loitering", "severity": 4}
    assert ctx.user_id == "u1"

    # An `action` event carrying the audit row reached the stream.
    actions_ev = [e for e in events if e["type"] == "action"]
    assert len(actions_ev) == 1
    assert actions_ev[0]["ok"] is True
    assert actions_ev[0]["action"] == "flag_entity"
    assert actions_ev[0]["target_id"] == "aircraft:abc"
    assert actions_ev[0]["audit"]["user_id"] == "u1"  # WHO is audited
    # And it's also reflected as a tool_result line in the trace.
    assert any(e["type"] == "tool_result" and e.get("tool") == "flag_entity" for e in events)


def test_action_failure_is_reported_not_crashing(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    _script_llm(
        monkeypatch,
        [
            {
                "action": "tool",
                "tool": "nominate_target",
                "args": {"target_id": "vessel:1", "priority": 1},
            },
            {"action": "done"},
        ],
    )

    from fastapi import HTTPException

    async def boom(*_a: Any, **_k: Any) -> ActionResult:
        raise HTTPException(status_code=503, detail="Supabase is not configured")

    monkeypatch.setattr(agent.actions, "dispatch", boom)

    events = asyncio.run(_drain("nominate vessel 1", None, UserCtx("u1", "tok")))
    fail = [e for e in events if e["type"] == "action" and e["ok"] is False]
    assert len(fail) == 1
    assert "Supabase is not configured" in fail[0]["error"]
    # The stream still finished cleanly with a final + done.
    assert any(e["type"] == "final" for e in events)
    assert events[-1]["type"] == "done"


# ── control_view emits app_var ───────────────────────────────────────────────────


def test_control_view_emits_app_var(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    _script_llm(
        monkeypatch,
        [
            {
                "action": "tool",
                "tool": "control_view",
                "args": {
                    "fly_to": {"lat": 26.5, "lon": 56.3},
                    "select": "vessel:636092000",
                    "filter": {"facet": "vesselType", "value": "tanker", "mode": "only"},
                },
                "say": "Pointing the map at it.",
            },
            {"action": "done", "say": "There."},
        ],
    )
    # control_view does NOT need the action store; no dispatch should fire.
    called = []
    monkeypatch.setattr(
        agent.actions, "dispatch", lambda *a, **k: called.append(a)  # type: ignore[arg-type]
    )

    events = asyncio.run(_drain("show me the tanker", None, UserCtx("u1", "tok")))

    app_vars = [e for e in events if e["type"] == "app_var"]
    assert len(app_vars) == 1
    av = app_vars[0]
    assert av["fly_to"] == {"lat": 26.5, "lon": 56.3}
    assert av["select"] == "vessel:636092000"
    assert av["filter"] == {"facet": "vesselType", "value": "tanker", "mode": "only"}
    # control_view is a view nudge, not a write-back.
    assert called == []


def test_control_view_works_keyless(monkeypatch: pytest.MonkeyPatch) -> None:
    # A keyless run (ctx=None) still gets control tools — only write-backs are gated.
    _stub_seed(monkeypatch)
    _script_llm(
        monkeypatch,
        [
            {"action": "tool", "tool": "control_view", "args": {"fly_to": {"lat": 0, "lon": 0}}},
            {"action": "done"},
        ],
    )
    events = asyncio.run(_drain("center on null island", None, None))
    assert any(e["type"] == "app_var" for e in events)


# ── request_clarification stops the loop ─────────────────────────────────────────


def test_request_clarification_stops_before_synthesis(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    calls = _script_llm(
        monkeypatch,
        [
            {
                "action": "tool",
                "tool": "request_clarification",
                "args": {"question": "Which flight?", "options": ["KLM589", "KL589"]},
            },
            # This 'done' should NEVER be consumed — the loop returns at clarification.
            {"action": "done", "say": "should not reach"},
        ],
    )

    events = asyncio.run(_drain("where is the flight", None, UserCtx("u1", "tok")))

    clar = [e for e in events if e["type"] == "clarification"]
    assert len(clar) == 1
    assert clar[0]["question"] == "Which flight?"
    assert clar[0]["options"] == ["KLM589", "KL589"]
    # The run ends on a done flagged awaiting_clarification — and NO synthesis.
    assert events[-1]["type"] == "done"
    assert events[-1].get("awaiting_clarification") is True
    assert not any(e["type"] == "synthesizing" for e in events)
    # Exactly ONE LLM call (the single gather turn) — synthesis never ran.
    assert len(calls) == 1


# ── keyless write-back is refused, not dispatched ────────────────────────────────


def test_keyless_action_call_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    # Even if the model (wrongly) calls a write-back with no user, it must NOT
    # dispatch — it gets a sign-in-required observation instead.
    _script_llm(
        monkeypatch,
        [
            {
                "action": "tool",
                "tool": "flag_entity",
                "args": {"target_id": "aircraft:abc"},
            },
            {"action": "done"},
        ],
    )
    dispatched = []
    monkeypatch.setattr(
        agent.actions, "dispatch", lambda *a, **k: dispatched.append(a)  # type: ignore[arg-type]
    )

    events = asyncio.run(_drain("flag it", None, None))

    # No dispatch happened.
    assert dispatched == []
    # The tool_result told the model sign-in is required.
    tr = [e for e in events if e["type"] == "tool_result" and e.get("tool") == "flag_entity"]
    assert len(tr) == 1
    assert "sign-in required" in tr[0]["summary"]
    # No `action` event (nothing was performed).
    assert not any(e["type"] == "action" for e in events)
