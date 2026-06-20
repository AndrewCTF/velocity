"""/api/sim/reason — the handler shapes the model output and degrades cleanly.

We call the handler directly with the LLM mocked so the test needs neither a
live model nor the auth middleware.
"""

from __future__ import annotations

import asyncio

from app import llm
from app.routes import simulation as sim


def test_sim_reason_ok(monkeypatch):
    async def fake_chat_json(messages, **kwargs):
        assert kwargs.get("tier") == "reason"
        return (
            {"assessment": "Defence holds; few leakers.", "outcomes": [], "confidence": "low"},
            llm.LlmResult(text="{}", model="mock-reasoner", backend="mock"),
        )

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    req = sim.SimReasonRequest(scenario={"kind": "attack"}, outcome={"leakers": 3})
    out = asyncio.run(sim.sim_reason(req))

    assert out["ok"] is True
    assert out["assessment"].startswith("Defence holds")
    assert out["model"] == "mock-reasoner"
    assert out["confidence"] == "low"


def test_sim_reason_fast_tier(monkeypatch):
    seen: dict[str, object] = {}

    async def fake_chat_json(messages, **kwargs):
        seen.update(kwargs)
        return (
            {"assessment": "Quick look.", "outcomes": [], "confidence": "low"},
            llm.LlmResult(text="{}", model="deepseek-chat", backend="deepseek"),
        )

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    req = sim.SimReasonRequest(scenario={"kind": "attack"}, outcome={"leakers": 3}, fast=True)
    out = asyncio.run(sim.sim_reason(req))

    # fast=True selects the cheaper chat tier AND passes fast through so the
    # llm layer skips the slow MiniMax-M3 reasoner entirely.
    assert seen.get("tier") == "fast"
    assert seen.get("fast") is True
    assert out["ok"] is True
    assert out["model"] == "deepseek-chat"


def test_sim_reason_default_is_reason_tier(monkeypatch):
    seen: dict[str, object] = {}

    async def fake_chat_json(messages, **kwargs):
        seen.update(kwargs)
        return (
            {"assessment": "Deep pass.", "outcomes": [], "confidence": "medium"},
            llm.LlmResult(text="{}", model="mock-reasoner", backend="mock"),
        )

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    out = asyncio.run(sim.sim_reason(sim.SimReasonRequest(outcome={"leakers": 1})))

    # No fast flag → full reasoner path (the existing behaviour).
    assert seen.get("tier") == "reason"
    assert seen.get("fast") is False
    assert out["ok"] is True


def test_sim_reason_model_unavailable(monkeypatch):
    async def fake_chat_json(messages, **kwargs):
        return (None, llm.LlmResult(text=None, error="upstream 503"))

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    out = asyncio.run(sim.sim_reason(sim.SimReasonRequest()))

    assert out["ok"] is False
    assert "upstream 503" in out["error"]


def test_sim_reason_non_json(monkeypatch):
    async def fake_chat_json(messages, **kwargs):
        return (None, llm.LlmResult(text="sorry, no json here", model="mock"))

    monkeypatch.setattr(llm, "chat_json", fake_chat_json)
    out = asyncio.run(sim.sim_reason(sim.SimReasonRequest()))

    assert out["ok"] is False
    assert "raw" in out
