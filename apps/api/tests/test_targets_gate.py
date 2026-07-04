"""F2T2EA stage-gate + transition audit (Track C5) — hermetic.

The target-board PATCH gates a stage move against the ordered F2T2EA chain
(advance/retreat one stage at a time, ``_MAX_STAGE_STEP``) and appends an
``action_log`` row per LEGAL transition, reusing ``actions.audit_row`` for the
shape. These tests exercise:

  - the pure ``_validate_transition`` rule (legal / illegal / legacy stage),
  - a LEGAL move over a mocked PostgREST → 200 + an ``advance_stage`` audit row,
  - a backward one-step move (re-attack) → legal + audited,
  - an ILLEGAL skip (confirm → execute) → 409, NO patch, NO audit,
  - a same-stage no-op and a note-only PATCH → ungated (no audit),
  - the ``/audit`` read endpoint, and its 503 when Supabase is unconfigured.

No live Supabase / network: ``current_user`` is overridden and the httpx client
factory is replaced with a recorder (mirrors ``test_targets_route.py`` /
``test_actions.py``).
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.keys import UserCtx, current_user
from app.routes import targets as tg


def _fake_user() -> UserCtx:
    return UserCtx("u1", "tok")


# ── pure rule: _validate_transition ────────────────────────────────────────────


def test_validate_transition_allows_one_step_forward() -> None:
    # confirm → attach_intel is one stage forward → legal (no raise).
    tg._validate_transition("confirm", "attach_intel")


def test_validate_transition_allows_one_step_back() -> None:
    # execute → weaponeer is one stage back (re-attack / pull authority) → legal.
    tg._validate_transition("execute", "weaponeer")


def test_validate_transition_rejects_skip() -> None:
    with pytest.raises(HTTPException) as ei:
        tg._validate_transition("confirm", "execute")
    assert ei.value.status_code == 409
    assert "illegal stage transition" in ei.value.detail


def test_validate_transition_rejects_far_backward() -> None:
    with pytest.raises(HTTPException) as ei:
        tg._validate_transition("complete", "confirm")
    assert ei.value.status_code == 409


def test_validate_transition_legacy_stage_falls_back_to_membership() -> None:
    # An unknown STORED stage (legacy row) must not 500: gate degrades to plain
    # enum membership on the *target*. A known target passes; a bad one is 400.
    tg._validate_transition("legacy_stage", "approvals")  # no raise
    with pytest.raises(HTTPException) as ei:
        tg._validate_transition("legacy_stage", "not_a_stage")
    assert ei.value.status_code == 400


# ── PATCH gate + audit over a mocked PostgREST ─────────────────────────────────


class _FakeResp:
    def __init__(self, status: int, payload: object) -> None:
        self.status_code = status
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _RecordingClient:
    """Mock PostgREST. ``current_stage`` is the row the board GET returns, so a
    PATCH can be gated against it. Records every PATCH and POST so a test can
    assert the move landed and exactly one ``action_log`` row was written."""

    current_stage = "confirm"
    patches: list[dict] = []
    posts: list[tuple[str, dict]] = []

    async def __aenter__(self) -> "_RecordingClient":
        return self

    async def __aexit__(self, *a: object) -> bool:
        return False

    async def get(self, url: str, params: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        # The board read used by _fetch_target (and list); return one row whose
        # stage is the configured current stage. The /audit GET hits action_log.
        if url.endswith("/action_log"):
            return _FakeResp(
                200,
                [
                    {
                        "action": "advance_stage",
                        "target_id": "t1",
                        "params": {"from": "confirm", "to": "attach_intel"},
                        "ts": "2026-06-21T00:00:00Z",
                    }
                ],
            )
        return _FakeResp(
            200,
            [
                {
                    "id": "t1",
                    "entity_id": "aircraft:abc",
                    "stage": type(self).current_stage,
                    "priority": 3,
                    "note": "",
                }
            ],
        )

    async def patch(self, url: str, params: dict, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        type(self).patches.append(json)
        merged = {
            "id": "t1",
            "entity_id": "aircraft:abc",
            "stage": json.get("stage", type(self).current_stage),
            "priority": json.get("priority", 3),
            "note": json.get("note", ""),
        }
        return _FakeResp(200, [merged])

    async def post(self, url: str, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
        type(self).posts.append((url, json))
        return _FakeResp(201, None)  # return=minimal on action_log


def _wire(monkeypatch: pytest.MonkeyPatch, current_stage: str = "confirm") -> None:
    _RecordingClient.current_stage = current_stage
    _RecordingClient.patches = []
    _RecordingClient.posts = []
    monkeypatch.setattr(tg, "_client", lambda: _RecordingClient())
    monkeypatch.setattr(tg, "_rest", lambda s: "http://x/rest/v1/target_board")
    # The audit append + /audit endpoint build the action_log URL from
    # supabase_url; give the test settings one so they don't 503.
    from app.config import Settings

    monkeypatch.setattr(
        tg,
        "get_settings",
        lambda: Settings(supabase_url="http://x", supabase_anon_key="anon"),
    )


def test_legal_move_patches_and_audits(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="confirm")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "attach_intel"})
        assert r.status_code == 200
        assert r.json()["stage"] == "attach_intel"
        # the stage PATCH landed
        assert _RecordingClient.patches == [{"stage": "attach_intel"}]
        # exactly one audit row, to action_log, action=advance_stage, from→to
        audit_posts = [p for (u, p) in _RecordingClient.posts if u.endswith("/action_log")]
        assert len(audit_posts) == 1
        row = audit_posts[0]
        assert row["action"] == "advance_stage"
        assert row["target_id"] == "t1"
        assert row["params"] == {"from": "confirm", "to": "attach_intel", "forced": False}
        assert row["user_id"] == "u1"  # WHO
        assert row["ts"].endswith("Z")
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_legal_backward_move_is_audited(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="execute")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "weaponeer"})
        assert r.status_code == 200
        audit_posts = [p for (u, p) in _RecordingClient.posts if u.endswith("/action_log")]
        assert len(audit_posts) == 1
        assert audit_posts[0]["params"] == {"from": "execute", "to": "weaponeer", "forced": False}
    finally:
        client.app.dependency_overrides.pop(current_user, None)


# ── confirmation-checklist gate (requirements) ─────────────────────────────────


def test_requirements_gate_blocks_advance_into_gated_stage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # attach_intel → approvals requires target_identity + location_verified. The
    # mocked row carries no requirements (all unmet) → 409, NO patch, NO audit.
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="attach_intel")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "approvals"})
        assert r.status_code == 409
        assert "checklist incomplete" in r.json()["detail"]
        assert _RecordingClient.patches == []  # the move never landed
        audit_posts = [p for (u, p) in _RecordingClient.posts if u.endswith("/action_log")]
        assert audit_posts == []  # nothing audited
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_force_advances_past_unmet_checklist_and_audits_forced(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same move with force=true overrides the gate: 200, the persisted patch has
    # NO `force` key (it is a control flag, not a column), and the audit records
    # forced=True so the override is on the kill-chain trail.
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="attach_intel")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "approvals", "force": True})
        assert r.status_code == 200
        assert _RecordingClient.patches == [{"stage": "approvals"}]  # force stripped
        audit_posts = [p for (u, p) in _RecordingClient.posts if u.endswith("/action_log")]
        assert len(audit_posts) == 1
        assert audit_posts[0]["params"] == {"from": "attach_intel", "to": "approvals", "forced": True}
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_checklist_toggle_sends_merged_requirements(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A requirements-only PATCH is ungated (no stage move) and persists the
    # MERGED dict (a jsonb PATCH replaces the column, so a partial would wipe it).
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="confirm")
    try:
        r = client.patch("/api/targets/board/t1", json={"requirements": {"target_identity": True}})
        assert r.status_code == 200
        assert _RecordingClient.patches == [{"requirements": {"target_identity": True}}]
        audit_posts = [p for (u, p) in _RecordingClient.posts if u.endswith("/action_log")]
        assert audit_posts == []  # no stage move → no transition audit
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_illegal_skip_is_409_with_no_patch_and_no_audit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="confirm")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "execute"})
        assert r.status_code == 409
        # the move was refused BEFORE the patch + BEFORE any audit
        assert _RecordingClient.patches == []
        assert [u for (u, _) in _RecordingClient.posts if u.endswith("/action_log")] == []
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_same_stage_patch_is_noop_not_audited(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Dropping a card back onto its own column → same stage → harmless, not
    # gated as illegal and not audited (no real transition happened).
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="approvals")
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "approvals"})
        assert r.status_code == 200
        assert [u for (u, _) in _RecordingClient.posts if u.endswith("/action_log")] == []
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_note_only_patch_skips_the_gate(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A note-only PATCH (no stage key) never touches the chain — no audit, and
    # it does NOT depend on the current stage being legal-to-move.
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="complete")
    try:
        r = client.patch("/api/targets/board/t1", json={"note": "COA text"})
        assert r.status_code == 200
        assert _RecordingClient.patches == [{"note": "COA text"}]
        assert [u for (u, _) in _RecordingClient.posts if u.endswith("/action_log")] == []
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_audit_endpoint_returns_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="confirm")
    try:
        r = client.get("/api/targets/board/t1/audit")
        assert r.status_code == 200
        rows = r.json()
        assert rows and rows[0]["action"] == "advance_stage"
        assert rows[0]["params"]["to"] == "attach_intel"
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_audit_endpoint_503_when_supabase_unconfigured(client: TestClient) -> None:
    # No _wire(): the default test settings carry no supabase_url, so the audit
    # read raises the store-not-configured 503 (the frontend tolerates it).
    client.app.dependency_overrides[current_user] = _fake_user
    try:
        r = client.get("/api/targets/board/t1/audit")
        assert r.status_code == 503
    finally:
        client.app.dependency_overrides.pop(current_user, None)


def test_audit_failure_does_not_break_the_move(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The move has already landed; a failing audit append must NOT flip the
    # operator-visible result to an error (best-effort receipt).
    client.app.dependency_overrides[current_user] = _fake_user
    _wire(monkeypatch, current_stage="confirm")

    class _AuditFailsClient(_RecordingClient):
        async def post(self, url: str, json: dict, headers: dict) -> _FakeResp:  # type: ignore[override]
            type(self).posts.append((url, json))
            return _FakeResp(500, None)  # audit write fails

    monkeypatch.setattr(tg, "_client", lambda: _AuditFailsClient())
    try:
        r = client.patch("/api/targets/board/t1", json={"stage": "attach_intel"})
        assert r.status_code == 200  # move still succeeds
        assert r.json()["stage"] == "attach_intel"
    finally:
        client.app.dependency_overrides.pop(current_user, None)
