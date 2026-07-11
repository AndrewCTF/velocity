"""Build runner: run one transform (writes a new output-dataset version) or
the whole pipeline topologically. Also derives the lineage graph from the
current transform definitions, tracks which input dataset versions a build
consumed (staleness), and rejects transform writes that would introduce a
cycle in the dataset<->transform DAG."""

from __future__ import annotations

from collections import deque
from typing import Any

from app.foundry import binding as binding_mod
from app.foundry import transforms as tf
from app.foundry.ingest import infer_schema
from app.foundry.store import FoundryError, FoundryStore
from app.keys import UserCtx

# Default identity for auto-sync when a caller doesn't thread one through yet
# (routes/foundry.py's build endpoints don't pass ctx today — same fallback
# ``current_user_or_local`` uses on a keyless boot, keys.py:172).
_LOCAL_CTX = UserCtx(user_id="local", token="")


_PREVIEW_QUARANTINE_SAMPLE = 20


async def _evaluate_build_failed_monitors(
    store: FoundryStore, transform: dict[str, Any], error: str
) -> None:
    """Fire ``build_failed`` monitors on a transform's declared output
    dataset — evaluation is fire-and-forget-safe (never raises) so a monitor
    bug can never mask the real build failure being recorded."""
    from app.foundry import (
        monitors as monitors_mod,  # noqa: PLC0415 — break the builds<->monitors cycle
    )

    await monitors_mod.evaluate_monitors(
        store,
        transform["output_dataset_id"],
        trigger_kind="build_failed",
        context={"error": error, "transform_name": transform.get("name")},
    )


