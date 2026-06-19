"""Alert-rule routes: auth gate, validation, and CRUD wiring (hermetic)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.keys import UserCtx, current_user
from app.routes import alert_rules as ar


def test_rules_require_auth(client: TestClient) -> None:
    assert client.get("/api/alerts/rules").status_code == 401


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_create_rejects_unknown_kind(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "kinds": ["bogus"]},
    )
    assert r.status_code == 400
    client.app.dependency_overrides.pop(current_user, None)


def test_create_rejects_bad_channel(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    r = client.post(
        "/api/alerts/rules",
        json={"label": "x", "lat": 1, "lon": 2, "channel": "carrier-pigeon"},
    )
    assert r.status_code == 400
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

    class FakeClient:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            return self

        async def __aexit__(self, *a):  # type: ignore[no-untyped-def]
            return False

        async def get(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(200, [])

        async def post(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(
                201,
                [{
                    "id": "r1",
                    "label": "Hormuz watch",
                    "lat": 26.5,
                    "lon": 56.3,
                    "radius_nm": 80,
                    "kinds": ["jamming", "dark_vessel"],
                    "min_severity": 2,
                    "channel": "inapp",
                    "enabled": True,
                    "created_at": "2026-06-19T00:00:00Z",
                }],
            )

        async def delete(self, *a, **k):  # type: ignore[no-untyped-def]
            return FakeResp(204, None)

    monkeypatch.setattr(ar, "_client", lambda: FakeClient())
    monkeypatch.setattr(ar, "_rest", lambda s: "http://x/rest/v1/alert_rules")

    assert client.get("/api/alerts/rules").json() == []

    r = client.post(
        "/api/alerts/rules",
        json={
            "label": "Hormuz watch",
            "lat": 26.5,
            "lon": 56.3,
            "radius_nm": 80,
            "kinds": ["jamming", "dark_vessel"],
            "min_severity": 2,
        },
    )
    assert r.status_code == 201
    assert r.json()["id"] == "r1"

    assert client.delete("/api/alerts/rules/r1").status_code == 204

    client.app.dependency_overrides.pop(current_user, None)
