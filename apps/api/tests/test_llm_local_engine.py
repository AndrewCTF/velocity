"""app.llm's local-engine wiring (wave 2): engine resolution (auto→llamacpp/
ollama), the llamacpp/vllm chat rungs, tier="selection", and the invariant
that local_only()/prefer_local() never reach the cloud even with the new
rungs in the ladder. Hermetic: the sidecar modules and backend calls are all
monkeypatched — no subprocess, no network.
"""

from __future__ import annotations

from pathlib import Path

import httpx
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


# ── local_engine() resolution ────────────────────────────────────────────────


def test_local_engine_explicit_choice_passes_through() -> None:
    state.set_engine("vllm")
    assert llm.local_engine() == "vllm"
    state.set_engine("ollama")
    assert llm.local_engine() == "ollama"


def test_local_engine_auto_resolves_ollama_when_llamacpp_not_enableable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state.set_engine("auto")
    from app import llamacpp_sidecar

    monkeypatch.setattr(llamacpp_sidecar, "is_enabled", lambda: False)
    assert llm.local_engine() == "ollama"


def test_local_engine_auto_resolves_llamacpp_when_enableable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state.set_engine("auto")
    from app import llamacpp_sidecar

    monkeypatch.setattr(llamacpp_sidecar, "is_enabled", lambda: True)
    assert llm.local_engine() == "llamacpp"


# ── _llamacpp_chat ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_llamacpp_chat_no_key_is_an_error_not_a_raise() -> None:
    from app import llamacpp_sidecar

    llamacpp_sidecar._api_key = None
    res = await llm._llamacpp_chat(
        [{"role": "user", "content": "hi"}],
        role="main",
        temperature=0.2,
        max_tokens=100,
        timeout_s=5.0,
    )
    assert not res.ok
    assert res.backend == "llamacpp"
    assert "not running" in (res.error or "")


@pytest.mark.asyncio
async def test_llamacpp_chat_no_active_model_is_an_error(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import llamacpp_sidecar

    llamacpp_sidecar._api_key = "boot-key"
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
        )
    finally:
        llamacpp_sidecar._api_key = None
    assert not res.ok
    assert res.backend == "llamacpp"
    assert "no active" in (res.error or "")