async def _execute_transform(
    store: FoundryStore, transform: dict[str, Any], quarantine: tf.QuarantineSink | None
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Resolve every referenced dataset, run the transform's steps, and return
    ``(rows, schema)``. Shared by preview and build so both apply identical
    provider resolution and row-level quarantine semantics."""
    if not transform["inputs"]:
        raise FoundryError(422, "transform has no inputs")
    base_rows = await store.latest_rows(transform["inputs"][0])

    # run_steps is sync; resolve every referenced dataset up front so its
    # provider callback stays a plain sync function.
    referenced = {
        step["right"]
        for step in transform["steps"]
        if step.get("type") in ("join", "union") and "right" in step
    }
    cache: dict[str, list[dict[str, Any]]] = {}
    for did in referenced:
        # latest_rows() returns [] for an unknown id — without this guard a
        # join against a missing dataset silently null-fills and "succeeds".
        if await store.get_dataset(did) is None:
            raise FoundryError(422, f"join/union references unknown dataset '{did}'")
        cache[did] = await store.latest_rows(did)

    def provider(dataset_id: str) -> list[dict[str, Any]]:
        return cache.get(dataset_id, [])

    rows = tf.run_steps(transform["steps"], base_rows, provider, quarantine)
    schema = infer_schema(rows)
    return rows, schema


async def preview_transform(
    store: FoundryStore, transform: dict[str, Any], limit: int = 20
) -> dict[str, Any]:
    """Run a transform's steps without writing a version. Rows whose
    filter/derive expression raises are quarantined (not fatal) and surfaced
    as ``quarantined`` + a small ``quarantine_sample`` so the author sees bad
    rows in the preview instead of a 500."""
    quarantine = tf.QuarantineSink()
    rows, schema = await _execute_transform(store, transform, quarantine)
    return {
        "schema": schema,
        "rows": rows[: max(0, int(limit))],
        "quarantined": quarantine.count,
        "quarantine_sample": quarantine.rows[:_PREVIEW_QUARANTINE_SAMPLE],
    }


def _referenced_dataset_ids(transform: dict[str, Any]) -> set[str]:
    """Every dataset a transform actually reads: its declared ``inputs`` plus
    any ``right`` dataset referenced by a join/union step."""
    ids = set(transform["inputs"])
    for step in transform["steps"]:
        if step.get("type") in ("join", "union") and "right" in step:
            ids.add(step["right"])
    return ids


async def resolve_input_versions(store: FoundryStore, transform: dict[str, Any]) -> dict[str, int]:
    """``{dataset_id: latest_version}`` for every dataset a transform reads
    right now — the same resolution ``preview_transform``/``run_transform_build``
    use, captured for staleness tracking."""
    versions: dict[str, int] = {}
    for did in _referenced_dataset_ids(transform):
        ds = await store.get_dataset(did)
        if ds is not None:
            versions[did] = ds["latest_version"]
    return versions


async def transform_is_stale(store: FoundryStore, transform: dict[str, Any]) -> bool:
    """Stale iff the transform has no successful build, or any input
    dataset's latest version differs from what its most recent successful
    build consumed."""
    last = await store.most_recent_successful_build_for_transform(transform["id"])
    if last is None:
        return True
    recorded = last.get("input_versions") or {}
    current = await resolve_input_versions(store, transform)
    return current != recorded


async def run_transform_build(
    store: FoundryStore, transform_id: str, ctx: UserCtx | None = None
) -> dict[str, Any]:
    """Execute one transform, writing a new version of its output dataset.

    On success, auto-syncs every ENABLED binding on the output dataset (the
    Kinetic-layer behavior: data changes propagate to the ontology without a
    button press — docs/foundry-gap-analysis-2026-07-08.md row 8). ``ctx``
    defaults to the shared local identity since existing callers
    (routes/foundry.py) don't thread one through yet; a later wave can pass
    the real caller ctx.
    """
    transform = await store.get_transform(transform_id)
    if transform is None:
        raise FoundryError(404, "transform not found")
    build = await store.create_build(transform_id, scope="transform")
    input_versions = await resolve_input_versions(store, transform)
    await store.set_build_input_versions(build["id"], input_versions)
    log: list[str] = [f"build {build['id']} started for transform {transform['name']}"]
    try:
        quarantine = tf.QuarantineSink()
        rows, schema = await _execute_transform(store, transform, quarantine)
        log.append(f"executed {len(transform['steps'])} step(s), {len(rows)} row(s) out")
        if quarantine.count:
            log.append(
                f"quarantined {quarantine.count} row(s) that raised during"
                f" filter/derive (dead-letter, kept {len(quarantine.rows)})"
            )
        # add_version enforces checks/row-cap and can RAISE — do it FIRST so a
        # rejected write leaves the previous live version's dead-letter intact.
        await store.add_version(
            transform["output_dataset_id"], rows, schema, source=f"build:{build['id']}"
        )
        log.append(f"wrote new version of dataset {transform['output_dataset_id']}")
        # Only now that the new version is committed, replace its dead-letter
        # (empty list clears a prior build's stale rows).
        await store.record_dead_letter(
            transform["output_dataset_id"], build["id"], quarantine.rows
        )
        await binding_mod.auto_sync_dataset(
            store, transform["output_dataset_id"], ctx or _LOCAL_CTX, log
        )
        return await store.finish_build(
            build["id"], "succeeded", len(rows), None, log, quarantined=quarantine.count
        )
    except FoundryError as exc:
        log.append(f"error: {exc.detail}")
        await _evaluate_build_failed_monitors(store, transform, exc.detail)
        return await store.finish_build(build["id"], "failed", None, exc.detail, log)
    except Exception as exc:  # noqa: BLE001 — surface as a failed build, not a 500
        log.append(f"error: {exc}")
        await _evaluate_build_failed_monitors(store, transform, str(exc))
        return await store.finish_build(build["id"], "failed", None, str(exc), log)


def _topo_order(transforms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Order transforms so an upstream transform's output is built before a
    downstream transform that consumes it as an input. Writes are rejected up
    front by ``would_cycle`` so a cycle should never reach this function — but
    if one does, we fail loud (raise) rather than silently build in a wrong,
    possibly stale-reading order. No lenient declaration-order fallback."""
    produced_by = {t["output_dataset_id"]: t["id"] for t in transforms}
    deps: dict[str, set[str]] = {
        t["id"]: {
            produced_by[i] for i in t["inputs"] if i in produced_by and produced_by[i] != t["id"]
        }
        for t in transforms
    }
    ordered: list[dict[str, Any]] = []
    placed: set[str] = set()
    remaining = list(transforms)
    while remaining:
        progressed = False
        for t in list(remaining):
            if deps[t["id"]] <= placed:
                ordered.append(t)
                placed.add(t["id"])
                remaining.remove(t)
                progressed = True
        if not progressed:
            raise FoundryError(422, "pipeline contains a cycle")
    return ordered


def would_cycle(transforms: list[dict[str, Any]]) -> bool:
    """True iff the dataset<->transform bipartite graph implied by
    ``transforms`` (each transform's declared inputs -> transform -> output
    dataset) contains a cycle. Unlike ``_topo_order``'s lenient fallback,
    this also catches a transform whose own output feeds back into its own
    inputs (self-loop). Used to reject writes at ``POST``/``PUT
    /transforms`` time."""
    adj: dict[str, set[str]] = {}

    def add_edge(a: str, b: str) -> None:
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set())

    for t in transforms:
        tnode = "t:" + t["id"]
        adj.setdefault(tnode, set())
        for i in t["inputs"]:
            add_edge("d:" + i, tnode)
        add_edge(tnode, "d:" + t["output_dataset_id"])

    indeg: dict[str, int] = dict.fromkeys(adj, 0)
    for outs in adj.values():
        for o in outs:
            indeg[o] += 1

    q: deque[str] = deque(n for n, d in indeg.items() if d == 0)
    visited = 0
    while q:
        n = q.popleft()
        visited += 1
        for o in adj.get(n, ()):
            indeg[o] -= 1
            if indeg[o] == 0:
                q.append(o)
    return visited != len(indeg)


