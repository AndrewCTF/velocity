"""HITL action-proposal queue (Task 3) — hermetic unit tests.

The intel agent's write-back actions (flag_entity / promote_incident / …) are
gated behind an operator approval step: instead of dispatching directly, the
agent stores a PROPOSAL that the operator approves/rejects in AgentConsole.
Approval executes through the SAME audited ``intel/actions.dispatch`` path.

The queue is PERSISTED (``intel/action_proposals_local.py``). It was a module
dict, which meant a restart silently emptied the approval queue — an operator
who left proposals open overnight came back to none, with no record that
anything had been waiting. ``test_a_restart_does_not_empty_the_queue`` is the
guard for that; the rest is behaviour that must survive the move.

These tests are fully hermetic — ``dispatch`` is monkeypatched so no Supabase /
ontology is touched, the queue DB is a per-test temp file (conftest), and the
routes are exercised in-process with ``ctx=None`` (the keyless path, exactly as
the other route tests in this suite do).
"""

from __future__ import annotations

import time

import pytest

from app.intel import action_proposals_local as store
from app.routes import actions as actions_mod

# Captured before any test patches time.time, so "later than the TTL" is a
# fixed point rather than something that drifts with the clock under the patch.
_T0 = time.time()


def _later(ttl: float) -> float:
    return _T0 + ttl + 60


@pytest.mark.anyio
async def test_propose_stores_and_lists() -> None:
    pid = await actions_mod.propose(
        "flag_entity", {"entity_id": "vessel:1"}, ctx=None, confidence=0.4
    )
    rows = await actions_mod.list_proposals(ctx=None)
    assert [r["id"] for r in rows] == [pid]
    assert rows[0]["name"] == "flag_entity"
    assert rows[0]["params"] == {"entity_id": "vessel:1"}
    assert rows[0]["confidence"] == 0.4


@pytest.mark.anyio
async def test_proposals_list_oldest_first() -> None:
    first = await actions_mod.propose("flag_entity", {"n": 1}, ctx=None)
    second = await actions_mod.propose("flag_entity", {"n": 2}, ctx=None)
    rows = await actions_mod.list_proposals(ctx=None)
    assert [r["id"] for r in rows] == [first, second]


@pytest.mark.anyio
async def test_a_restart_does_not_empty_the_queue() -> None:
    """The reason this store exists. Nothing is held in the process, so a fresh
    read against the same file still sees the pending work."""
    pid = await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    # A restart is exactly this: no in-process state, same file on disk.
    rows = await store.list_pending(actions_mod.PROPOSAL_TTL_S)
    assert [r["id"] for r in rows] == [pid]


@pytest.mark.anyio
async def test_expired_proposal_is_not_listed(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    pid = await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    monkeypatch.setattr(time, "time", lambda: _later(actions_mod.PROPOSAL_TTL_S))
    assert await actions_mod.list_proposals(ctx=None) == []
    assert await store.take(pid, actions_mod.PROPOSAL_TTL_S) is None


@pytest.mark.anyio
async def test_expiry_is_enforced_on_read_not_only_on_prune(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """After a restart nothing has pruned yet, so a row that aged out while the
    process was down must still not come back looking live."""
    await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    monkeypatch.setattr(time, "time", lambda: _later(actions_mod.PROPOSAL_TTL_S))
    assert await store.list_pending(actions_mod.PROPOSAL_TTL_S) == []


@pytest.mark.anyio
async def test_prune_removes_expired_rows(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    monkeypatch.setattr(time, "time", lambda: _later(actions_mod.PROPOSAL_TTL_S))
    assert await store.prune(actions_mod.PROPOSAL_TTL_S) == 1
    assert await store.prune(actions_mod.PROPOSAL_TTL_S) == 0


@pytest.mark.anyio
async def test_approve_executes_and_removes(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    calls: list[tuple] = []

    async def fake_dispatch(name, params, ctx):  # type: ignore[no-untyped-def]
        calls.append((name, params))
        return {"ok": True, "action": name}

    monkeypatch.setattr(actions_mod, "dispatch", fake_dispatch)
    pid = await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    result = await actions_mod.approve_proposal(pid, ctx=None)
    assert calls == [("flag_entity", {"entity_id": "v"})]
    assert await actions_mod.list_proposals(ctx=None) == []
    assert result["ok"] is True


@pytest.mark.anyio
async def test_approving_twice_executes_once(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The row is taken before dispatch, so a double-click cannot run the same
    write-back twice."""
    calls: list[str] = []

    async def fake_dispatch(name, params, ctx):  # type: ignore[no-untyped-def]
        calls.append(name)
        return {"ok": True}

    monkeypatch.setattr(actions_mod, "dispatch", fake_dispatch)
    pid = await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    await actions_mod.approve_proposal(pid, ctx=None)
    with pytest.raises(Exception) as exc:
        await actions_mod.approve_proposal(pid, ctx=None)
    assert getattr(exc.value, "status_code", None) == 404
    assert calls == ["flag_entity"]


@pytest.mark.anyio
async def test_reject_removes_without_execute(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    async def boom(name, params, ctx):  # type: ignore[no-untyped-def]
        raise AssertionError("dispatch called on reject")

    monkeypatch.setattr(actions_mod, "dispatch", boom)
    pid = await actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None)
    out = await actions_mod.reject_proposal(pid, ctx=None)
    assert out == {"ok": True, "id": pid}
    assert await actions_mod.list_proposals(ctx=None) == []


@pytest.mark.anyio
async def test_unknown_id_is_a_404() -> None:
    with pytest.raises(Exception) as exc:
        await actions_mod.reject_proposal("nope", ctx=None)
    assert getattr(exc.value, "status_code", None) == 404
