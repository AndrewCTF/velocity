"""Governed write-back routes — /api/actions/* (Track C1).

Dispatches a typed action against the action registry in ``intel/actions.py``:
the action validates its params, mutates the ontology, fires its side effect
(target board / alert rule), and appends an audit row to ``action_log``.

  GET  /api/actions               → catalog of registered actions + param schema
  POST /api/actions/{name}        → run the action with a JSON body of params

Auth is ``current_user`` (a real signed-in user — the audit log records WHO via
``ctx.user_id``; there is NO role field, so this is audit-of-who, not RBAC). The
action handlers degrade to 503 when Supabase is unconfigured.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.config import get_settings
from app.intel import action_proposals_local
from app.intel.actions import ActionResult, dispatch, list_actions
from app.keys import UserCtx, current_user, multi_user

router = APIRouter(tags=["actions"])


@router.get("/api/actions")
async def actions_catalog(ctx: UserCtx = Depends(current_user)) -> list[dict[str, Any]]:
    """List the registered actions and the params each expects (for the UI / agent)."""
    return list_actions()


@router.post("/api/actions/{name}", response_model=ActionResult)
async def run_action(
    name: str,
    params: dict[str, Any],
    ctx: UserCtx = Depends(current_user),
) -> ActionResult:
    """Validate + execute action ``name`` with ``params`` (a JSON object body).

    ``params`` is the request body — a single JSON object of the action's params
    (each action validates its own shape, so a missing required field is a 400,
    not a silent default). 404 for an unknown action, 502/503 propagated from the
    store layer. Returns a uniform receipt incl. the audit row.
    """
    return await dispatch(name, params, ctx)


# ── Human-in-the-loop proposal queue (HITL gate) ─────────────────────────────
# When approval mode is ON (config.action_approval), the intel agent stores its
# write-back actions here as PROPOSALS instead of dispatching them directly; the
# operator approves/rejects in AgentConsole and approval executes through the
# SAME audited ``dispatch`` path above.
#
# Persisted (``intel/action_proposals_local.py``), not a module dict. It WAS a
# dict, on the reasoning that "the agent re-proposes on its next run" — which
# only holds if the agent runs again. An operator who left proposals open
# overnight and restarted the backend came back to an empty queue with no
# record that anything had been waiting.
PROPOSAL_TTL_S = 900


async def propose(name: str, params: dict, ctx, confidence: float = 0.0) -> str:
    """Queue action ``name`` with ``params`` for operator approval; returns its id.
    The proposing user is recorded as the owner."""
    owner = getattr(ctx, "user_id", None)
    return await action_proposals_local.add(
        name, params, confidence, PROPOSAL_TTL_S, owner=owner
    )


async def _is_admin(ctx: UserCtx) -> bool:
    from app.security import _fetch_profile  # noqa: PLC0415

    prof = await _fetch_profile(ctx, get_settings())
    return "admin" in (prof.get("roles") or ())


async def _may_decide(row: dict, ctx: UserCtx | None) -> bool:
    """ASVS V8.2.2: on a multi-user deployment a proposal is seen and decided by
    the user whose agent run proposed it, or an admin. A row with no owner
    (queued before owners were recorded) is admin-only. Single-user: anyone
    who got past auth is the operator."""
    if ctx is None or not multi_user():
        return True
    if row.get("owner") and row.get("owner") == ctx.user_id:
        return True
    return await _is_admin(ctx)


def _public(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "owner"}


@router.get("/api/actions/proposals")
async def list_proposals(ctx: UserCtx = Depends(current_user)) -> list[dict]:
    """Pending proposals awaiting operator approval, oldest first."""
    rows = await action_proposals_local.list_pending(PROPOSAL_TTL_S)
    if ctx is not None and multi_user():
        admin = await _is_admin(ctx)
        rows = [r for r in rows if admin or (r.get("owner") and r["owner"] == ctx.user_id)]
    return [_public(r) for r in rows]


@router.post("/api/actions/proposals/{pid}/approve")
async def approve_proposal(pid: str, ctx: UserCtx = Depends(current_user)):
    """Approve + execute a queued proposal through the audited ``dispatch`` path.

    The audit row's actor is the approving ``ctx`` (``ctx.user_id``) — that is the
    fact that matters — so the approval is attributed without threading extras
    through dispatch. 404 for an unknown or expired proposal.

    ``take`` removes the row before dispatching, so a double-click approves once.
    """
    # 404, not 403, for someone else's: the id space is not an oracle.
    peeked = await action_proposals_local.peek(pid, PROPOSAL_TTL_S)
    if peeked is None or not await _may_decide(peeked, ctx):
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    row = await action_proposals_local.take(pid, PROPOSAL_TTL_S)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return await dispatch(row["name"], row["params"], ctx)


@router.post("/api/actions/proposals/{pid}/reject")
async def reject_proposal(pid: str, ctx: UserCtx = Depends(current_user)) -> dict:
    """Drop a queued proposal without executing it. 404 if unknown/expired."""
    peeked = await action_proposals_local.peek(pid, PROPOSAL_TTL_S)
    if peeked is None or not await _may_decide(peeked, ctx):
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    if await action_proposals_local.take(pid, PROPOSAL_TTL_S) is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return {"ok": True, "id": pid}
