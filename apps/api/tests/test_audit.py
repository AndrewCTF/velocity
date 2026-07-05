"""Immutable audit writer — row shape + non-blocking failure (Gotham substrate)."""

from __future__ import annotations

import pytest

from app import audit as audit_mod
from app.keys import UserCtx


class _FakeResp:
    def __init__(self, status: int = 201, text: str = "") -> None:
        self.status_code = status
        self.text = text


class _FakeClient:
    def __init__(self, captured: list, status: int = 201, raise_exc: Exception | None = None) -> None:
        self.captured = captured
        self.status = status
        self.raise_exc = raise_exc

    async def __aenter__(self) -> _FakeClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def post(self, url: str, json: dict | None = None, headers: dict | None = None) -> _FakeResp:
        if self.raise_exc:
            raise self.raise_exc
        self.captured.append({"url": url, "json": json})
        return _FakeResp(self.status)


async def test_audit_writes_expected_row(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list = []
    monkeypatch.setattr(audit_mod, "_url", lambda: "https://x.supabase.co/rest/v1/action_log")
    monkeypatch.setattr(audit_mod, "_client", lambda: _FakeClient(captured))
    ok = await audit_mod.audit(
        UserCtx("u1", "tok"), "extract", "document", "ext:document:abc",
        classification=3, detail={"entities": 2},
    )
    assert ok is True
    row = captured[0]["json"]
    assert row["user_id"] == "u1"
    assert row["action"] == "extract"
    assert row["resource_type"] == "document"
    assert row["target_id"] == "ext:document:abc"
    assert row["classification"] == 3
    assert row["params"] == {"entities": 2}


async def test_audit_nonblocking_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(audit_mod, "_url", lambda: "https://x/rest/v1/action_log")
    monkeypatch.setattr(audit_mod, "_client", lambda: _FakeClient([], raise_exc=RuntimeError("down")))
    ok = await audit_mod.audit(UserCtx("u1", "tok"), "flag", "object")
    assert ok is False  # logged, never raised


async def test_audit_noop_without_supabase(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(audit_mod, "_url", lambda: "")
    ok = await audit_mod.audit(UserCtx("u1", "tok"), "a", "b")
    assert ok is False
