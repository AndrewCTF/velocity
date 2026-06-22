"""Governed write-back actions — pure-logic + dispatch units (hermetic).

Covers: audit-row shape, registry dispatch (unknown action → 404, bad params →
400), the route auth gate + 503 contract, and a full happy-path dispatch of
flag_entity / nominate_target / add_watch over a mocked PostgREST so the ontology
mutation + side effect + audit append are all exercised without a network.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings
from app.intel import actions as act
from app.intel.actions import (
    FlagEntityParams,
    audit_row,
    dispatch,
    list_actions,
)
from app.keys import UserCtx, current_user

# ── pure logic: audit row + catalog ────────────────────────────────────────────


def test_audit_row_shape() -> None:
    ctx = UserCtx("user-42", "tok")
    row = audit_row(ctx, "flag_entity", "aircraft:abc", {"note": "hi", "severity": 3})
    assert row["user_id"] == "user-42"  # WHO
    assert row["action"] == "flag_entity"
    assert row["target_id"] == "aircraft:abc"
    assert row["params"] == {"note": "hi", "severity": 3}
    assert isinstance(row["ts"], str) and row["ts"].endswith("Z")
    # No role field — audit-of-who, not RBAC.
    assert "role" not in row


def test_catalog_lists_first_actions() -> None:
    names = {a["name"] for a in list_actions()}
    assert names == {"flag_entity", "promote_incident", "nominate_target", "add_watch"}
    # Each entry advertises its param schema for the UI / agent.
    flag = next(a for a in list_actions() if a["name"] == "flag_entity")
    assert "target_id" in flag["params"]
    assert "target_id" in flag["required"]


def test_flag_params_validation() -> None:
    # severity is bounded 1..5.
    with pytest.raises(ValidationError):
        FlagEntityParams(target_id="aircraft:a", severity=99)
    ok = FlagEntityParams(target_id="aircraft:a")
    assert ok.severity == 3  # default


# ── dispatch error paths (no store touched) ────────────────────────────────────


def test_dispatch_unknown_action_404() -> None:
    ctx = UserCtx("u1", "tok")
    with pytest.raises(HTTPException) as ei:
        asyncio.run(dispatch("launch_missiles", {}, ctx, Settings()))
    assert ei.value.status_code == 404


def test_dispatch_invalid_params_400() -> None:
    ctx = UserCtx("u1", "tok")
    # missing required target_id → 400 with the pydantic errors as detail
    with pytest.raises(HTTPException) as ei:
        asyncio.run(dispatch("flag_entity", {"note": "x"}, ctx, Settings()))
    assert ei.value.status_code == 400
    assert isinstance(ei.value.detail, list)  # pydantic error list


# ── route wiring ────────────────────────────────────────────────────────────────


def test_actions_route_requires_auth(client: TestClient) -> None:
    assert client.get("/api/actions").status_code == 401
    assert client.post("/api/actions/flag_entity", json={}).status_code == 401


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


def test_catalog_route_ok_when_authed(client: TestClient) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.get("/api/actions")
        assert r.status_code == 200
        assert {a["name"] for a in r.json()} == {
            "flag_entity",
            "promote_incident",
            "nominate_target",
            "add_watch",
        }
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_action_503_when_supabase_unconfigured(client: TestClient) -> None:
    # flag_entity touches the ontology store first; with no supabase_url the
    # registry raises 503 — the store-not-configured contract.
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.post(
            "/api/actions/flag_entity",
            json={"target_id": "aircraft:abc", "note": "loitering"},
        )
        assert r.status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_action_bad_params_400_via_route(client: TestClient) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        # missing target_id
        r = client.post("/api/actions/flag_entity", json={"note": "x"})
        assert r.status_code == 400
    finally:
        client.app.dependency_overrides.pop(current_user, None)


# ── happy-path dispatch over a mocked PostgREST ────────────────────────────────


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


# Module-level accumulator: actions.py AND ontology.py each build their own
# httpx client per `async with _client()`, so a per-instance list would be wiped
# on every new client. A shared list (cleared per test) records all of them.
_POSTS: list[tuple[str, dict]] = []


class _RecordingClient:
    """Records every POST (into ``_POSTS``) so we can assert side effect + audit.

    Returns a representation row for whichever table is being written, keyed off
    the URL suffix. GET (registry.get during upsert/link flows) returns empty.
    """

    async def __aenter__(self) -> _RecordingClient:
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def get(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        return _FakeResp(200, [])  # nothing persisted yet → upsert path

    async def post(self, url: str, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        _POSTS.append((url, json))
        if url.endswith("/objects"):
            return _FakeResp(201, [{**json, "created_at": "2026-06-21T00:00:00Z"}])
        if url.endswith("/links"):
            return _FakeResp(201, [{**json, "id": "lnk-1"}])
        if url.endswith("/target_board"):
            return _FakeResp(201, [{**json, "id": "tb-1"}])
        if url.endswith("/alert_rules"):
            return _FakeResp(201, [{**json, "id": "ar-1"}])
        if url.endswith("/action_log"):
            return _FakeResp(201, None)  # return=minimal
        return _FakeResp(201, json)


def _settings() -> Settings:
    return Settings(supabase_url="http://x", supabase_anon_key="anon")


def _patch_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch BOTH the actions and ontology httpx factories + reset the recorder."""
    from app.intel import ontology as ont

    _POSTS.clear()
    monkeypatch.setattr(act, "_client", lambda: _RecordingClient())
    monkeypatch.setattr(ont, "_client", lambda: _RecordingClient())


def test_flag_entity_mutates_ontology_and_audits(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clients(monkeypatch)

    res = asyncio.run(
        dispatch(
            "flag_entity",
            {"target_id": "aircraft:abc", "note": "loitering", "severity": 4},
            UserCtx("u1", "tok"),
            _settings(),
        )
    )
    assert res.ok is True
    assert res.action == "flag_entity"
    assert res.target_id == "aircraft:abc"
    assert res.audit["user_id"] == "u1"
    assert res.audit["action"] == "flag_entity"
    # the recording client saw an object upsert, a link, and an audit append
    urls = [u for u, _ in _POSTS]
    assert any(u.endswith("/objects") for u in urls)
    assert any(u.endswith("/links") for u in urls)
    assert any(u.endswith("/action_log") for u in urls)


def test_nominate_target_writes_board_and_audits(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clients(monkeypatch)

    res = asyncio.run(
        dispatch(
            "nominate_target",
            {"target_id": "vessel:636092000", "priority": 1, "note": "dark"},
            UserCtx("u1", "tok"),
            _settings(),
        )
    )
    assert res.action == "nominate_target"
    assert res.detail["target_board_entry"]["id"] == "tb-1"
    urls = [u for u, _ in _POSTS]
    # wrote to the SAME target_board table routes/targets.py owns
    assert any(u.endswith("/target_board") for u in urls)
    assert any(u.endswith("/action_log") for u in urls)


def test_add_watch_writes_alert_rule_and_audits(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_clients(monkeypatch)

    res = asyncio.run(
        dispatch(
            "add_watch",
            {
                "target_id": "aircraft:abc",
                "label": "Hormuz watch",
                "lat": 26.5,
                "lon": 56.3,
                "radius_nm": 80,
                "kinds": ["jamming"],
            },
            UserCtx("u1", "tok"),
            _settings(),
        )
    )
    assert res.action == "add_watch"
    assert res.detail["alert_rule"]["id"] == "ar-1"
    urls = [u for u, _ in _POSTS]
    assert any(u.endswith("/alert_rules") for u in urls)
    assert any(u.endswith("/action_log") for u in urls)
