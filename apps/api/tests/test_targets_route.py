"""Target-board routes: validation and CRUD wiring (hermetic — no real
upstream). On a keyless boot the board uses the local SQLite store via
``current_user_or_local`` (same idiom as alert rules), so it serves the
shared ``local`` identity instead of 401/503."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.keys import UserCtx, current_user_or_local
from app.routes import targets as tg


def test_board_serves_keyless_local(client: TestClient) -> None:
    # No auth override: the test settings carry no Supabase, so
    # current_user_or_local yields the shared "local" identity and the local
    # store answers 200 (not 401).
    r = client.get("/api/targets/board")
    assert r.status_code == 200
    assert r.json() == []


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_create_rejects_unknown_stage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user_or_local] = _fake_user
    r = client.post(
        "/api/targets/board",
        json={"entity_id": "aircraft:abc123", "stage": "bombs-away"},
    )
    assert r.status_code == 400
    client.app.dependency_overrides.pop(current_user_or_local, None)


def test_crud_with_fake_user(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user_or_local] = _fake_user

    class FakeResp:
        def __init__(self, status: int, payload):  # type: ignore[no-untyped-def]
            self.status_code = status
            self._payload = payload

        def json(self):  # type: ignore[no-untyped-def]
            return self._payload

    row = {
        "id": "t1",
        "entity_id": "vessel:636092000",
        "stage": "confirm",
        "priority": 2,
        "note": "loitering near cable",
        "created_at": "2026-06-21T00:00:00Z",
        "updated_at": "2026-06-21T00:00:00Z",
    }

    class FakeClient:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(200, [row])

        async def post(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(201, [row])

        async def patch(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(200, [{**row, "stage": "attach_intel"}])

        async def delete(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(204, None)

    monkeypatch.setattr(tg, "_client", lambda: FakeClient())
    monkeypatch.setattr(tg, "_rest", lambda s: "http://x/rest/v1/target_board")
    # Force the Supabase branch (the fake PostgREST above) rather than the
    # keyless local store.
    from app.config import Settings

    monkeypatch.setattr(
        tg,
        "get_settings",
        lambda: Settings(supabase_url="http://x", supabase_anon_key="anon"),
    )

    listed = client.get("/api/targets/board")
    assert listed.status_code == 200
    assert listed.json()[0]["entity_id"] == "vessel:636092000"

    created = client.post(
        "/api/targets/board",
        json={
            "entity_id": "vessel:636092000",
            "stage": "confirm",
            "priority": 2,
            "note": "loitering near cable",
        },
    )
    assert created.status_code == 201
    assert created.json()["id"] == "t1"

    # The PATCH now passes through the F2T2EA stage-gate: the stored row above
    # is "confirm", so a LEGAL one-step move is confirm → attach_intel (the old
    # confirm → execute skip is rejected with 409 — see test_targets_gate.py).
    moved = client.patch("/api/targets/board/t1", json={"stage": "attach_intel"})
    assert moved.status_code == 200
    assert moved.json()["stage"] == "attach_intel"

    assert client.delete("/api/targets/board/t1").status_code == 204

    client.app.dependency_overrides.pop(current_user_or_local, None)
