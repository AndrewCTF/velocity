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

import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.intel.actions import ActionResult, dispatch, list_actions
from app.keys import UserCtx, current_user

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
# SAME audited ``dispatch`` path above. In-memory + single-process: a restart
# drops pending proposals, which is acceptable — the agent re-proposes on its
# next run.
_PROPOSALS: dict[str, dict] = {}
PROPOSAL_TTL_S = 900


def _prune_proposals() -> None:
    cutoff = time.time() - PROPOSAL_TTL_S
    for pid in [p for p, row in _PROPOSALS.items() if row["created"] < cutoff]:
        _PROPOSALS.pop(pid, None)


def propose(name: str, params: dict, ctx, confidence: float = 0.0) -> str:
    """Queue action ``name`` with ``params`` for operator approval; returns its id."""
    _prune_proposals()
    pid = uuid.uuid4().hex[:12]
    _PROPOSALS[pid] = {
        "id": pid, "name": name, "params": params,
        "created": time.time(), "confidence": confidence,
    }
    return pid


@router.get("/api/actions/proposals")
async def list_proposals(ctx: UserCtx = Depends(current_user)) -> list[dict]:
    """Pending proposals awaiting operator approval, oldest first."""
    _prune_proposals()
    return sorted(_PROPOSALS.values(), key=lambda r: r["created"])


@router.post("/api/actions/proposals/{pid}/approve")
async def approve_proposal(pid: str, ctx: UserCtx = Depends(current_user)):
    """Approve + execute a queued proposal through the audited ``dispatch`` path.

    The audit row's actor is the approving ``ctx`` (``ctx.user_id``) — that is the
    fact that matters — so the approval is attributed without threading extras
    through dispatch. 404 for an unknown or expired proposal.
    """
    _prune_proposals()
    row = _PROPOSALS.pop(pid, None)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return await dispatch(row["name"], row["params"], ctx)


@router.post("/api/actions/proposals/{pid}/reject")
async def reject_proposal(pid: str, ctx: UserCtx = Depends(current_user)) -> dict:
    """Drop a queued proposal without executing it. 404 if unknown/expired."""
    row = _PROPOSALS.pop(pid, None)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return {"ok": True, "id": pid}
