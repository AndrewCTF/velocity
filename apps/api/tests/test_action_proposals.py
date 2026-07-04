"""HITL action-proposal queue (Task 3) — hermetic unit tests.

The intel agent's write-back actions (flag_entity / promote_incident / …) are
gated behind an operator approval step: instead of dispatching directly, the
agent stores a PROPOSAL that the operator approves/rejects in AgentConsole.
Approval executes through the SAME audited ``intel/actions.dispatch`` path.

These tests are fully hermetic — ``dispatch`` is monkeypatched so no Supabase /
ontology is touched, and the routes are exercised in-process with ``ctx=None``
(the keyless path, exactly as the other route tests in this suite do).
"""

from __future__ import annotations

import time

import pytest

from app.routes import actions as actions_mod


@pytest.fixture(autouse=True)
def _clean_proposals():
    actions_mod._PROPOSALS.clear()
    yield
    actions_mod._PROPOSALS.clear()


def test_propose_stores_and_lists():
    pid = actions_mod.propose("flag_entity", {"entity_id": "vessel:1"}, ctx=None, confidence=0.4)
    assert pid in actions_mod._PROPOSALS
    row = actions_mod._PROPOSALS[pid]
    assert row["name"] == "flag_entity"
    assert row["params"] == {"entity_id": "vessel:1"}
    assert row["confidence"] == 0.4


def test_expired_proposal_pruned():
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    actions_mod._PROPOSALS[pid]["created"] = time.time() - actions_mod.PROPOSAL_TTL_S - 1
    actions_mod._prune_proposals()
    assert pid not in actions_mod._PROPOSALS


@pytest.mark.asyncio
async def test_approve_executes_and_removes(monkeypatch):
    calls: list[tuple] = []

    async def fake_dispatch(name, params, ctx):
        calls.append((name, params))
        return {"ok": True, "action": name}

    monkeypatch.setattr(actions_mod, "dispatch", fake_dispatch)
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    result = await actions_mod.approve_proposal(pid, ctx=None)
    assert calls == [("flag_entity", {"entity_id": "v"})]
    assert pid not in actions_mod._PROPOSALS
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_reject_removes_without_execute(monkeypatch):
    async def boom(name, params, ctx):  # must never run
        raise AssertionError("dispatch called on reject")

    monkeypatch.setattr(actions_mod, "dispatch", boom)
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    out = await actions_mod.reject_proposal(pid, ctx=None)
    assert out == {"ok": True, "id": pid}
    assert pid not in actions_mod._PROPOSALS
