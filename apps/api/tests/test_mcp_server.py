"""MCP server degradation + helper tests — no network (dead ports refuse fast).

Proves the server never crashes a tool call when the backend or Ollama is
absent: it returns a structured, agent-readable error/fallback instead.
"""

from __future__ import annotations

import pytest

from app import llm
from app import mcp_server as M

_DEAD = "http://127.0.0.1:9"  # discard port — refuses connection immediately


@pytest.fixture(autouse=True)
def _no_autostart(monkeypatch: pytest.MonkeyPatch) -> None:
    # Never spawn a real uvicorn from the test process (would block on the
    # auto-start health wait). The auto-start path is exercised live, not here.
    monkeypatch.setenv("OSINT_MCP_NO_AUTOSTART", "1")
    # Reset the module's spawn/ready latches between tests.
    M._BACKEND_READY = False
    M._BACKEND_PROC = None


@pytest.mark.asyncio
async def test_backend_unreachable_returns_structured_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("API_BASE", _DEAD)
    out = await M.get_situation()
    assert out["error"] == "backend_unreachable"
    assert "hint" in out  # tells the agent how to start the backend


def test_pick_ollama_prefers_small() -> None:
    assert llm._pick_ollama(["llama3:70b", "qwen2.5:3b"], "") == "qwen2.5:3b"
    moe = "qwen3-coder:30b-a3b-q4_K_M"
    assert llm._pick_ollama(["mistral:7b", moe], "") == moe
    assert llm._pick_ollama([], "") is None
    # explicit prefer that isn't installed → still returned (let Ollama resolve)
    assert llm._pick_ollama(["a", "b"], "phi3:mini") == "phi3:mini"
    # explicit prefer that matches by prefix
    assert llm._pick_ollama(["qwen2.5:3b-instruct"], "qwen2.5:3b") == "qwen2.5:3b-instruct"


@pytest.mark.asyncio
async def test_deep_analyze_degrades_without_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("API_BASE", _DEAD)
    monkeypatch.setenv("OLLAMA_HOST", _DEAD)
    # Neutralise DeepSeek so the tool genuinely has no backend (no network).
    monkeypatch.setattr(llm, "deepseek_config", lambda: (None, "https://api.deepseek.com"))
    out = await M.deep_analyze("any question")
    # No model reachable → analysis is None but the gathered data is returned
    # so the calling agent can still reason over it itself.
    assert out["analysis"] is None
    assert "data" in out
    assert "note" in out


@pytest.mark.asyncio
async def test_ollama_tags_empty_on_dead_host() -> None:
    assert await llm._ollama_tags(_DEAD, 2.0) == []
