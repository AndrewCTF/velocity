"""Unit tests for app.llm observability (Track D3) — no network.

Covers:
  * ``call_row`` shape: model/backend/tier/ok, token coercion + total fallback,
    latency/tool-call/label clamping + truncation, error truncation.
  * ``chat`` logs exactly one best-effort row for the *bound* user, and skips
    logging entirely when no user is bound (anonymous / static-API-key caller).
  * A logging failure — at the network layer OR synchronously in the row
    shaper — does NOT break or change the ``chat`` result (telemetry is
    fire-and-forget; the LLM call is the contract).
  * ``chat_json`` forwards ``label``/``tool_calls`` to the single underlying
    ``chat`` call (one row, not two).

The backend ladder is monkeypatched (MiniMax is already neutralised by the
autouse conftest fixture), so nothing here touches the network.
"""

from __future__ import annotations

import asyncio

import pytest

from app import llm

# ── helpers ──────────────────────────────────────────────────────────────────


def _ds_returning(result: llm.LlmResult):
    """A fake _deepseek_chat that always yields ``result`` (the ladder's first
    reachable backend once MiniMax is unconfigured)."""

    async def _fake_ds(messages, *, model, temperature, max_tokens, timeout_s, json_mode):  # noqa: ANN001
        # echo the resolved model id so call_row records something realistic
        return llm.LlmResult(
            text=result.text,
            model=result.model or model,
            backend=result.backend or "deepseek",
            error=result.error,
            usage=result.usage,
        )

    return _fake_ds


async def _drain_logs() -> None:
    """Let any fire-and-forget log task created by chat() run to completion."""
    await asyncio.sleep(0)
    pending = list(llm._PENDING_LOGS)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


# ── call_row: pure shape ───────────────────────────────────────────────────────


def test_call_row_shape_and_token_fields() -> None:
    res = llm.LlmResult(
        text="hello",
        model="deepseek-chat",
        backend="deepseek",
        usage={"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
    )
    row = llm.call_row(
        res, user_id="u-1", tier="fast", latency_ms=137, tool_calls=3, label="agent.gather"
    )
    assert row == {
        "user_id": "u-1",
        "backend": "deepseek",
        "model_id": "deepseek-chat",
        "tier": "fast",
        "ok": True,
        "prompt_tokens": 12,
        "completion_tokens": 8,
        "total_tokens": 20,
        "latency_ms": 137,
        "tool_calls": 3,
        "label": "agent.gather",
        "error": None,
    }
    # Row must be JSON-serialisable (it goes over PostgREST as JSON).
    import json

    json.loads(json.dumps(row))


def test_call_row_total_falls_back_to_sum_when_missing() -> None:
    # Backends like Ollama report no usage; DeepSeek sometimes omits total.
    res = llm.LlmResult(
        text="x",
        model="m",
        backend="deepseek",
        usage={"prompt_tokens": 5, "completion_tokens": 7},
    )
    row = llm.call_row(res, user_id="u", tier="reason", latency_ms=1, tool_calls=0, label="")
    assert row["total_tokens"] == 12  # 5 + 7

    # No usage at all → all zero (no crash).
    res2 = llm.LlmResult(text=None, model="ollama-x", backend="ollama", error="down")
    row2 = llm.call_row(res2, user_id="u", tier="fast", latency_ms=0, tool_calls=0, label="")
    assert row2["prompt_tokens"] == 0
    assert row2["completion_tokens"] == 0
    assert row2["total_tokens"] == 0
    assert row2["ok"] is False
    assert row2["error"] == "down"


def test_call_row_handles_garbage_usage_values() -> None:
    res = llm.LlmResult(
        text="x",
        model="m",
        backend="deepseek",
        usage={"prompt_tokens": "not-a-number", "completion_tokens": None, "total_tokens": -4},
    )
    row = llm.call_row(res, user_id="u", tier="fast", latency_ms=-9, tool_calls=-2, label="")
    # Bad token values coerce to 0, negatives clamp to 0.
    assert row["prompt_tokens"] == 0
    assert row["completion_tokens"] == 0
    assert row["total_tokens"] == 0
    assert row["latency_ms"] == 0
    assert row["tool_calls"] == 0


def test_call_row_truncates_label_and_error() -> None:
    res = llm.LlmResult(text=None, model="m", backend="deepseek", error="E" * 900)
    row = llm.call_row(res, user_id="u", tier="fast", latency_ms=0, tool_calls=0, label="L" * 300)
    assert len(row["label"]) == 120
    assert len(row["error"]) == 500


# ── chat(): user binding gates logging ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_logs_one_row_for_bound_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(
            llm.LlmResult(
                text="answer",
                model="deepseek-chat",
                backend="deepseek",
                usage={"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
            )
        ),
    )
    captured: list[tuple[dict, str]] = []

    async def _fake_post(row, token):  # noqa: ANN001
        captured.append((row, token))

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    tok = llm.bind_user("user-42", "jwt-abc")
    try:
        res = await llm.chat(
            [{"role": "user", "content": "hi"}], tier="fast", label="unit", tool_calls=2
        )
    finally:
        llm.reset_user(tok)
    await _drain_logs()

    assert res.ok and res.text == "answer"
    assert len(captured) == 1
    row, token = captured[0]
    assert token == "jwt-abc"
    assert row["user_id"] == "user-42"
    assert row["model_id"] == "deepseek-chat"
    assert row["backend"] == "deepseek"
    assert row["tier"] == "fast"
    assert row["label"] == "unit"
    assert row["tool_calls"] == 2
    assert row["total_tokens"] == 6
    assert row["ok"] is True
    assert isinstance(row["latency_ms"], int) and row["latency_ms"] >= 0


