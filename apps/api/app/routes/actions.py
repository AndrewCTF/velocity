"""Governed write-back routes — /api/actions/* (Track C1).

Dispatches a typed action against the action registry in ``intel/actions.py``:
the action validates its params, mutates the ontology, fires its side effect
(target board / alert rule), and appends an audit row to ``action_log``.

  GET  /api/actions                 → catalog of registered actions + param schema
  POST /api/actions/proposals       → queue an action for operator approval
  GET  /api/actions/proposals       → the pending queue
  POST /api/actions/proposals/{id}/approve|reject
  POST /api/actions/{name}          → run the action with a JSON body of params

Auth is ``current_user_or_local`` (2026-09-17, W4): the audit log records WHO
via ``ctx.user_id``, and on a keyless box that is the shared ``local`` identity,
exactly the decision the ontology took on 2026-07-07. It was ``current_user``,
which can only ever resolve against Supabase, so every governed action 401'd on
the deployment this platform ships as its default — while the store layer
underneath (``intel/actions._append_audit`` → ``action_log_local``) had had a
keyless sink since that same 2026-07-07 decision. Multi-user semantics are
unchanged: with Supabase configured this IS ``current_user``, and the
owner-scoping in ``_may_decide`` still applies.

There is no role field on ``UserCtx``, so the *who* is audit-of-who, not RBAC.
Authority that goes beyond an analyst's is carried by the action instead:
``ActionSpec.operator_only`` puts ``require_operator`` in front of a write-back
to a source system, on the direct path and on proposal approval alike.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.intel import action_proposals_local
from app.intel.actions import ActionResult, dispatch, get_action, list_actions
from app.keys import UserCtx, current_user_or_local, multi_user
from app.security import Principal, current_principal_or_local, require_operator

router = APIRouter(tags=["actions"])


@router.get("/api/actions")
async def actions_catalog(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    """List the registered actions and the params each expects (for the UI / agent)."""
    return list_actions()


async def _require_operator_for(name: str, principal: Principal) -> None:
    """``require_operator`` when the registered action is ``operator_only``.

    Called with the resolved principal rather than wired as a route dependency:
    the gate depends on WHICH action is being run, which FastAPI cannot know at
    dependency-resolution time. Keyless, ``require_operator`` returns
    immediately (one user, who is the operator); multi-user it demands admin +
    MFA + a live account, and raises the 403/401 itself.
    """
    spec = get_action(name)
    if spec is not None and spec.operator_only:
        await require_operator(principal)


class ProposalIn(BaseModel):
    """Body of ``POST /api/actions/proposals`` — the MCP write path's front door."""

    name: str = Field(..., min_length=1, max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(0.0, ge=0.0, le=1.0)


# Registered BEFORE ``POST /api/actions/{name}``: Starlette matches in
# registration order and "proposals" is a perfectly good ``{name}``, so the
# catch-all would otherwise swallow this route and answer 404 "unknown action:
# proposals".
@router.post("/api/actions/proposals")
async def create_proposal(
    body: ProposalIn,
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    """Queue an action for operator approval instead of running it.

    The agent-facing half of the HITL gate, and the only write path the MCP
    server has: an agent proposes, a human approves, and approval executes
    through the same audited ``dispatch``. Validated HERE — an unknown action is
    a 404 and bad params are a 400 — so a malformed proposal cannot sit in the
    queue looking legitimate until an operator signs for it and only then fails.
    """
    spec = get_action(body.name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"unknown action: {body.name}")
    try:
        spec.params_model(**body.params)
    except Exception as exc:  # noqa: BLE001 — pydantic ValidationError → 400
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    pid = await propose(body.name, body.params, ctx, body.confidence)
    return {"id": pid, "name": body.name, "operator_only": spec.operator_only}


@router.post("/api/actions/{name}", response_model=ActionResult)
async def run_action(
    name: str,
    params: dict[str, Any],
    ctx: UserCtx = Depends(current_user_or_local),
    principal: Principal = Depends(current_principal_or_local),
) -> ActionResult:
    """Validate + execute action ``name`` with ``params`` (a JSON object body).

    ``params`` is the request body — a single JSON object of the action's params
    (each action validates its own shape, so a missing required field is a 400,
    not a silent default). 404 for an unknown action, 403 when the action is
    ``operator_only`` and the caller is not the operator, 502/503 propagated from
    the store layer. Returns a uniform receipt incl. the audit row.
    """
    await _require_operator_for(name, principal)
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
async def list_proposals(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict]:
    """Pending proposals awaiting operator approval, oldest first."""
    rows = await action_proposals_local.list_pending(PROPOSAL_TTL_S)
    if ctx is not None and multi_user():
        admin = await _is_admin(ctx)
        rows = [r for r in rows if admin or (r.get("owner") and r["owner"] == ctx.user_id)]
    return [_public(r) for r in rows]


@router.post("/api/actions/proposals/{pid}/approve")
async def approve_proposal(
    pid: str,
    ctx: UserCtx = Depends(current_user_or_local),
    principal: Principal = Depends(current_principal_or_local),
):
    """Approve + execute a queued proposal through the audited ``dispatch`` path.

    The audit row's actor is the approving ``ctx`` (``ctx.user_id``) — that is the
    fact that matters — so the approval is attributed without threading extras
    through dispatch. 404 for an unknown or expired proposal.

    ``take`` removes the row before dispatching, so a double-click approves once.

    An ``operator_only`` action is gated here too, and the check happens BEFORE
    ``take``: a non-operator who tries to approve a write-back must be refused
    without the proposal disappearing from the queue on the way.
    """
    # 404, not 403, for someone else's: the id space is not an oracle.
    peeked = await action_proposals_local.peek(pid, PROPOSAL_TTL_S)
    if peeked is None or not await _may_decide(peeked, ctx):
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    await _require_operator_for(str(peeked.get("name") or ""), principal)
    row = await action_proposals_local.take(pid, PROPOSAL_TTL_S)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return await dispatch(row["name"], row["params"], ctx)


@router.post("/api/actions/proposals/{pid}/reject")
async def reject_proposal(pid: str, ctx: UserCtx = Depends(current_user_or_local)) -> dict:
    """Drop a queued proposal without executing it. 404 if unknown/expired."""
    peeked = await action_proposals_local.peek(pid, PROPOSAL_TTL_S)
    if peeked is None or not await _may_decide(peeked, ctx):
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    if await action_proposals_local.take(pid, PROPOSAL_TTL_S) is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return {"ok": True, "id": pid}
