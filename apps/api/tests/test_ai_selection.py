"""POST /api/ai/selection/brief — happy path, 60s cache hit, disabled (409),
and oversized-props rejection. Keyless (ALLOW_UNAUTHENTICATED=1, set by
conftest) via the shared ``client`` fixture; ``llm.chat`` is mocked so no
network/model is ever touched.
"""

from __future__ import annotations

import pytest

from app import llm
from app import upstream as upstream_mod


@pytest.fixture(autouse=True)
def _isolate_selection(monkeypatch: pytest.MonkeyPatch):
    llm.set_selection_enabled(True)
    # Fresh cache per test — the module-level TtlCache is shared with every
    # other route, so a stale entry from another test's (kind, id) pair must
    # never leak in here.
    upstream_mod.cache._data.clear()
    upstream_mod.cache._locks.clear()
    yield
    llm.set_selection_enabled(None)
    upstream_mod.cache._data.clear()
    upstream_mod.cache._locks.clear()


def _fake_chat(text: str = "Nothing anomalous; routine transit."):
    calls = {"n": 0}

    async def _inner(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        calls["n"] += 1
        assert tier == "selection"
        return llm.LlmResult(text=text, model="model.gguf", backend="llamacpp")

    return _inner, calls


def test_selection_brief_happy_path(client, monkeypatch: pytest.MonkeyPatch) -> None:
    fake, calls = _fake_chat()
    monkeypatch.setattr(llm, "chat", fake)

    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": "aircraft", "id": "AC-happy-1", "props": {"callsign": "UAL123", "alt_ft": 35000}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["text"] == "Nothing anomalous; routine transit."
    assert body["backend"] == "llamacpp"
    assert body["model"] == "model.gguf"
    assert body["cached"] is False
    assert isinstance(body["latency_ms"], int)
    assert calls["n"] == 1


def test_selection_brief_second_call_within_ttl_is_cached(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake, calls = _fake_chat()
    monkeypatch.setattr(llm, "chat", fake)

    body = {"kind": "vessel", "id": "MMSI-cache-1", "props": {"name": "MV Test"}}
    r1 = client.post("/api/ai/selection/brief", json=body)
    r2 = client.post("/api/ai/selection/brief", json=body)

    assert r1.json()["cached"] is False
    assert r2.json()["cached"] is True
    assert r2.json()["text"] == r1.json()["text"]
    assert calls["n"] == 1  # second call served from cache, no second llm.chat


def test_selection_brief_different_id_is_not_cached(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake, calls = _fake_chat()
    monkeypatch.setattr(llm, "chat", fake)

    client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-distinct-1", "props": {}}
    )
    client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-distinct-2", "props": {}}
    )
    assert calls["n"] == 2


def test_selection_brief_409_when_disabled(client) -> None:
    llm.set_selection_enabled(False)
    r = client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-disabled-1", "props": {}}
    )
    assert r.status_code == 409


def test_selection_brief_413_oversized_props(client) -> None:
    big = {"blob": "x" * 5000}
    r = client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-big-1", "props": big}
    )
    assert r.status_code == 413


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "", "id": "x", "props": {}},
        {"kind": "aircraft", "id": "", "props": {}},
        {"kind": "x" * 100, "id": "y", "props": {}},
        {"id": "y", "props": {}},  # missing kind
    ],
)
def test_selection_brief_422_invalid_kind_or_id(client, body: dict) -> None:
    r = client.post("/api/ai/selection/brief", json=body)
    assert r.status_code == 422


def test_selection_brief_502_when_chat_fails(client, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fail(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        return llm.LlmResult(text=None, backend="ollama", error="ollama unreachable")

    monkeypatch.setattr(llm, "chat", _fail)
    r = client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-fail-1", "props": {}}
    )
    assert r.status_code == 502


def test_selection_brief_uses_a_max_tokens_floor_that_survives_a_thinking_preamble(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reasoning-tier local model spends part of its budget on a thinking
    preamble even with thinking disabled at the request level (template
    quirks vary) — 300 wasn't enough headroom to survive that and still
    answer, so the floor must be raised. 512 is the floor picked; assert the
    route passes AT LEAST that, not some regressed lower value."""
    seen = {}

    async def _capture(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        seen["max_tokens"] = max_tokens
        return llm.LlmResult(text="ok", model="m", backend="llamacpp")

    monkeypatch.setattr(llm, "chat", _capture)
    r = client.post(
        "/api/ai/selection/brief", json={"kind": "aircraft", "id": "AC-tokens-1", "props": {}}
    )
    assert r.status_code == 200
    assert seen["max_tokens"] >= 512


def test_selection_brief_clamps_long_string_props(client, monkeypatch: pytest.MonkeyPatch) -> None:
    seen_user_msg = {}

    async def _capture(messages, *, tier="fast", max_tokens=1024, label="", **kw):  # noqa: ANN001, ANN003
        seen_user_msg["content"] = messages[-1]["content"]
        return llm.LlmResult(text="ok", model="m", backend="llamacpp")

    monkeypatch.setattr(llm, "chat", _capture)
    long_val = "y" * 800  # under the 4KB total cap but over the per-string clamp
    r = client.post(
        "/api/ai/selection/brief",
        json={"kind": "aircraft", "id": "AC-clamp-1", "props": {"note": long_val}},
    )
    assert r.status_code == 200
    assert len(seen_user_msg["content"]) < len(long_val) + 200
