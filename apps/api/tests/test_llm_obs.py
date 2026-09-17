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
async def test_bind_user_with_no_token_still_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Changed 2026-09-17 (W4). This asserted the opposite — no token, no row —
    on the reasoning that the only sink was PostgREST and RLS forbids an insert
    without the caller's own JWT. True, and it meant the keyless deployment, the
    one that runs every model on its own GPU, was the single deployment that
    recorded nothing about its model calls. ``current_user_or_local`` yields
    ``UserCtx("local", "")`` there, so the token was always empty.

    The row is now shaped and routed; ``_post_call_row`` decides where it can
    go, and the test below pins that it still never attempts the remote insert
    without a token."""
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat")),
    )
    posted: list[tuple[dict, str]] = []

    async def _fake_post(row, token):  # noqa: ANN001
        posted.append((row, token))

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    tok = llm.bind_user("local", "")
    try:
        res = await llm.chat([{"role": "user", "content": "hi"}])
    finally:
        llm.reset_user(tok)
    await _drain_logs()

    assert res.ok
    assert len(posted) == 1
    assert posted[0][0]["user_id"] == "local"
    assert posted[0][1] == ""


@pytest.mark.asyncio
async def test_no_user_id_is_still_anonymous(monkeypatch: pytest.MonkeyPatch) -> None:
    """The half of the old predicate that survives: no identity, no row. A row
    with no owner is not an audit trail, it is a log line."""
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat")),
    )
    posted = {"n": 0}

    async def _fake_post(row, token):  # noqa: ANN001
        posted["n"] += 1

    monkeypatch.setattr(llm, "_post_call_row", _fake_post)

    tok = llm.bind_user("", "tok")
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
async def test_post_call_row_writes_locally_when_supabase_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """Was "silent no-op (no exception, no I/O)" until 2026-09-17. Still no
    network — the row goes to the local SQLite sink instead of being dropped, so
    a keyless box has a model-call audit trail at all."""
    from app import llm_calls_local
    from app.config import Settings

    llm_calls_local.override_db_path(str(tmp_path / "llm_calls.db"))
    monkeypatch.setattr(llm, "get_settings", lambda: Settings(supabase_url=""))

    def _no_client(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not open an httpx client when Supabase is unset")

    monkeypatch.setattr(llm.httpx, "AsyncClient", _no_client)
    try:
        await llm._post_call_row(
            llm.call_row(
                llm.LlmResult(text="hi", model="qwen.gguf", backend="llamacpp"),
                user_id="local",
                tier="fast",
                latency_ms=42,
                tool_calls=0,
                label="ai.selection_brief",
            ),
            "",
        )
        rows = await llm_calls_local.list_calls(10)
    finally:
        llm_calls_local.override_db_path(None)

    assert len(rows) == 1
    assert rows[0]["user_id"] == "local"
    assert rows[0]["model_id"] == "qwen.gguf"
    assert rows[0]["backend"] == "llamacpp"
    assert rows[0]["label"] == "ai.selection_brief"
    assert rows[0]["latency_ms"] == 42
    assert rows[0]["ok"] is True


@pytest.mark.asyncio
async def test_post_call_row_never_inserts_remotely_without_a_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The surviving half of the old ``user_id and token`` predicate: with
    Supabase configured, RLS needs the caller's own JWT, and writing the row to
    the local sink instead would split one deployment's trail across two
    stores."""
    from app.config import Settings

    monkeypatch.setattr(
        llm,
        "get_settings",
        lambda: Settings(supabase_url="https://p.supabase.co", supabase_anon_key="anon"),
    )

    def _no_client(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not attempt a PostgREST insert without a token")

    monkeypatch.setattr(llm.httpx, "AsyncClient", _no_client)

    def _no_local(*a, **k):  # noqa: ANN002, ANN003
        raise AssertionError("must not write locally when Supabase is the sink")

    from app import llm_calls_local

    monkeypatch.setattr(llm_calls_local, "append", _no_local)
    await llm._post_call_row({"user_id": "u"}, "")


# ── GET /api/ai/calls reads the local trail back ─────────────────────────────


@pytest.mark.asyncio
async def test_a_local_row_is_readable_through_the_calls_route(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """The proof an operator can actually run: one model call on a keyless box
    leaves one row, and the route serves it."""
    from fastapi.testclient import TestClient

    from app import llm_calls_local
    from app.config import Settings
    from app.main import create_app

    llm_calls_local.override_db_path(str(tmp_path / "llm_calls.db"))
    monkeypatch.setattr(llm, "get_settings", lambda: Settings(supabase_url=""))
    monkeypatch.setattr(
        llm,
        "_deepseek_chat",
        _ds_returning(llm.LlmResult(text="answer", model="deepseek-chat")),
    )
    try:
        tok = llm.bind_user("local", "")
        try:
            res = await llm.chat([{"role": "user", "content": "hi"}], label="country.brief")
        finally:
            llm.reset_user(tok)
        await _drain_logs()
        assert res.ok

        with TestClient(create_app()) as c:
            r = c.get("/api/ai/calls?limit=10")
            assert r.status_code == 200, r.text
            rows = r.json()
    finally:
        llm_calls_local.override_db_path(None)

    assert len(rows) == 1
    assert rows[0]["label"] == "country.brief"
    assert rows[0]["user_id"] == "local"
    # An accountability trail, not a transcript store.
    assert "prompt" not in rows[0]
    assert "text" not in rows[0]


def test_the_calls_route_bounds_its_limit() -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    with TestClient(create_app()) as c:
        assert c.get("/api/ai/calls?limit=10000000").status_code == 422
        assert c.get("/api/ai/calls?limit=0").status_code == 422


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
