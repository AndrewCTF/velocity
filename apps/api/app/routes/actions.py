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

from fastapi import APIRouter, Depends

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
