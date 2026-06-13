"""Unit tests for app.llm — no network.

Covers the pure helpers (JSONC comment stripping, JSON extraction, tier
mapping, opencode key discovery) and the DeepSeek→Ollama fallback wiring via
monkeypatched backends. Live DeepSeek calls are exercised by the manual
mcp_*_check drivers, never here.
"""

from __future__ import annotations

import json

import pytest

from app import llm


def test_strip_jsonc_preserves_urls_and_strips_comments() -> None:
    src = (
        "{\n // line comment with https://nope\n"
        ' "u": "https://api.deepseek.com", /* blk */ "k": 1,\n}'
    )
    out = json.loads(llm._strip_jsonc(src))
    assert out == {"u": "https://api.deepseek.com", "k": 1}


def test_strip_jsonc_keeps_double_slash_inside_string() -> None:
    out = json.loads(llm._strip_jsonc('{"path": "a//b//c"}'))
    assert out["path"] == "a//b//c"


def test_extract_json_handles_fences_and_prose() -> None:
    assert llm.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert llm.extract_json('here you go: {"a": [1,2], "b": 3} done') == {"a": [1, 2], "b": 3}
    assert llm.extract_json("[1, 2, 3]") == [1, 2, 3]
    assert llm.extract_json("not json at all") is None
    assert llm.extract_json("") is None


def test_tier_aliases_map_to_models() -> None:
    assert llm._resolve_tier("haiku") == "fast"
    assert llm._resolve_tier("sonnet") == "fast"
    assert llm._resolve_tier("opus") == "reason"
    assert llm._resolve_tier("deep") == "reason"
    assert llm._resolve_tier("anything-unknown") == "fast"
    assert llm.deepseek_model_for("opus") == "deepseek-reasoner"
    assert llm.deepseek_model_for("haiku") == "deepseek-chat"


def test_pick_ollama() -> None:
    assert llm._pick_ollama(["llama3:70b", "qwen2.5:3b"], "") == "qwen2.5:3b"
    assert llm._pick_ollama([], "") is None
    assert llm._pick_ollama(["a"], "phi3:mini") == "phi3:mini"


def test_opencode_deepseek_discovery(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = tmp_path / "opencode.jsonc"
    cfg.write_text(
        '{\n // comment\n "provider": { "deepseek": { "options": {\n'
        '   "baseURL": "https://api.deepseek.com", "apiKey": "sk-test-123" } } }\n}'
    )
    monkeypatch.setenv("OPENCODE_CONFIG", str(cfg))
    llm._opencode_deepseek.cache_clear()
    # No env override / settings key → resolves from the opencode file.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "")
    from app.config import get_settings

    get_settings.cache_clear()
    key, base = llm.deepseek_config()
    assert key == "sk-test-123"
    assert base == "https://api.deepseek.com"
    llm._opencode_deepseek.cache_clear()
    get_settings.cache_clear()


def test_deepseek_config_env_overrides_file(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = tmp_path / "missing.jsonc"  # absent → file path returns ("","")
    monkeypatch.setenv("OPENCODE_CONFIG", str(cfg))
    llm._opencode_deepseek.cache_clear()
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env-override")
    from app.config import get_settings

    get_settings.cache_clear()
    key, _ = llm.deepseek_config()
    assert key == "sk-env-override"
    llm._opencode_deepseek.cache_clear()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_chat_falls_back_to_ollama_when_deepseek_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm, "deepseek_config", lambda: (None, "https://api.deepseek.com"))

    async def _fake_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(text="local answer", model="qwen2.5:3b", backend="ollama")

    monkeypatch.setattr(llm, "_ollama_chat", _fake_ollama)
    res = await llm.chat([{"role": "user", "content": "hi"}], tier="fast")
    assert res.ok
    assert res.backend == "ollama"
    assert res.text == "local answer"


@pytest.mark.asyncio
async def test_chat_returns_error_when_all_backends_down(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm, "deepseek_config", lambda: (None, "https://api.deepseek.com"))

    async def _dead_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(text=None, backend="ollama", error="ollama unreachable")

    monkeypatch.setattr(llm, "_ollama_chat", _dead_ollama)
    res = await llm.chat([{"role": "user", "content": "hi"}])
    assert not res.ok
    assert res.text is None
    assert res.error


@pytest.mark.asyncio
async def test_chat_prefers_deepseek_when_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_ds(messages, *, model, temperature, max_tokens, timeout_s, json_mode):  # noqa: ANN001
        return llm.LlmResult(text="ds answer", model=model, backend="deepseek")

    called = {"ollama": False}

    async def _spy_ollama(*a, **k):  # noqa: ANN002, ANN003
        called["ollama"] = True
        return llm.LlmResult(text="should not be used", backend="ollama")

    monkeypatch.setattr(llm, "_deepseek_chat", _fake_ds)
    monkeypatch.setattr(llm, "_ollama_chat", _spy_ollama)
    res = await llm.chat([{"role": "user", "content": "hi"}], tier="reason")
    assert res.backend == "deepseek"
    assert res.text == "ds answer"
    assert called["ollama"] is False  # short-circuits on DeepSeek success