async def run_pipeline_build(store: FoundryStore, only_stale: bool = False) -> dict[str, Any]:
    """Topological run of every transform. Represented as one ``scope=pipeline``
    build whose log concatenates each sub-transform's outcome. With
    ``only_stale``, transforms that are not stale (per ``transform_is_stale``)
    are skipped — one log line each — rather than rebuilt."""
    transforms = await store.list_transforms()
    build = await store.create_build(None, scope="pipeline")
    log: list[str] = [f"pipeline build {build['id']} started ({len(transforms)} transform(s))"]
    ordered = _topo_order(transforms)
    total_rows = 0
    failures: list[str] = []
    for t in ordered:
        if only_stale and not await transform_is_stale(store, t):
            log.append(f"{t['name']}: skipped (not stale)")
            continue
        sub = await run_transform_build(store, t["id"])
        log.append(f"{t['name']}: {sub['status']} ({sub.get('rows_out')} rows)")
        if sub["status"] == "failed":
            # Aggregate EVERY sub-failure into the queryable error field — a
            # multi-failure run must not hide all but the last one.
            failures.append(f"{t['name']}: {sub.get('error') or 'sub-build failed'}")
        else:
            total_rows += sub.get("rows_out") or 0
    status = "failed" if failures else "succeeded"
    error = "; ".join(failures) if failures else None
    return await store.finish_build(build["id"], status, total_rows, error, log)