@pytest.mark.asyncio
async def test_chat_logs_failures_too(monkeypatch: pytest.MonkeyPatch) -> None:
    # A failed call (no text) is still observability-worthy.
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text=None, model="deepseek-chat", error="boom")),
    )

    async def _dead_ollama(messages, *, prefer_model, temperature, timeout_s):  # noqa: ANN001
        return llm.LlmResult(text=None, backend="ollama", error="ollama unreachable")

    monkeypatch.setattr(llm, "_ollama_chat", _dead_ollama)
    captured: list[dict] = []

    async def _fake_post(row, token):  # noqa: ANN001
        captured.append(row)

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    tok = llm.bind_user("u", "t")
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}], tier="reason")
    finally:
        llm.reset_user(tok)
    await _drain_logs()

    assert not res.ok
    assert len(captured) == 1
    assert captured[0]["ok"] is False
    assert captured[0]["error"]


@pytest.mark.asyncio
async def test_chat_skips_logging_with_no_bound_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat")),
    )
    posted = {"n": 0}

    async def _fake_post(row, token):  # noqa: ANN001
        posted["n"] += 1

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    # Ensure no stale binding leaks from another test in this loop.
    llm._LLM_USER.set(None)
    res = await llm.chat([{"role": "user", "content": "hi"}], label="anon")
    await _drain_logs()

    assert res.ok
    assert posted["n"] == 0  # anonymous → no row attempted


@pytest.mark.asyncio
async def test_bind_user_with_missing_token_does_not_log(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat")),
    )
    posted = {"n": 0}

    async def _fake_post(row, token):  # noqa: ANN001
        posted["n"] += 1

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    # user id but no token (or vice-versa) → treated as anonymous.
    tok = llm.bind_user("u", "")
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.reset_user(tok)
    await _drain_logs()

    assert res.ok
    assert posted["n"] == 0


# ── logging failure NEVER breaks the call ──────────────────────────────────────


@pytest.mark.asyncio
async def test_network_log_failure_does_not_break_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat", backend="deepseek")),
    )

    async def _boom_post(row, token):  # noqa: ANN001
        raise RuntimeError("supabase exploded")

    monkeypatch.setattr(llm, "_post_call_row", _boom_post)

    tok = llm.bind_user("u", "t")
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
        # The fire-and-forget task raises; draining must absorb it (no leak).
        await _drain_logs()
    finally:
        llm.reset_user(tok)

    assert res.ok
    assert res.text == "answer"


@pytest.mark.asyncio
async def test_sync_log_failure_does_not_break_call(monkeypatch: pytest.MonkeyPatch) -> None:
    # If the row shaper itself raises (defensive), chat() must still return.
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat", backend="deepseek")),
    )

    def _boom_row(*a, **k):  # noqa: ANN002, ANN003
        raise RuntimeError("shaper exploded")

    monkeypatch.setattr(llm, "call_row", _boom_row)
    posted = {"n": 0}

    async def _fake_post(row, token):  # noqa: ANN001
        posted["n"] += 1

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    tok = llm.bind_user("u", "t")
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
        await _drain_logs()
    finally:
        llm.reset_user(tok)

    assert res.ok and res.text == "answer"
    assert posted["n"] == 0  # shaper blew up before any post scheduled


@pytest.mark.asyncio
async def test_post_call_row_swallows_when_supabase_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # With Supabase URL unset, the writer is a silent no-op (no exception, no I/O).
    from app.config import Settings

    monkeypatch.setattr(llm, "get_settings", lambda: Settings(supabase_url=""))

    def _no_client(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not open an httpx client when Supabase is unset")

    monkeypatch.setattr(llm.httpx, "AsyncClient", _no_client)
    # Must simply return, not raise.
    await llm._post_call_row({"user_id": "u"}, "t")


# ── chat_json forwards the observability tags ──────────────────────────────────


@pytest.mark.asyncio
async def test_chat_json_forwards_label_and_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    async def _fake_chat(messages, **kwargs):  # noqa: ANN001, ANN003
        seen.update(kwargs)
        return llm.LlmResult(text='{"a": 1}', model="deepseek-chat", backend="deepseek")

    monkeypatch.setattr(llm, "chat", _fake_chat)
    parsed, res = await llm.chat_json(
        [{"role": "user", "content": "hi"}], label="investigate", tool_calls=5
    )
    assert parsed == {"a": 1}
    assert res.ok
    assert seen.get("label") == "investigate"
    assert seen.get("tool_calls") == 5
