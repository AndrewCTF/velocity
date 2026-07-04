"""Target-board routes: auth gate, validation, CRUD wiring, and the 503 it
returns when Supabase is unconfigured (hermetic — no real upstream)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.keys import UserCtx, current_user
from app.routes import targets as tg


def test_board_requires_auth(client: TestClient) -> None:
    assert client.get("/api/targets/board").status_code == 401


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_create_rejects_unknown_stage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    r = client.post(
        "/api/targets/board",
        json={"entity_id": "aircraft:abc123", "stage": "bombs-away"},
    )
    assert r.status_code == 400
    client.app.dependency_overrides.pop(current_user, None)


def test_board_503_when_supabase_unconfigured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The test Settings carry no supabase_url, so _rest() raises 503 — the
    # store-not-configured contract the frontend relies on to stay local.
    client.app.dependency_overrides[current_user] = _fake_user
    r = client.get("/api/targets/board")
    assert r.status_code == 503
    client.app.dependency_overrides.pop(current_user, None)


def test_crud_with_fake_user(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user

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

    client.app.dependency_overrides.pop(current_user, None)
