"""The MCP server's only write path: propose → list → approve.

Before this wave the MCP layer had 85 tools and every one of them read. An
agent could survey the planet and change nothing, which is safe and also means
"actions an agent can take, with a human in the loop" was a claim with no wire
behind it.

The loop proven here is deliberately not a write to the ontology: it is the
HITL queue itself. ``propose_action`` queues; nothing runs. ``approve_proposal``
is what dispatches, through the same audited ``intel/actions.dispatch`` a direct
``POST /api/actions/{name}`` takes. That ordering IS the guardrail, so it is the
thing the test asserts.

In-process ASGI round trip over ``app.main.create_app()`` — the idiom
``tests/test_mcp_rest_parity.py`` established — so the tools are proven against
the real routes and the real keyless SQLite stores, not against a mock of
``_post``. No socket, no server process.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app import mcp_server as M
from app.intel import action_log_local
from app.main import create_app


@pytest.fixture(autouse=True)
def _no_autostart(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OSINT_MCP_NO_AUTOSTART", "1")
    M._BACKEND_READY = False
    M._BACKEND_PROC = None


@pytest.fixture
def in_process(monkeypatch: pytest.MonkeyPatch):
    """Point the MCP tools' httpx client at an in-process app."""
    app = create_app()

    class _InProcessClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs["transport"] = httpx.ASGITransport(app=app)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(M.httpx, "AsyncClient", _InProcessClient)
    M._BACKEND_READY = True  # this in-process app IS the backend
    with TestClient(app):
        yield app


# ── the loop ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_propose_list_approve_round_trip(in_process) -> None:
    proposed = await M.propose_action(
        "flag_entity",
        {"target_id": "vessel:636019825", "note": "AIS gap over 6 h", "severity": 4},
        confidence=0.7,
    )
    assert "error" not in proposed, proposed
    pid = proposed["id"]
    assert proposed["operator_only"] is False

    listed = await M.list_proposals()
    assert "error" not in listed, listed
    rows = listed.get("result", listed)
    assert [r["id"] for r in rows] == [pid]
    assert rows[0]["name"] == "flag_entity"

    approved = await M.approve_proposal(pid)
    assert "error" not in approved, approved
    assert approved["action"] == "flag_entity"
    assert approved["target_id"] == "vessel:636019825"
    # The receipt carries the audit row the execution wrote.
    assert approved["audit"]["action"] == "flag_entity"

    # And the queue is empty: approving consumes the proposal exactly once.
    assert (await M.list_proposals()).get("result", []) == []

    rows = await action_log_local.list_rows(10)
    assert rows[0]["action"] == "flag_entity"


@pytest.mark.asyncio
async def test_proposing_does_not_execute(in_process) -> None:
    """The whole point of the queue. If proposing ran the action, the human in
    the loop would be a notification, not a gate."""
    before = len(await action_log_local.list_rows(50))
    out = await M.propose_action("flag_entity", {"target_id": "aircraft:abc999"})
    assert "error" not in out, out
    assert len(await action_log_local.list_rows(50)) == before


@pytest.mark.asyncio
async def test_reject_drops_the_proposal_unexecuted(in_process) -> None:
    pid = (await M.propose_action("flag_entity", {"target_id": "aircraft:dead01"}))["id"]
    before = len(await action_log_local.list_rows(50))
    out = await M.reject_proposal(pid)
    assert out.get("ok") is True, out
    assert (await M.list_proposals()).get("result", []) == []
    assert len(await action_log_local.list_rows(50)) == before


# ── a write-back proposed through MCP ────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_writeback_can_be_proposed_and_approved_through_mcp(
    in_process, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The end-to-end AIP shape: an agent proposes a write to a source system,
    an operator approves, and the audited dispatch is what reaches it. Dry run,
    so this test asserts the governance path without opening a socket — the live
    dispatch is proven in ``test_writeback_action.py``."""
    monkeypatch.setenv("WORKFLOWS_HTTP_ALLOW_HOSTS", "erp.internal")
    proposed = await M.propose_action(
        "writeback",
        {
            "target": "http",
            "url": "http://erp.internal/api/cases",
            "payload": {"case_id": "CASE-9"},
            "dry_run": True,
        },
        confidence=0.9,
    )
    assert "error" not in proposed, proposed
    assert proposed["operator_only"] is True

    approved = await M.approve_proposal(proposed["id"])
    assert "error" not in approved, approved
    assert approved["detail"]["dry_run"] is True
    assert approved["detail"]["endpoint"] == "http://erp.internal/api/cases"
    assert "payload" not in approved["audit"]["params"]


@pytest.mark.asyncio
async def test_an_unknown_action_is_refused_at_propose_time(in_process) -> None:
    out = await M.propose_action("delete_everything", {})
    assert out["error"] == "backend_404", out


@pytest.mark.asyncio
async def test_malformed_params_are_refused_at_propose_time(in_process) -> None:
    out = await M.propose_action("writeback", {"target": "http", "payload": {}})
    assert out["error"] == "backend_400", out


@pytest.mark.asyncio
async def test_approving_an_unknown_proposal_is_a_404(in_process) -> None:
    out = await M.approve_proposal("nope")
    assert out["error"] == "backend_404", out


# ── the docstrings carry the multi-user caveat ───────────────────────────────


def test_the_write_tools_state_the_internal_token_is_never_a_user() -> None:
    """``apps/api/CLAUDE.md`` (Auth): the MCP's internal token is accepted at the
    API-key layer only and is never a user. A write-back has to be attributable
    to a person, so these tools 401 on a Supabase deployment BY DESIGN — and an
    agent that reads the docstring should learn that from the docstring rather
    than from a 401 it cannot explain."""
    for fn in (M.propose_action, M.list_proposals, M.approve_proposal, M.reject_proposal):
        doc = fn.__doc__ or ""
        assert "401" in doc, f"{fn.__name__} does not state its multi-user behaviour"
        assert "design" in doc, f"{fn.__name__} reads the 401 as a defect, not a decision"