async def dataset_docs(store: FoundryStore, dataset_id: str) -> dict[str, Any] | None:
    """Assemble an auto-generated 'why do we trust this dataset' provenance +
    quality page (Foundry Data Docs): identity, schema, version history, the
    latest check results, upstream producer + inputs and downstream consumers,
    and the current dead-letter count. All data already exists — this just
    fuses it into one payload."""
    ds = await store.get_dataset(dataset_id)
    if ds is None:
        return None
    versions = await store.get_versions(dataset_id)
    check_results = await store.check_results_for_version(dataset_id, ds["latest_version"])
    checks = await store.list_checks(dataset_id)
    transforms = await store.list_transforms()
    producer = next((t for t in transforms if t["output_dataset_id"] == dataset_id), None)
    upstream = producer["inputs"] if producer else []
    downstream = [
        {"transform": t["name"], "output_dataset_id": t["output_dataset_id"]}
        for t in transforms
        if dataset_id in t["inputs"]
    ]
    dead_letter = await store.get_dead_letter(dataset_id, limit=1)
    stale = None
    if producer is not None:
        stale = await transform_is_stale(store, producer)
    return {
        "dataset": {
            "id": ds["id"],
            "name": ds["name"],
            "description": ds["description"],
            "kind": ds["kind"],
            "row_count": ds["row_count"],
            "latest_version": ds["latest_version"],
            "created_at": ds["created_at"],
            "updated_at": ds["updated_at"],
        },
        "schema": ds["schema"],
        "versions": versions,
        "checks": checks,
        "check_results": check_results,
        "lineage": {
            "produced_by": producer["name"] if producer else None,
            "upstream_datasets": upstream,
            "downstream": downstream,
            "stale": stale,
        },
        "dead_letter_present": bool(dead_letter),
    }


async def column_lineage_for_dataset(
    store: FoundryStore, dataset_id: str
) -> dict[str, Any] | None:
    """One-hop column lineage for a dataset: for a derived dataset, map each of
    its columns to the source columns of its producing transform's inputs; for
    a raw dataset, identity (each column ← itself)."""
    ds = await store.get_dataset(dataset_id)
    if ds is None:
        return None
    out_cols = [c["name"] for c in ds["schema"]]
    transforms = await store.list_transforms()
    producer = next((t for t in transforms if t["output_dataset_id"] == dataset_id), None)
    if producer is None:
        return {
            "dataset_id": dataset_id,
            "produced_by": None,
            "columns": {c: [c] for c in out_cols},
        }

    primary_id = producer["inputs"][0] if producer["inputs"] else None
    primary_ds = await store.get_dataset(primary_id) if primary_id else None
    primary_columns = [c["name"] for c in primary_ds["schema"]] if primary_ds else []
    right_columns: dict[str, list[str]] = {}
    for step in producer["steps"]:
        if step.get("type") in ("join", "union") and "right" in step:
            rds = await store.get_dataset(step["right"])
            right_columns[step["right"]] = [c["name"] for c in rds["schema"]] if rds else []
    columns = tf.column_lineage(producer["steps"], primary_columns, right_columns)
    # keep only columns actually present in the output schema
    columns = {c: columns.get(c, []) for c in out_cols}
    return {
        "dataset_id": dataset_id,
        "produced_by": producer["name"],
        "primary_input": primary_id,
        "columns": columns,
    }


async def lineage_graph(store: FoundryStore) -> dict[str, Any]:
    datasets = await store.list_datasets()
    transforms = await store.list_transforms()
    stale_by_transform: dict[str, bool] = {}
    for t in transforms:
        stale_by_transform[t["id"]] = await transform_is_stale(store, t)
    producer_of = {t["output_dataset_id"]: t["id"] for t in transforms}

    nodes: list[dict[str, Any]] = []
    for d in datasets:
        node: dict[str, Any] = {
            "id": d["id"],
            "type": "dataset",
            "name": d["name"],
            "row_count": d["row_count"],
            "kind": d["kind"],
        }
        producer = producer_of.get(d["id"])
        if producer is not None:
            node["stale"] = stale_by_transform[producer]
        nodes.append(node)
    for t in transforms:
        nodes.append(
            {
                "id": t["id"],
                "type": "transform",
                "name": t["name"],
                "stale": stale_by_transform[t["id"]],
            }
        )
    edges: list[dict[str, str]] = []
    for t in transforms:
        for i in t["inputs"]:
            edges.append({"src": i, "dst": t["id"]})
        edges.append({"src": t["id"], "dst": t["output_dataset_id"]})
    return {"nodes": nodes, "edges": edges}
