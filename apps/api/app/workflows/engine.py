"""Workflow DAG engine: validate → topo order → execute → persist.

Mirrors ``app/foundry/builds.py``'s shape (a build/run row created up front,
each step's outcome folded into an append-only log, failures caught and
turned into a "failed" record — never a 500) but walks a general block DAG
instead of a linear transform step list.
"""

from __future__ import annotations

import time
from collections import deque
from typing import Any

from app.keys import UserCtx
from app.workflows import blocks as blocks_mod
from app.workflows.store import WorkflowError, WorkflowStore

WALL_BUDGET_S = 300.0
TERMINAL_OUTPUT_SAMPLE = 200


def _validate_spec(spec: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Validate block ids/types/arity + edge references. Returns
    ``(blocks_by_id, edges)``. Raises ``WorkflowError`` (422) naming the
    problem — never raises anything else."""
    block_list = spec.get("blocks") or []
    edges = spec.get("edges") or []
    if not isinstance(block_list, list) or not block_list:
        raise WorkflowError(422, "workflow has no blocks")
    by_id: dict[str, dict[str, Any]] = {}
    for b in block_list:
        bid = b.get("id") if isinstance(b, dict) else None
        btype = b.get("type") if isinstance(b, dict) else None
        if not bid or not isinstance(bid, str):
            raise WorkflowError(422, "every block needs a string 'id'")
        if bid in by_id:
            raise WorkflowError(422, f"duplicate block id: {bid!r}")
        if btype not in blocks_mod.BLOCKS:
            raise WorkflowError(422, f"unknown block type: {btype!r}")
        by_id[bid] = b
    for e in edges:
        src, dst = e.get("from"), e.get("to")
        if src not in by_id or dst not in by_id:
            raise WorkflowError(422, f"edge references unknown block: {e}")
    in_count: dict[str, int] = dict.fromkeys(by_id, 0)
    for e in edges:
        in_count[e["to"]] += 1
    for bid, b in by_id.items():
        spec_block = blocks_mod.BLOCKS[b["type"]]
        n = in_count[bid]
        if n < spec_block.min_inputs or n > spec_block.max_inputs:
            raise WorkflowError(
                422,
                f"block {bid} ({b['type']}) expects "
                f"{spec_block.min_inputs}-{spec_block.max_inputs} input(s), got {n}",
            )
    return by_id, edges


def _topo_order(
    by_id: dict[str, dict[str, Any]], edges: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Kahn's algorithm. Any block not reachable in a valid topological order
    means a cycle — raised as a 422, never silently dropped."""
    indeg: dict[str, int] = dict.fromkeys(by_id, 0)
    adj: dict[str, list[str]] = {bid: [] for bid in by_id}
    for e in edges:
        adj[e["from"]].append(e["to"])
        indeg[e["to"]] += 1
    q: deque[str] = deque(bid for bid, d in indeg.items() if d == 0)
    order: list[str] = []
    while q:
        n = q.popleft()
        order.append(n)
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    if len(order) != len(by_id):
        raise WorkflowError(422, "workflow DAG contains a cycle")
    return [by_id[bid] for bid in order]


def _validate_dag(spec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_id, edges = _validate_spec(spec)
    order = _topo_order(by_id, edges)
    return order, edges


def _inputs_for(
    block_id: str, edges: list[dict[str, Any]], results: dict[str, list[dict]]
) -> list[list[dict]]:
    ids = [e["from"] for e in edges if e["to"] == block_id]
    return [results.get(i, []) for i in ids]


def _is_terminal(block_id: str, edges: list[dict[str, Any]]) -> bool:
    return not any(e["from"] == block_id for e in edges)


async def _run_one_block(
    block: dict[str, Any], inputs: list[list[dict]], ctx: blocks_mod.BlockCtx
) -> list[dict]:
    spec_block = blocks_mod.BLOCKS[block["type"]]
    config = block.get("config") or {}
    rows = await spec_block.run(config, inputs, ctx)
    if spec_block.category == "source" and ctx.preview:
        rows = rows[: blocks_mod.PREVIEW_SOURCE_CAP]
    return rows[: blocks_mod.ROW_CAP_PER_BLOCK]


async def run_workflow(
    store: WorkflowStore, workflow: dict[str, Any], ctx: UserCtx, trigger: str
) -> dict[str, Any]:
    """Execute a SAVED workflow end to end: create the run row, validate the
    DAG, run every block in topo order, persist the log/output/memory, and
    finish the run — success or failure, always a run row, never a raised
    exception past this function."""
    run = await store.create_run(workflow["id"], trigger)
    log: list[str] = [f"run {run['id']} started for workflow {workflow['name']!r}"]

    try:
        order, edges = _validate_dag(workflow["spec"])
    except WorkflowError as exc:
        log.append(f"error: {exc.detail}")
        return await store.finish_run(run["id"], "failed", log, exc.detail, {})

    memory = await store.get_memory(workflow["id"])
    block_ctx = blocks_mod.BlockCtx(user_ctx=ctx, workflow_id=workflow["id"], memory=memory)

    results: dict[str, list[dict]] = {}
    outputs: dict[str, Any] = {}
    status = "succeeded"
    error: str | None = None
    started = time.monotonic()

    for block in order:
        if time.monotonic() - started > WALL_BUDGET_S:
            status = "failed"
            error = f"workflow exceeded the {WALL_BUDGET_S:g}s wall budget"
            log.append(f"error: {error}")
            break
        inputs = _inputs_for(block["id"], edges, results)
        rows_in = sum(len(x) for x in inputs)
        t0 = time.monotonic()
        try:
            out_rows = await _run_one_block(block, inputs, block_ctx)
        except Exception as exc:  # noqa: BLE001 — a block failure fails the RUN, never the request
            status = "failed"
            error = f"{block['id']} ({block['type']}): {exc}"
            dt_ms = int((time.monotonic() - t0) * 1000)
            log.append(f"[{block['id']}] {block['type']} {rows_in}→ERROR {dt_ms}ms: {exc}")
            break
        dt_ms = int((time.monotonic() - t0) * 1000)
        results[block["id"]] = out_rows
        log.append(f"[{block['id']}] {block['type']} {rows_in}→{len(out_rows)} {dt_ms}ms")
        if _is_terminal(block["id"], edges):
            outputs[block["id"]] = out_rows[:TERMINAL_OUTPUT_SAMPLE]

    await store.set_memory_all(workflow["id"], block_ctx.memory)
    return await store.finish_run(run["id"], status, log, error, outputs)


async def preview_workflow(spec: dict[str, Any], ctx: UserCtx) -> dict[str, Any]:
    """Run an UNSAVED spec (the editor's live form state) with source rows
    capped small, no run row persisted, no memory persisted — returns
    per-block row counts + a sample so the editor can show every block's
    state at once, not just the final terminal output."""
    order, edges = _validate_dag(spec)
    memory: dict[str, Any] = {}
    block_ctx = blocks_mod.BlockCtx(
        user_ctx=ctx, workflow_id="__preview__", memory=memory, preview=True
    )
    results: dict[str, list[dict]] = {}
    per_block: dict[str, dict[str, Any]] = {}
    for block in order:
        inputs = _inputs_for(block["id"], edges, results)
        rows_in = sum(len(x) for x in inputs)
        try:
            out_rows = await _run_one_block(block, inputs, block_ctx)
        except Exception as exc:  # noqa: BLE001 — surfaced per-block, not a 500
            results[block["id"]] = []
            per_block[block["id"]] = {
                "type": block["type"],
                "rows_in": rows_in,
                "rows_out": 0,
                "sample": [],
                "error": str(exc),
            }
            continue
        results[block["id"]] = out_rows
        per_block[block["id"]] = {
            "type": block["type"],
            "rows_in": rows_in,
            "rows_out": len(out_rows),
            "sample": out_rows[:20],
            "error": None,
        }
    return {"blocks": per_block}
