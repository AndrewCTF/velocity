"""Unit tests for app.llm — no network.

Covers the pure helpers (JSONC comment stripping, JSON extraction, tier
mapping, opencode key discovery) and the DeepSeek→Ollama fallback wiring via
monkeypatched backends. Live DeepSeek calls are exercised by the manual
mcp_*_check drivers, never here.
"""

from __future__ import annotations

import json

import httpx
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


# ── _strip_thinking / _content_or_think_error ────────────────────────────────
# Some llama.cpp/vLLM chat templates emit a Qwen3-style thinking block INTO
# `message.content` instead of a separate `reasoning_content` channel. A short
# `max_tokens` budget then either empties `content` entirely (thinking ate the
# whole budget, finish_reason="length") or leaves ONLY the thinking block with
# no real answer. Both must be treated as "no usable answer", and the second
# case should say WHY instead of failing silently.


def test_strip_thinking_removes_leading_think_block() -> None:
    assert llm._strip_thinking("<think>reasoning about it...</think>Real answer") == "Real answer"


def test_strip_thinking_removes_thinking_spelling_and_multiline() -> None:
    text = "<thinking>\nstep 1\nstep 2\n</thinking>\n\nThe final answer is 42."
    assert llm._strip_thinking(text) == "The final answer is 42."


def test_strip_thinking_no_block_is_a_noop() -> None:
    assert llm._strip_thinking("just a plain answer") == "just a plain answer"


def test_strip_thinking_empty_string_is_a_noop() -> None:
    assert llm._strip_thinking("") == ""


def test_content_or_think_error_strips_and_returns_real_answer() -> None:
    body = {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {"content": "<think>hmm</think>Real answer"},
            }
        ]
    }
    text, error = llm._content_or_think_error(body, backend="llamacpp")
    assert text == "Real answer"
    assert error is None


def test_content_or_think_error_pure_think_and_length_is_descriptive_not_silent() -> None:
    # Entire max_tokens budget was spent thinking — content is ONLY the think
    # block, and finish_reason="length" confirms it ran out of room.
    body = {
        "choices": [
            {
                "finish_reason": "length",
                "message": {"content": "<think>still reasoning and never got to answer"},
            }
        ]
    }
    text, error = llm._content_or_think_error(body, backend="llamacpp")
    assert text is None
    assert error is not None
    assert "exhausted token budget" in error
    assert "length" in error


def test_content_or_think_error_empty_content_without_length_is_generic() -> None:
    body = {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]}
    text, error = llm._content_or_think_error(body, backend="vllm")
    assert text is None
    assert error == "vllm returned empty content"


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
    # No env key, but the opencode fallback is now OPT-IN (issue #10): it only
    # engages when DEEPSEEK_FROM_OPENCODE=1.
    monkeypatch.setenv("DEEPSEEK_API_KEY", "")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "")
    monkeypatch.setattr(llm, "_DEEPSEEK_SOURCE_LOGGED", False, raising=False)
    from app.config import get_settings

    # Flag OFF → the server must NOT read the opencode credential file.
    monkeypatch.setenv("DEEPSEEK_FROM_OPENCODE", "0")
    get_settings.cache_clear()
    key, _ = llm.deepseek_config()
    assert key is None

    # Flag ON → resolves the key + base from the opencode file.
    monkeypatch.setenv("DEEPSEEK_FROM_OPENCODE", "1")
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


# ── timeout errors are self-explanatory (a bare httpx timeout stringifies to
# "" — the raw f"...failed: {exc}" idiom then logs a blank message) ──────────


