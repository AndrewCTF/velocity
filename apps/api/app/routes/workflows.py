"""Workflows routes — ``/api/workflows/*`` (docs/dashboard-workflows-plan.md
section 2). User-authored DAG pipelines over live platform data. Keyless via
``current_user_or_local`` — same discipline as ``routes/foundry.py``; the
store itself is not user-scoped (single-operator local SQLite).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.keys import UserCtx, current_user_or_local
from app.workflows import blocks as blocks_mod
from app.workflows import engine
from app.workflows.python_exec import MAX_TIMEOUT_S
from app.workflows.store import WorkflowError, WorkflowStore

router = APIRouter(tags=["workflows"])


def _store() -> WorkflowStore:
    return WorkflowStore()


def _raise(exc: WorkflowError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _clamp_python_timeouts(spec: dict[str, Any]) -> dict[str, Any]:
    """Clamp every ``op.python`` block's ``config.timeout_s`` to [1, MAX] at
    the API boundary — a saved/previewed spec can never request more wall
    time than the platform allows, regardless of what the editor sent.
    (Internal callers that go straight through ``python_exec.run_python_block``
    — e.g. tests exercising the timeout-kill path — are NOT routed through
    here and may use any ``timeout_s`` ≥ 1.)"""
    for b in spec.get("blocks") or []:
        if not isinstance(b, dict) or b.get("type") != "op.python":
            continue
        cfg = b.get("config")
        if not isinstance(cfg, dict) or "timeout_s" not in cfg:
            continue
        try:
            t = float(cfg["timeout_s"])
        except (TypeError, ValueError):
            continue
        cfg["timeout_s"] = max(1.0, min(MAX_TIMEOUT_S, t))
    return spec


# ── request/response models ─────────────────────────────────────────────────


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    spec: dict[str, Any] = Field(default_factory=lambda: {"blocks": [], "edges": []})
    enabled: bool = True


class PreviewSpecIn(BaseModel):
    """An UNSAVED workflow spec — the editor's live form state."""

    blocks: list[dict[str, Any]] = Field(default_factory=list)
    edges: list[dict[str, Any]] = Field(default_factory=list)


class ScheduleIn(BaseModel):
    workflow_id: str
    interval_s: int = Field(ge=1)
    enabled: bool = True


class MemoryIn(BaseModel):
    memory: dict[str, Any] = Field(default_factory=dict)


# ── block catalog ────────────────────────────────────────────────────────────


@router.get("/api/workflows/blocks")
async def list_blocks(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return blocks_mod.catalog()


# ── preview (unsaved spec) ──────────────────────────────────────────────────


@router.post("/api/workflows/preview")
async def preview_workflow(
    body: PreviewSpecIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    spec = _clamp_python_timeouts({"blocks": body.blocks, "edges": body.edges})
    try:
        return await engine.preview_workflow(spec, ctx)
    except WorkflowError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover


# ── runs (declared before the parameterized workflow routes — same reason
#    routes/foundry.py declares its spec-preview route early: a literal
#    segment must win over a same-position {workflow_id} param) ────────────


@router.get("/api/workflows/runs/{run_id}")
async def get_run(run_id: str, ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    r = await _store().get_run(run_id)
    if r is None:
        raise HTTPException(status_code=404, detail="run not found")
    return r


# ── schedules (literal path — declared before {workflow_id}) ────────────────


@router.get("/api/workflows/schedules")
async def list_schedules(
    workflow_id: str | None = Query(None), ctx: UserCtx = Depends(current_user_or_local)
) -> list[dict[str, Any]]:
    return await _store().list_schedules(workflow_id)


@router.post("/api/workflows/schedules")
async def create_schedule(
    body: ScheduleIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    wf = await store.get_workflow(body.workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return await store.create_schedule(body.workflow_id, body.interval_s, body.enabled)


@router.put("/api/workflows/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str, body: ScheduleIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    updated = await _store().update_schedule(schedule_id, body.interval_s, body.enabled)
    if updated is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    return updated


@router.delete("/api/workflows/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_schedule(schedule_id)
    return {"ok": True}


# ── workflows CRUD ───────────────────────────────────────────────────────────


@router.get("/api/workflows")
async def list_workflows(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return await _store().list_workflows()


@router.post("/api/workflows")
async def create_workflow(
    body: WorkflowIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    spec = _clamp_python_timeouts(body.spec)
    store = _store()
    try:
        return await store.create_workflow(body.name, body.description, spec, body.enabled)
    except WorkflowError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover


@router.get("/api/workflows/{workflow_id}")
async def get_workflow(
    workflow_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    wf = await _store().get_workflow(workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return wf


@router.put("/api/workflows/{workflow_id}")
async def update_workflow(
    workflow_id: str, body: WorkflowIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    spec = _clamp_python_timeouts(body.spec)
    updated = await _store().update_workflow(
        workflow_id, body.name, body.description, spec, body.enabled
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return updated


@router.delete("/api/workflows/{workflow_id}")
async def delete_workflow(
    workflow_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_workflow(workflow_id)
    return {"ok": True}


@router.post("/api/workflows/{workflow_id}/run")
async def run_workflow_now(
    workflow_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    wf = await store.get_workflow(workflow_id)
    if wf is None:
        raise HTTPException(status_code=404, detail="workflow not found")
    return await engine.run_workflow(store, wf, ctx, trigger="manual")


@router.get("/api/workflows/{workflow_id}/runs")
async def list_workflow_runs(
    workflow_id: str,
    limit: int = Query(50, ge=1, le=500),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[dict[str, Any]]:
    return await _store().list_runs(workflow_id, limit=limit)


@router.get("/api/workflows/{workflow_id}/memory")
async def get_memory(
    workflow_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    return {"memory": await _store().get_memory(workflow_id)}


@router.put("/api/workflows/{workflow_id}/memory")
async def put_memory(
    workflow_id: str, body: MemoryIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Replace a workflow's whole memory (an empty body resets it)."""
    await _store().set_memory_all(workflow_id, body.memory)
    return {"memory": await _store().get_memory(workflow_id)}
