"""``run_agent`` per-call budget + headless mode (Stage 2).

Watch-officer (Stage 3) drives ``run_agent`` from a background loop, which
diverges from the interactive /api/intel/agent route in three ways: it needs a
SMALLER wall budget than the interactive default (240s would blow through the
watch-officer's own 120s cycle), it has ALREADY computed this cycle's fused
brief and must not pay for a second ``incidents.brief()`` call, and it has no
operator to answer a ``request_clarification``. These tests are hermetic (the
LLM is a scripted fake, brief/news/history are stubbed) and prove: (1)
``max_steps`` actually bounds the gather loop, (2) ``seed_brief`` actually
skips the seed's ``incidents.brief()`` call, (3) the existing-style call
(no new kwargs) is untouched — still 6 steps / 240s — and (4) ``interactive``
gates ``request_clarification`` out of the catalog the same way ``with_actions``
gates the write-back tools.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

import pytest

from app.intel import agent
from app.intel.geo import BBox
from app.keys import UserCtx

# ── scripted-LLM fake (same shape as test_agent_actions.py's) ────────────────


class _FakeLlmResult:
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
    """Replace ``agent.llm.chat_json`` with a fake that returns ``turns`` in order,
    then a benign ``done`` forever once exhausted (so a synthesis call at the end
    never blows up). Records every call's kwargs so a test can tell a GATHER call
    (``fast=True``) from the SYNTHESIS call (``tier="reason"``) apart."""
    calls: list[dict] = []
    queue = list(turns)

    async def fake_chat_json(messages: list[dict], **kwargs: Any) -> tuple[Any, _FakeLlmResult]:
        calls.append({"messages": messages, **kwargs})
        obj = queue.pop(0) if queue else {"action": "done", "say": "done."}
        return obj, _FakeLlmResult(text="{}")

    monkeypatch.setattr(agent.llm, "chat_json", fake_chat_json)
    return calls


def _stub_seed(monkeypatch: pytest.MonkeyPatch, *, brief_calls: list[Any] | None = None) -> None:
    """Neutralise the agent's seed I/O so the loop is hermetic — no
    global_snapshot fetch, no news engine, no watch loop. If ``brief_calls`` is
    given, every ``incidents.brief`` call appends to it (so a test can assert
    it was never invoked when ``seed_brief`` was supplied instead)."""

    async def fake_brief(_bbox: BBox | None, **_k: Any) -> dict[str, Any]:
        if brief_calls is not None:
            brief_calls.append(_bbox)
        return {
            "incident_count": 0,
            "by_level": {},
            "top_threat_level": None,
            "signals_considered": 0,
            "incidents": [],
        }

    monkeypatch.setattr(agent.incidents, "brief", fake_brief)
    monkeypatch.setattr(agent, "_world_news", _disabled_news)
    monkeypatch.setattr(
        agent.incident_store, "last_changes", lambda _scope: {"had_baseline": False}
    )


async def _disabled_news() -> dict[str, Any]:
    return {"enabled": False, "note": "off"}


def _tool_call_events(events: list[dict[str, Any]], tool: str) -> list[dict[str, Any]]:
    return [e for e in events if e["type"] == "tool_call" and e.get("tool") == tool]


async def _drain(q: str, bbox: BBox | None, ctx: UserCtx | None, **kw: Any) -> list[dict[str, Any]]:
    """Run the agent to completion, collecting every emitted event."""
    return [ev async for ev in agent.run_agent(q, bbox, ctx, **kw)]


# ── check 1: max_steps bounds the gather loop ────────────────────────────────


def test_max_steps_bounds_the_gather_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_seed(monkeypatch)
    # control_view is a pure view-nudge tool — no dispatch, no live-data fetch —
    # so it's safe to call repeatedly in a hermetic test. Queue far MORE turns
    # than max_steps so the model is always "requesting another tool".
    calls = _script_llm(
        monkeypatch,
        [{"action": "tool", "tool": "control_view", "args": {}} for _ in range(5)],
    )

    events = asyncio.run(_drain("status check", None, UserCtx("u1", "tok"), max_steps=2))

    # Exactly 2 tool-calling steps reached the trace, not 5 and not the module
    # default of 6.
    assert len(_tool_call_events(events, "control_view")) == 2
    # And exactly 2 GATHER calls (fast=True) were made to the LLM — the 3rd
    # chat_json call on record, if any, is the synthesis call (tier="reason").
    gather_calls = [c for c in calls if c.get("fast")]
    assert len(gather_calls) == 2
    assert events[-1]["type"] == "done"


# ── check 2: seed_brief skips the seed's incidents.brief() call ──────────────


def test_seed_brief_skips_incidents_brief_call(monkeypatch: pytest.MonkeyPatch) -> None:
    brief_calls: list[Any] = []
    _stub_seed(monkeypatch, brief_calls=brief_calls)
    _script_llm(monkeypatch, [{"action": "done", "say": "ok"}])

    injected = {
        "incident_count": 3,
        "by_level": {"high": 1, "elevated": 2},
        "top_threat_level": "high",
        "signals_considered": 42,
        "incidents": [
            {
                "id": "inc-1",
                "threat_level": "high",
                "domains": ["dark-vessel"],
                "signal_count": 4,
                "centroid": {"lat": 1.0, "lon": 2.0},
                "narrative": "test convergence",
            }
        ],
    }

    events = asyncio.run(
        _drain("what changed", None, UserCtx("u1", "tok"), seed_brief=injected)
    )

    # incidents.brief() was NEVER called — the injected dict was used as-is.
    assert brief_calls == []
    # The seed still narrates + indexes the INJECTED brief (proves it was
    # actually threaded through, not silently dropped).
    tool_results = [
        e for e in events if e["type"] == "tool_result" and e.get("tool") == "intel_brief"
    ]
    assert len(tool_results) == 1
    assert "3 incidents" in tool_results[0]["summary"]
    narrations = [e for e in events if e["type"] == "narration" and e.get("step") == 0]
    assert narrations and "3 active convergence" in narrations[0]["text"]


# ── check 3: existing-style call keeps the old defaults ──────────────────────


def test_defaults_unchanged_for_existing_style_call(monkeypatch: pytest.MonkeyPatch) -> None:
    # The declared defaults are still exactly the module constants.
    sig = inspect.signature(agent.run_agent)
    assert sig.parameters["max_steps"].default == agent._MAX_STEPS == 6
    assert sig.parameters["wall_budget_s"].default == agent._WALL_BUDGET_S == 240.0

    _stub_seed(monkeypatch)
    # Queue MORE turns than the default step budget to prove the loop still
    # stops at 6, not fewer and not more, with no new kwargs passed at all —
    # the exact call shape routes/intel.py uses today.
    calls = _script_llm(
        monkeypatch,
        [{"action": "tool", "tool": "control_view", "args": {}} for _ in range(8)],
    )

    events = asyncio.run(_drain("status check", None, UserCtx("u1", "tok")))

    assert len(_tool_call_events(events, "control_view")) == 6
    gather_calls = [c for c in calls if c.get("fast")]
    assert len(gather_calls) == 6


# ── check 4: interactive=False gates request_clarification like with_actions ─


def test_interactive_false_hides_clarification_from_catalog() -> None:
    cat_interactive = agent._tool_catalog(with_actions=False, with_clarification=True)
    cat_headless = agent._tool_catalog(with_actions=False, with_clarification=False)
    assert "request_clarification" in cat_interactive
    assert "request_clarification" not in cat_headless
    # control_view is a view nudge, not a clarification — stays either way.
    assert "control_view" in cat_headless


def test_tool_catalog_default_keeps_clarification() -> None:
    # No with_clarification arg at all (the shape every existing caller uses) —
    # behaviour must be identical to before this change.
    assert "request_clarification" in agent._tool_catalog(with_actions=False)


def test_interactive_false_threads_through_to_tool_catalog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # End-to-end: run_agent(interactive=False) must actually call
    # _tool_catalog(with_clarification=False) — not just that the helper
    # supports the flag. (The static _SYS prose separately NAMES
    # request_clarification as a behaviour note; that's out of scope here —
    # see agent.py's docstring on why _SYS itself is untouched.)
    _stub_seed(monkeypatch)
    _script_llm(monkeypatch, [{"action": "done", "say": "ok"}])
    seen: list[dict[str, Any]] = []
    real_catalog = agent._tool_catalog

    def spy_catalog(*, with_actions: bool, with_clarification: bool = True) -> str:
        seen.append({"with_actions": with_actions, "with_clarification": with_clarification})
        return real_catalog(with_actions=with_actions, with_clarification=with_clarification)

    monkeypatch.setattr(agent, "_tool_catalog", spy_catalog)

    asyncio.run(_drain("status check", None, UserCtx("u1", "tok"), interactive=False))

    assert seen == [{"with_actions": True, "with_clarification": False}]