class _RaisingClient:
    """Async-context-manager httpx.AsyncClient stand-in whose post()/get() raise."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def __aenter__(self) -> _RaisingClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def post(self, *a: object, **k: object) -> None:
        raise self._exc

    async def get(self, *a: object, **k: object) -> None:
        raise self._exc


def test_exc_error_includes_class_name_for_empty_exception() -> None:
    # httpx.ReadTimeout() with no args stringifies to "" — the bug observed live.
    assert str(httpx.ReadTimeout("")) == ""
    msg = llm._exc_error("ollama call failed", httpx.ReadTimeout(""))
    assert msg == "ollama call failed: ReadTimeout"
    assert not msg.endswith(": ")
    # A message-bearing exception still keeps both the class name and the text.
    msg2 = llm._exc_error("ollama call failed", RuntimeError("boom"))
    assert msg2 == "ollama call failed: RuntimeError: boom"


@pytest.mark.asyncio
async def test_ollama_chat_timeout_error_names_exception_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fake_tags(host, timeout_s):  # noqa: ANN001
        return ["qwen2.5:3b"]

    monkeypatch.setattr(llm, "_ollama_tags", _fake_tags)
    monkeypatch.setattr(llm, "_client", lambda timeout: _RaisingClient(httpx.ReadTimeout("")))
    res = await llm._ollama_chat(
        [{"role": "user", "content": "hi"}], prefer_model="", temperature=0.2, timeout_s=5.0
    )
    assert not res.ok
    assert res.error == "ollama call failed: ReadTimeout"


@pytest.mark.asyncio
async def test_deepseek_chat_timeout_error_names_exception_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm, "deepseek_config", lambda: ("sk-test", "https://api.deepseek.com"))
    monkeypatch.setattr(llm, "_client", lambda timeout: _RaisingClient(httpx.ReadTimeout("")))
    res = await llm._deepseek_chat(
        [{"role": "user", "content": "hi"}],
        model="deepseek-chat",
        temperature=0.2,
        max_tokens=100,
        timeout_s=5.0,
        json_mode=False,
    )
    assert not res.ok
    assert res.error == "deepseek call failed: ReadTimeout"


@pytest.mark.asyncio
async def test_minimax_chat_timeout_error_names_exception_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        llm, "minimax_config", lambda: ("nvapi-test", "https://integrate.api.nvidia.com/v1", "m")
    )
    monkeypatch.setattr(llm, "_client", lambda timeout: _RaisingClient(httpx.ReadTimeout("")))
    res = await llm._minimax_chat(
        [{"role": "user", "content": "hi"}], temperature=0.2, max_tokens=100, timeout_s=5.0
    )
    assert not res.ok
    assert res.error == "minimax call failed: ReadTimeout"


# ── strict local-only mode (LLM_LOCAL_ONLY / POST /api/ai/local local_only) ──


@pytest.mark.asyncio
async def test_local_only_short_circuits_to_ollama_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm, "minimax_config", lambda: ("nvapi-test", "https://integrate.api.nvidia.com/v1", "m")
    )
    called = {"deepseek": False, "minimax": False}

    async def _fake_ds(*a, **k):  # noqa: ANN002, ANN003
        called["deepseek"] = True
        return llm.LlmResult(text="ds", backend="deepseek")

    async def _fake_mm(*a, **k):  # noqa: ANN002, ANN003
        called["minimax"] = True
        return llm.LlmResult(text="mm", backend="minimax")

    async def _fail_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(
            text=None, backend="ollama", error="ollama call failed: ReadTimeout"
        )

    monkeypatch.setattr(llm, "_deepseek_chat", _fake_ds)
    monkeypatch.setattr(llm, "_minimax_chat", _fake_mm)
    monkeypatch.setattr(llm, "_ollama_chat", _fail_ollama)

    llm.set_local_only(True)
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.set_local_only(None)

    assert not res.ok
    assert res.backend == "ollama"
    assert res.error == "ollama call failed: ReadTimeout"
    assert called["deepseek"] is False
    assert called["minimax"] is False


def test_local_only_defers_to_settings_when_no_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import Settings

    llm.set_local_only(None)
    monkeypatch.setattr(llm, "get_settings", lambda: Settings(llm_local_only=True))
    assert llm.local_only() is True
    monkeypatch.setattr(llm, "get_settings", lambda: Settings(llm_local_only=False))
    assert llm.local_only() is False


def test_ai_local_toggle_round_trips_local_only(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _fake_tags(host, timeout_s):  # noqa: ANN001
        return []

    monkeypatch.setattr(llm, "_ollama_tags", _fake_tags)
    try:
        r = client.post("/api/ai/local", json={"enabled": False, "local_only": True})
        assert r.status_code == 200
        assert r.json()["local_only"] is True

        r2 = client.get("/api/ai/local")
        assert r2.json()["local_only"] is True

        # None leaves the flag unchanged.
        r3 = client.post("/api/ai/local", json={"enabled": False})
        assert r3.json()["local_only"] is True

        r4 = client.post("/api/ai/local", json={"enabled": False, "local_only": False})
        assert r4.json()["local_only"] is False
    finally:
        llm.set_local_only(None)
        llm.set_prefer_local(None)
