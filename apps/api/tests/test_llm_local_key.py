"""app.llm's multi-model targeting (A2): `chat(local_model_key=...)` forces a
completion onto a SPECIFIC installed llama.cpp model by install key, bypassing
tier/role resolution and the tier/prefer_local/cloud ladder entirely — a
verifier call in the news-verification ensemble must never silently land on a
different model or fall through to a cloud backend. Hermetic: the sidecar
module and backend calls are all monkeypatched — no subprocess, no network.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import llm
from app.localllm import manager, state


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path):
    manager.override_models_dir(str(tmp_path / "models"))
    manager._JOBS.clear()
    state.set_engine(None)
    llm.set_prefer_local(None)
    llm.set_local_only(None)
    llm.set_selection_enabled(None)
    yield
    manager.override_models_dir(None)
    manager._JOBS.clear()
    state.set_engine(None)
    llm.set_prefer_local(None)
    llm.set_local_only(None)
    llm.set_selection_enabled(None)


def _install(repo_id: str = "unsloth/Qwen3.5-9B-GGUF", quant: str = "UD-Q4_K_XL") -> str:
    key = manager.key_for(repo_id, quant)
    root = manager.models_root()
    target = root / key
    target.mkdir(parents=True, exist_ok=True)
    (target / "model.gguf").write_bytes(b"fake-weights")
    manager._write_metadata(target, key, repo_id, quant, size_bytes=12)
    return key


# ── _llamacpp_chat(model_key=...) ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_llamacpp_chat_model_key_installed_uses_it_as_payload_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import llamacpp_sidecar

    key_a = _install("unsloth/Qwen3.5-9B-GGUF", "UD-Q4_K_XL")
    key_b = _install("unsloth/Llama-3.1-8B-GGUF", "UD-Q4_K_XL")
    # Active "main" is a DIFFERENT model than the one we target by key — proves
    # model_key bypasses role resolution rather than merely matching it.
    manager.set_active("main", key_a)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {"choices": [{"message": {"content": "hi"}}], "usage": {}}

    captured = {}

    class _FakeClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json, headers):  # noqa: ANN001
            captured["payload"] = json
            return _FakeResp()

    monkeypatch.setattr(llm, "_client", lambda timeout: _FakeClient())
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
            model_key=key_b,
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert res.ok
    assert res.model == key_b
    assert captured["payload"]["model"] == key_b


@pytest.mark.asyncio
async def test_llamacpp_chat_model_key_not_installed_is_an_error() -> None:
    from app import llamacpp_sidecar

    llamacpp_sidecar._api_key = "boot-key-abc"
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
            model_key="not-a-real-key",
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert not res.ok
    assert res.backend == "llamacpp"
    assert res.error == "model 'not-a-real-key' not installed"


# ── chat(local_model_key=...) ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_local_model_key_routes_llamacpp_with_that_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = _install()
    state.set_engine("llamacpp")

    seen = {}

    async def fake_llamacpp_chat(messages, *, role, model_key=None, **kw):  # noqa: ANN001, ANN003
        seen["role"] = role
        seen["model_key"] = model_key
        return llm.LlmResult(text="verifier says X", backend="llamacpp", model=model_key)

    monkeypatch.setattr(llm, "_llamacpp_chat", fake_llamacpp_chat)

    res = await llm.chat([{"role": "user", "content": "verify this"}], local_model_key=key)

    assert res.ok
    assert res.model == key
    assert seen["model_key"] == key


@pytest.mark.asyncio
async def test_chat_local_model_key_not_installed_no_cloud_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state.set_engine("llamacpp")
    from app import llamacpp_sidecar

    llamacpp_sidecar._api_key = "boot-key-abc"

    async def _fail_if_called(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("cloud backend must not be called for local_model_key")

    monkeypatch.setattr(llm, "_deepseek_chat", _fail_if_called)
    monkeypatch.setattr(llm, "_minimax_chat", _fail_if_called)
    monkeypatch.setattr(llm, "_ollama_chat", _fail_if_called)
    monkeypatch.setattr(
        llm, "minimax_config", lambda: ("nvapi-test", "https://integrate.api.nvidia.com/v1", "m")
    )

    try:
        res = await llm.chat(
            [{"role": "user", "content": "verify this"}], local_model_key="ghost-key"
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert not res.ok
    assert res.backend == "llamacpp"
    assert "not installed" in (res.error or "")


@pytest.mark.asyncio
async def test_chat_local_model_key_engine_ollama_is_descriptive_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state.set_engine("ollama")

    async def _fail_if_called(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not guess vllm/ollama semantics")

    monkeypatch.setattr(llm, "_ollama_chat", _fail_if_called)
    monkeypatch.setattr(llm, "_deepseek_chat", _fail_if_called)
    monkeypatch.setattr(llm, "_minimax_chat", _fail_if_called)

    res = await llm.chat(
        [{"role": "user", "content": "verify this"}], local_model_key="some-key"
    )

    assert not res.ok
    assert res.backend == "ollama"
    assert "llamacpp" in (res.error or "")


@pytest.mark.asyncio
async def test_chat_local_model_key_engine_vllm_is_descriptive_error() -> None:
    state.set_engine("vllm")

    res = await llm.chat(
        [{"role": "user", "content": "verify this"}], local_model_key="some-key"
    )

    assert not res.ok
    assert res.backend == "vllm"
    assert "llamacpp" in (res.error or "")


# ── chat_json passes the kwarg through ───────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_json_passes_local_model_key_through(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {}

    async def fake_chat(messages, **kw):  # noqa: ANN001, ANN003
        seen.update(kw)
        return llm.LlmResult(text='{"ok": true}', backend="llamacpp")

    monkeypatch.setattr(llm, "chat", fake_chat)

    parsed, res = await llm.chat_json(
        [{"role": "user", "content": "verify"}], local_model_key="my-key"
    )

    assert res.ok
    assert parsed == {"ok": True}
    assert seen["local_model_key"] == "my-key"