@pytest.mark.asyncio
async def test_llamacpp_chat_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import llamacpp_sidecar

    key = _install()
    manager.set_active("main", key)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {
                "choices": [{"message": {"content": "hello from llamacpp"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4},
            }

    class _FakeClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json, headers):  # noqa: ANN001
            assert headers["Authorization"] == "Bearer boot-key-abc"
            # llama-server's --models-dir router ids each model by its on-disk
            # directory name, which the manager sets to the model key (verified
            # live against release b9964: GET /v1/models returns id == <key>).
            assert json["model"] == key
            return _FakeResp()

    monkeypatch.setattr(llm, "_client", lambda timeout: _FakeClient())
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert res.ok
    assert res.text == "hello from llamacpp"
    assert res.backend == "llamacpp"
    assert res.model == key


@pytest.mark.asyncio
async def test_llamacpp_chat_timeout_names_exception_class(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import llamacpp_sidecar

    key = _install()
    manager.set_active("main", key)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _RaisingClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, *a, **k):  # noqa: ANN002, ANN003
            raise httpx.ReadTimeout("")

    monkeypatch.setattr(llm, "_client", lambda timeout: _RaisingClient())
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert not res.ok
    assert res.error == "llamacpp call failed: ReadTimeout"


@pytest.mark.asyncio
async def test_llamacpp_chat_payload_disables_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    """The diagnosed bug: recommended local models (Qwen3.5-9B et al.) are
    reasoning models that emit thinking tokens first, so a short max_tokens
    budget can finish with content="". Both no-think request fields must be
    sent on every llamacpp call — llama-server's own docs name
    ``chat_template_kwargs: {"enable_thinking": false}`` for this;
    ``reasoning_effort`` additionally covers gpt-oss/harmony templates."""
    from app import llamacpp_sidecar

    key = _install()
    manager.set_active("main", key)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {"choices": [{"message": {"content": "ok"}}], "usage": {}}

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
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert res.ok
    assert captured["payload"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert captured["payload"]["reasoning_effort"] == "low"


@pytest.mark.asyncio
async def test_llamacpp_chat_strips_think_block_from_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Some chat templates emit the thinking block INTO ``content`` instead of
    a separate channel — the returned text must be the post-thinking answer,
    not the raw (still-empty-looking-to-callers) blob."""
    from app import llamacpp_sidecar

    key = _install()
    manager.set_active("main", key)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": "<think>reasoning...</think>The real answer."},
                    }
                ],
                "usage": {},
            }

    class _FakeClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json, headers):  # noqa: ANN001
            return _FakeResp()

    monkeypatch.setattr(llm, "_client", lambda timeout: _FakeClient())
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=50,
            timeout_s=5.0,
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert res.ok
    assert res.text == "The real answer."


@pytest.mark.asyncio
async def test_llamacpp_chat_pure_think_and_length_is_descriptive_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The exact bug this branch fixes: a short max_tokens budget is entirely
    consumed by the thinking preamble — finish_reason="length", content is
    either "" or thinking-only. `res.ok` must be False (unchanged behavior —
    the fallback ladder still kicks in) but the error must say WHY instead of
    the generic "empty content" message, so it's diagnosable."""
    from app import llamacpp_sidecar

    key = _install()
    manager.set_active("main", key)
    llamacpp_sidecar._api_key = "boot-key-abc"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {
                "choices": [
                    {
                        "finish_reason": "length",
                        "message": {"content": "<think>still going and never finished"},
                    }
                ],
                "usage": {"completion_tokens": 50},
            }

    class _FakeClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json, headers):  # noqa: ANN001
            return _FakeResp()

    monkeypatch.setattr(llm, "_client", lambda timeout: _FakeClient())
    try:
        res = await llm._llamacpp_chat(
            [{"role": "user", "content": "hi"}],
            role="main",
            temperature=0.2,
            max_tokens=50,
            timeout_s=5.0,
        )
    finally:
        llamacpp_sidecar._api_key = None

    assert not res.ok
    assert res.text is None
    assert res.error is not None
    assert "exhausted token budget" in res.error
    assert "raise max_tokens or use a non-reasoning model" in res.error


# ── _vllm_chat ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_vllm_chat_payload_disables_thinking(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import vllm_sidecar

    vllm_sidecar._api_key = "vllm-boot-key"
    vllm_sidecar._served_model_key = "abc123"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {"choices": [{"message": {"content": "ok"}}], "usage": {}}

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
        res = await llm._vllm_chat(
            [{"role": "user", "content": "hi"}],
            temperature=0.2,
            max_tokens=100,
            timeout_s=5.0,
        )
    finally:
        vllm_sidecar._api_key = None
        vllm_sidecar._served_model_key = None

    assert res.ok
    assert captured["payload"]["chat_template_kwargs"] == {"enable_thinking": False}
    assert captured["payload"]["reasoning_effort"] == "low"


@pytest.mark.asyncio
async def test_vllm_chat_pure_think_and_length_is_descriptive_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app import vllm_sidecar

    vllm_sidecar._api_key = "vllm-boot-key"
    vllm_sidecar._served_model_key = "abc123"

    class _FakeResp:
        status_code = 200

        def json(self):  # noqa: ANN202
            return {
                "choices": [
                    {"finish_reason": "length", "message": {"content": "<think>never finished"}}
                ],
                "usage": {},
            }

    class _FakeClient:
        async def __aenter__(self):  # noqa: ANN204
            return self

        async def __aexit__(self, *a):  # noqa: ANN002
            return False

        async def post(self, url, json, headers):  # noqa: ANN001
            return _FakeResp()

    monkeypatch.setattr(llm, "_client", lambda timeout: _FakeClient())
    try:
        res = await llm._vllm_chat(
            [{"role": "user", "content": "hi"}],
            temperature=0.2,
            max_tokens=50,
            timeout_s=5.0,
        )
    finally:
        vllm_sidecar._api_key = None
        vllm_sidecar._served_model_key = None

    assert not res.ok
    assert res.error is not None
    assert "exhausted token budget" in res.error


# ── tier="selection" ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_selection_tier_falls_back_to_fast_when_unconfigured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No active "selection" model → tier="selection" must behave exactly like
    # "fast": same DeepSeek model id, and the local rung (if reached) targets
    # role="main", never "selection".
    assert llm.deepseek_model_for("selection") == llm.deepseek_model_for("fast")

    seen_role = {}

    async def fake_llamacpp_chat(messages, *, role, **kw):  # noqa: ANN001, ANN003
        seen_role["role"] = role
        return llm.LlmResult(text=None, backend="llamacpp", error="no sidecar")

    async def fake_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(text="ollama answer", backend="ollama")

    state.set_engine("llamacpp")
    monkeypatch.setattr(llm, "_llamacpp_chat", fake_llamacpp_chat)
    monkeypatch.setattr(llm, "_ollama_chat", fake_ollama)
    monkeypatch.setattr(llm, "deepseek_config", lambda: (None, "https://api.deepseek.com"))

    res = await llm.chat([{"role": "user", "content": "hi"}], tier="selection")
    assert res.ok
    assert seen_role["role"] == "main"


@pytest.mark.asyncio
async def test_selection_tier_targets_selection_role_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key = _install()
    manager.set_active("selection", key)

    seen_role = {}

    async def fake_llamacpp_chat(messages, *, role, **kw):  # noqa: ANN001, ANN003
        seen_role["role"] = role
        return llm.LlmResult(text="selection answer", backend="llamacpp", model="model.gguf")

    state.set_engine("llamacpp")
    monkeypatch.setattr(llm, "_llamacpp_chat", fake_llamacpp_chat)
    monkeypatch.setattr(llm, "deepseek_config", lambda: (None, "https://api.deepseek.com"))

    res = await llm.chat([{"role": "user", "content": "hi"}], tier="selection")
    assert res.ok
    assert seen_role["role"] == "selection"


# ── local_only()/prefer_local() never reach the cloud with the new rungs ────


@pytest.mark.asyncio
async def test_local_only_never_touches_cloud_via_llamacpp_rung(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    async def _fake_llamacpp(messages, *, role, **kw):  # noqa: ANN001, ANN003
        return llm.LlmResult(text="llamacpp answer", backend="llamacpp", model="model.gguf")

    state.set_engine("llamacpp")
    monkeypatch.setattr(llm, "_deepseek_chat", _fake_ds)
    monkeypatch.setattr(llm, "_minimax_chat", _fake_mm)
    monkeypatch.setattr(llm, "_llamacpp_chat", _fake_llamacpp)

    llm.set_local_only(True)
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.set_local_only(None)

    assert res.ok
    assert res.backend == "llamacpp"
    assert called["deepseek"] is False
    assert called["minimax"] is False


@pytest.mark.asyncio
async def test_local_only_falls_back_to_ollama_when_llamacpp_rung_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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

    async def _dead_llamacpp(messages, *, role, **kw):  # noqa: ANN001, ANN003
        return llm.LlmResult(text=None, backend="llamacpp", error="llamacpp sidecar not running")

    async def _ok_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(text="ollama fallback", backend="ollama")

    state.set_engine("llamacpp")
    monkeypatch.setattr(llm, "_deepseek_chat", _fake_ds)
    monkeypatch.setattr(llm, "_minimax_chat", _fake_mm)
    monkeypatch.setattr(llm, "_llamacpp_chat", _dead_llamacpp)
    monkeypatch.setattr(llm, "_ollama_chat", _ok_ollama)

    llm.set_local_only(True)
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.set_local_only(None)

    assert res.ok
    assert res.backend == "ollama"
    assert called["deepseek"] is False
    assert called["minimax"] is False


# ── the per-boot api key never appears in a route response ──────────────────


def test_ai_local_post_enabled_optional_selection_only(client) -> None:  # noqa: ANN001
    """The frontend's selection-inference toggle POSTs {selection_enabled,
    selection_model} with NO ``enabled`` field — it must not 422, and it must
    leave the local-first preference untouched (None → unchanged)."""
    llm.set_prefer_local(True)
    try:
        r = client.post(
            "/api/ai/local",
            json={"selection_enabled": True, "selection_model": ""},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["selection_enabled"] is True
        # `enabled` (local-first preference) was NOT in the body → left as True.
        assert body["enabled"] is True
    finally:
        llm.set_prefer_local(None)
        llm.set_selection_enabled(None)


def test_api_key_never_in_ai_local_or_ai_models_response(client) -> None:  # noqa: ANN001
    from app import llamacpp_sidecar, vllm_sidecar

    llamacpp_sidecar._api_key = "super-secret-llamacpp-key"
    vllm_sidecar._api_key = "super-secret-vllm-key"
    try:
        r1 = client.get("/api/ai/local")
        r2 = client.get("/api/ai/models")
        body = r1.text + r2.text
        assert "super-secret-llamacpp-key" not in body
        assert "super-secret-vllm-key" not in body
    finally:
        llamacpp_sidecar._api_key = None
        vllm_sidecar._api_key = None
