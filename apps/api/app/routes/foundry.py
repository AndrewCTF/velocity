"""Foundry routes — ``/api/foundry/*`` (docs/foundry-plan.md, frozen contract).

BYO-data pipelines: upload datasets, transform them through a declarative step
DSL with lineage, run builds (single-transform or full-pipeline), bind a
dataset into the local ontology, and schedule interval re-runs. Keyless via
``current_user_or_local`` — same discipline as the ontology/situations/maps
routes; the store itself (``app.foundry.store``) is not user-scoped (single-
operator local SQLite, matching the frozen schema).
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from app.config import get_settings
from app.foundry import binding as binding_mod
from app.foundry import builds as builds_mod
from app.foundry import geo as geo_mod
from app.foundry import ingest, sqlrun
from app.foundry import transforms as tf_mod
from app.foundry.store import FoundryError, FoundryStore
from app.intel.ontology import _KNOWN_KINDS
from app.keys import UserCtx, current_user_or_local

router = APIRouter(tags=["foundry"])


def _store() -> FoundryStore:
    return FoundryStore(get_settings())


def _raise(exc: FoundryError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _check_kind(object_kind: str) -> None:
    if object_kind not in _KNOWN_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"unknown object_kind {object_kind!r}; must be one of {sorted(_KNOWN_KINDS)}",
        )


# ── request/response models ─────────────────────────────────────────────────


class DatasetIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""


class TransformIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    inputs: list[str] = Field(default_factory=list)
    output_name: str = Field(min_length=1, max_length=200)
    steps: list[dict[str, Any]] = Field(default_factory=list)


class PreviewIn(BaseModel):
    limit: int = 20


class SpecPreviewIn(BaseModel):
    """Preview an UNSAVED transform spec — the editor's live form state."""

    inputs: list[str] = Field(default_factory=list)
    steps: list[dict[str, Any]] = Field(default_factory=list)
    limit: int = 20


class BindingIn(BaseModel):
    dataset_id: str
    object_kind: str
    key_column: str
    prop_map: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    resolve: bool = False


class ScheduleIn(BaseModel):
    transform_id: str
    interval_s: int = Field(ge=1)
    enabled: bool = True


class RollbackIn(BaseModel):
    version: int


class PipelineBuildIn(BaseModel):
    only_stale: bool = False


class CheckIn(BaseModel):
    dataset_id: str
    name: str = Field(min_length=1, max_length=200)
    type: str
    params: dict[str, Any] = Field(default_factory=dict)
    severity: str = "warn"
    enabled: bool = True


class SqlIn(BaseModel):
    dataset_ids: list[str] = Field(min_length=1)
    query: str = Field(min_length=1)
    max_rows: int = 1000


class MonitorIn(BaseModel):
    dataset_id: str
    name: str = Field(min_length=1, max_length=200)
    trigger: str
    condition_expr: str = ""
    action: str = "alert"
    llm_tier: str = "fast"
    llm_system: str = ""
    llm_prompt: str = ""
    severity: str = "medium"
    enabled: bool = True


# ── summary ──────────────────────────────────────────────────────────────────


@router.get("/api/foundry/summary")
async def summary(ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    store = _store()
    datasets = await store.list_datasets()
    total_rows = await store.total_rows()
    transform_count = await store.count_transforms()
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 86400))
    recent = await store.builds_since(cutoff)
    failed = [b for b in recent if b["status"] == "failed"]
    bindings = await store.list_bindings()
    objects_synced = sum(
        (b["last_result"] or {}).get("minted", 0) + (b["last_result"] or {}).get("updated", 0)
        for b in bindings
    )
    recent_builds = await store.list_builds(limit=10)
    checks_failing = await store.checks_failing_count()
    monitors_count = await store.count_monitors()
    monitor_events_24h = await store.count_monitor_events_since(cutoff)
    return {
        "datasets": len(datasets),
        "total_rows": total_rows,
        "transforms": transform_count,
        "builds_24h": len(recent),
        "failed_builds_24h": len(failed),
        "objects_synced": objects_synced,
        "recent_builds": recent_builds,
        "checks_failing": checks_failing,
        "monitors": monitors_count,
        "monitor_events_24h": monitor_events_24h,
    }


# ── SQL console ──────────────────────────────────────────────────────────────


@router.post("/api/foundry/sql")
async def foundry_sql(
    body: SqlIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Read-only SQL over the latest-version rows of the given datasets, each
    loaded into an in-memory table named by ``slug_ident(dataset name)``
    (collisions suffixed ``_2``, ``_3``, ...). Unknown dataset id → 404; a
    query rejection/failure (non-SELECT, syntax error, timeout) → HTTP 200
    ``{ok: false, error}`` since that's an authoring mistake, not a server
    error."""
    store = _store()
    tables: dict[str, list[dict[str, Any]]] = {}
    table_to_dataset: dict[str, str] = {}
    used_names: set[str] = set()
    for dataset_id in body.dataset_ids:
        ds = await store.get_dataset(dataset_id)
        if ds is None:
            raise HTTPException(status_code=404, detail=f"dataset not found: {dataset_id}")
        base = sqlrun.slug_ident(ds["name"])
        name = base
        n = 2
        while name in used_names:
            name = f"{base}_{n}"
            n += 1
        used_names.add(name)
        table_to_dataset[name] = dataset_id
        tables[name] = await store.latest_rows(dataset_id)
    max_rows = min(int(body.max_rows or 1000), 10_000)
    try:
        rows, cols = await asyncio.to_thread(sqlrun.run_sql, body.query, tables, max_rows=max_rows)
    except sqlrun.SqlError as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "columns": cols,
        "rows": rows,
        "row_count": len(rows),
        "tables": table_to_dataset,
    }


# ── datasets ─────────────────────────────────────────────────────────────────


@router.get("/api/foundry/datasets")
async def list_datasets(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return await _store().list_datasets()


@router.post("/api/foundry/datasets")
async def create_dataset(
    body: DatasetIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    try:
        return await _store().create_dataset(body.name, body.description)
    except FoundryError as exc:
        _raise(exc)


@router.get("/api/foundry/datasets/{dataset_id}")
async def get_dataset(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    ds = await _store().get_dataset(dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return ds


@router.delete("/api/foundry/datasets/{dataset_id}")
async def delete_dataset(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    try:
        await _store().delete_dataset(dataset_id)
    except FoundryError as exc:
        _raise(exc)
    return {"ok": True}


def _parse_type_pins(types: str) -> dict[str, str]:
    """Parse the optional ``types`` upload form field (JSON ``{column: type}``)
    for column type-pinning. Empty/blank → no pins. 422 on non-JSON or a
    non-string-map shape."""
    if not types or not types.strip():
        return {}
    try:
        parsed = json.loads(types)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"types must be a JSON object: {exc}") from exc
    if not isinstance(parsed, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in parsed.items()
    ):
        raise HTTPException(status_code=422, detail="types must be a JSON object of column->type")
    return parsed


async def _read_upload(
    file: UploadFile, pins: dict[str, str] | None = None
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    content = await file.read()
    try:
        rows, schema = ingest.parse_upload(file.filename or "upload.json", content)
        if pins:
            rows, schema = ingest.apply_type_pins(rows, schema, pins)
        return rows, schema
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover


@router.post("/api/foundry/datasets/upload")
async def upload_dataset(
    file: UploadFile = File(...),
    name: str = Form(...),
    description: str = Form(""),
    types: str = Form(""),
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    rows, schema = await _read_upload(file, _parse_type_pins(types))
    store = _store()
    try:
        ds = await store.create_dataset(name, description)
        result = await store.add_version(ds["id"], rows, schema, source="upload")
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover
    result["auto_sync"] = await binding_mod.auto_sync_dataset(store, ds["id"], ctx)
    return result


@router.post("/api/foundry/datasets/{dataset_id}/upload")
async def upload_dataset_version(
    dataset_id: str,
    file: UploadFile = File(...),
    mode: str = Form("snapshot"),
    types: str = Form(""),
    cascade: bool = Form(False),
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    rows, schema = await _read_upload(file, _parse_type_pins(types))
    store = _store()
    if mode not in ("snapshot", "append"):
        raise HTTPException(
            status_code=422, detail=f"unknown mode: {mode!r}; must be 'snapshot' or 'append'"
        )
    try:
        if mode == "append":
            ds = await store.append_version(dataset_id, rows)
        else:
            ds = await store.add_version(dataset_id, rows, schema, source="upload")
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover
    ds["auto_sync"] = await binding_mod.auto_sync_dataset(store, dataset_id, ctx)
    if cascade:
        # File-arrival sensor: a new version makes downstream transforms stale;
        # rebuild them now instead of waiting for the next scheduler tick.
        ds["cascade_build"] = await builds_mod.run_pipeline_build(store, only_stale=True)
    return ds


@router.post("/api/foundry/datasets/{dataset_id}/rollback")
async def rollback_dataset(
    dataset_id: str, body: RollbackIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    try:
        ds = await store.rollback_version(dataset_id, body.version)
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover
    ver = await store.get_version(dataset_id, ds["latest_version"])
    if ver is None:  # pragma: no cover — defensive, add_version always writes a version
        raise HTTPException(status_code=500, detail="rollback did not produce a version")
    ver["auto_sync"] = await binding_mod.auto_sync_dataset(store, dataset_id, ctx)
    return ver


@router.get("/api/foundry/datasets/{dataset_id}/rows")
async def dataset_rows(
    dataset_id: str,
    version: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200_000),
    offset: int = Query(0, ge=0),
    ctx: UserCtx = Depends(current_user_or_local),
) -> dict[str, Any]:
    result = await _store().get_rows(dataset_id, version=version, limit=limit, offset=offset)
    if result is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return result


@router.get("/api/foundry/datasets/{dataset_id}/versions")
async def dataset_versions(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> list[dict[str, Any]]:
    ds = await _store().get_dataset(dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return await _store().get_versions(dataset_id)


@router.get("/api/foundry/datasets/{dataset_id}/stats")
async def dataset_stats(
    dataset_id: str,
    version: int | None = Query(None),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[dict[str, Any]]:
    stats = await _store().get_stats(dataset_id, version=version)
    if stats is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return stats


@router.get("/api/foundry/datasets/{dataset_id}/docs")
async def dataset_docs(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Auto-generated Data Docs: schema + versions + latest check results +
    lineage (producer, upstream, downstream) + dead-letter presence."""
    docs = await builds_mod.dataset_docs(_store(), dataset_id)
    if docs is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return docs


@router.get("/api/foundry/datasets/{dataset_id}/column-lineage")
async def dataset_column_lineage(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """One-hop column-level lineage: each output column → its source input
    columns (identity for a raw dataset)."""
    result = await builds_mod.column_lineage_for_dataset(_store(), dataset_id)
    if result is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return result


@router.get("/api/foundry/datasets/{dataset_id}/dead-letter")
async def dataset_dead_letter(
    dataset_id: str,
    limit: int = Query(100, ge=1, le=1000),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[dict[str, Any]]:
    """Rows the most recent build of this (derived) dataset quarantined during
    filter/derive — the dead-letter view for row-level remediation."""
    store = _store()
    if await store.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return await store.get_dead_letter(dataset_id, limit=limit)


@router.get("/api/foundry/datasets/{dataset_id}/geo")
async def dataset_geo(
    dataset_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Auto-detect lat/lon columns (name heuristics + numeric-range check) and
    return the latest version's rows as a capped GeoJSON FeatureCollection.
    No geo columns found → ``{ok: false, reason}`` with HTTP 200 (frontend-
    friendly — this is a "nothing to show" case, not an error), not 404."""
    store = _store()
    ds = await store.get_dataset(dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    rows = await store.latest_rows(dataset_id)
    detected = geo_mod.detect_geo(ds["schema"], rows)
    if detected is None:
        return {"ok": False, "reason": "no lat/lon columns detected"}
    features = geo_mod.to_feature_collection(rows, detected["lat_col"], detected["lon_col"])
    return {
        "ok": True,
        "lat_col": detected["lat_col"],
        "lon_col": detected["lon_col"],
        "count": len(features["features"]),
        "features": features,
    }


@router.get("/api/foundry/datasets/{dataset_id}/checks/results")
async def dataset_check_results(
    dataset_id: str,
    version: int | None = Query(None),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[dict[str, Any]]:
    store = _store()
    ds = await store.get_dataset(dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    v = version if version is not None else ds["latest_version"]
    return await store.check_results_for_version(dataset_id, v)


# ── checks (data expectations) ──────────────────────────────────────────────


@router.get("/api/foundry/checks")
async def list_checks(
    dataset_id: str | None = Query(None), ctx: UserCtx = Depends(current_user_or_local)
) -> list[dict[str, Any]]:
    return await _store().list_checks(dataset_id)


@router.post("/api/foundry/checks")
async def create_check(
    body: CheckIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    ds = await store.get_dataset(body.dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    try:
        return await store.create_check(
            body.dataset_id, body.name, body.type, body.params, body.severity, body.enabled
        )
    except FoundryError as exc:
        _raise(exc)


@router.put("/api/foundry/checks/{check_id}")
async def update_check(
    check_id: str, body: CheckIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    try:
        updated = await _store().update_check(
            check_id,
            body.name,
            body.type,
            body.params,
            body.severity,
            body.enabled,
            body.dataset_id,
        )
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover
    if updated is None:
        raise HTTPException(status_code=404, detail="check not found")
    return updated


@router.delete("/api/foundry/checks/{check_id}")
async def delete_check(
    check_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_check(check_id)
    return {"ok": True}


# ── transforms ───────────────────────────────────────────────────────────────


@router.get("/api/foundry/transforms")
async def list_transforms(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return await _store().list_transforms()


@router.post("/api/foundry/transforms")
async def create_transform(
    body: TransformIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    try:
        tf_mod.validate_steps(body.steps)
        out_ds = await store.get_dataset_by_name(body.output_name)
        if out_ds is None:
            out_ds = await store.create_dataset(body.output_name, kind="derived")
        existing = await store.list_transforms()
        candidate = {
            "id": "__candidate__",
            "inputs": body.inputs,
            "output_dataset_id": out_ds["id"],
        }
        if builds_mod.would_cycle([*existing, candidate]):
            raise HTTPException(
                status_code=422,
                detail="transform would introduce a cycle in the dataset/transform DAG",
            )
        return await store.create_transform(
            body.name, body.description, body.inputs, out_ds["id"], body.steps
        )
    except FoundryError as exc:
        _raise(exc)


@router.post("/api/foundry/transforms/preview")
async def preview_transform_spec(
    body: SpecPreviewIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    """Preview an unsaved spec (editor form state) — same execution/quarantine
    semantics as the saved-transform preview, no version written. Declared
    before the parameterized transform routes."""
    try:
        tf_mod.validate_steps(body.steps)
        return await builds_mod.preview_transform(
            _store(), {"inputs": body.inputs, "steps": body.steps}, limit=body.limit
        )
    except FoundryError as exc:
        _raise(exc)


@router.get("/api/foundry/transforms/{transform_id}")
async def get_transform(
    transform_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    t = await _store().get_transform(transform_id)
    if t is None:
        raise HTTPException(status_code=404, detail="transform not found")
    return t


@router.put("/api/foundry/transforms/{transform_id}")
async def update_transform(
    transform_id: str, body: TransformIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    try:
        tf_mod.validate_steps(body.steps)
    except FoundryError as exc:
        _raise(exc)
    existing = await store.get_transform(transform_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="transform not found")
    out_ds = await store.get_dataset(existing["output_dataset_id"])
    output_dataset_id = existing["output_dataset_id"]
    if out_ds and out_ds["name"] != body.output_name:
        renamed = await store.get_dataset_by_name(body.output_name)
        if renamed is None:
            renamed = await store.create_dataset(body.output_name, kind="derived")
        output_dataset_id = renamed["id"]
    all_transforms = await store.list_transforms()
    others = [t for t in all_transforms if t["id"] != transform_id]
    candidate = {
        "id": transform_id,
        "inputs": body.inputs,
        "output_dataset_id": output_dataset_id,
    }
    if builds_mod.would_cycle([*others, candidate]):
        raise HTTPException(
            status_code=422,
            detail="transform would introduce a cycle in the dataset/transform DAG",
        )
    updated = await store.update_transform(
        transform_id, body.name, body.description, body.inputs, output_dataset_id, body.steps
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="transform not found")
    return updated


@router.delete("/api/foundry/transforms/{transform_id}")
async def delete_transform(
    transform_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_transform(transform_id)
    return {"ok": True}


@router.post("/api/foundry/transforms/{transform_id}/preview")
async def preview_transform(
    transform_id: str, body: PreviewIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    t = await store.get_transform(transform_id)
    if t is None:
        raise HTTPException(status_code=404, detail="transform not found")
    try:
        tf_mod.validate_steps(t["steps"])
        return await builds_mod.preview_transform(store, t, limit=body.limit)
    except FoundryError as exc:
        _raise(exc)


@router.post("/api/foundry/transforms/{transform_id}/build")
async def build_transform(
    transform_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    t = await store.get_transform(transform_id)
    if t is None:
        raise HTTPException(status_code=404, detail="transform not found")
    return await builds_mod.run_transform_build(store, transform_id)


@router.post("/api/foundry/pipeline/build")
async def build_pipeline(
    body: PipelineBuildIn | None = None, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    only_stale = bool(body.only_stale) if body is not None else False
    return await builds_mod.run_pipeline_build(_store(), only_stale=only_stale)


# ── builds ───────────────────────────────────────────────────────────────────


@router.get("/api/foundry/builds")
async def list_builds(
    limit: int = Query(50, ge=1, le=500), ctx: UserCtx = Depends(current_user_or_local)
) -> list[dict[str, Any]]:
    return await _store().list_builds(limit=limit)


@router.get("/api/foundry/builds/{build_id}")
async def get_build(
    build_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    b = await _store().get_build(build_id)
    if b is None:
        raise HTTPException(status_code=404, detail="build not found")
    return b


# ── lineage ──────────────────────────────────────────────────────────────────


@router.get("/api/foundry/lineage")
async def lineage(ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, Any]:
    return await builds_mod.lineage_graph(_store())


# ── bindings ─────────────────────────────────────────────────────────────────


@router.get("/api/foundry/kinds")
async def foundry_kinds(ctx: UserCtx = Depends(current_user_or_local)) -> dict[str, list[str]]:
    """The ontology object kinds a binding may target — lets the client offer a
    picker instead of free text that only 422s server-side (_check_kind)."""
    return {"kinds": sorted(_KNOWN_KINDS)}


@router.get("/api/foundry/bindings")
async def list_bindings(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return await _store().list_bindings()


@router.post("/api/foundry/bindings")
async def create_binding(
    body: BindingIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    _check_kind(body.object_kind)
    store = _store()
    ds = await store.get_dataset(body.dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    return await store.create_binding(
        body.dataset_id,
        body.object_kind,
        body.key_column,
        body.prop_map,
        body.enabled,
        body.resolve,
    )


@router.put("/api/foundry/bindings/{binding_id}")
async def update_binding(
    binding_id: str, body: BindingIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    _check_kind(body.object_kind)
    updated = await _store().update_binding(
        binding_id,
        body.object_kind,
        body.key_column,
        body.prop_map,
        body.enabled,
        body.resolve,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="binding not found")
    return updated


@router.delete("/api/foundry/bindings/{binding_id}")
async def delete_binding(
    binding_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_binding(binding_id)
    return {"ok": True}


@router.post("/api/foundry/bindings/{binding_id}/sync")
async def sync_binding(
    binding_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    b = await store.get_binding(binding_id)
    if b is None:
        raise HTTPException(status_code=404, detail="binding not found")
    return await binding_mod.sync_binding(store, b, ctx)


# ── schedules ────────────────────────────────────────────────────────────────


@router.get("/api/foundry/schedules")
async def list_schedules(ctx: UserCtx = Depends(current_user_or_local)) -> list[dict[str, Any]]:
    return await _store().list_schedules()


@router.post("/api/foundry/schedules")
async def create_schedule(
    body: ScheduleIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    t = await store.get_transform(body.transform_id)
    if t is None:
        raise HTTPException(status_code=404, detail="transform not found")
    return await store.create_schedule(body.transform_id, body.interval_s, body.enabled)


@router.put("/api/foundry/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str, body: ScheduleIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    updated = await _store().update_schedule(schedule_id, body.interval_s, body.enabled)
    if updated is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    return updated


@router.delete("/api/foundry/schedules/{schedule_id}")
async def delete_schedule(
    schedule_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_schedule(schedule_id)
    return {"ok": True}


# ── monitors ─────────────────────────────────────────────────────────────────


@router.get("/api/foundry/monitors")
async def list_monitors(
    dataset_id: str | None = Query(None), ctx: UserCtx = Depends(current_user_or_local)
) -> list[dict[str, Any]]:
    return await _store().list_monitors(dataset_id)


@router.post("/api/foundry/monitors")
async def create_monitor(
    body: MonitorIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    store = _store()
    ds = await store.get_dataset(body.dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="dataset not found")
    try:
        return await store.create_monitor(
            body.dataset_id,
            body.name,
            body.trigger,
            body.condition_expr,
            body.action,
            body.llm_tier,
            body.llm_system,
            body.llm_prompt,
            body.severity,
            body.enabled,
        )
    except FoundryError as exc:
        _raise(exc)


@router.put("/api/foundry/monitors/{monitor_id}")
async def update_monitor(
    monitor_id: str, body: MonitorIn, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, Any]:
    try:
        updated = await _store().update_monitor(
            monitor_id,
            body.name,
            body.trigger,
            body.condition_expr,
            body.action,
            body.llm_tier,
            body.llm_system,
            body.llm_prompt,
            body.severity,
            body.enabled,
        )
    except FoundryError as exc:
        _raise(exc)
        raise AssertionError("unreachable") from exc  # pragma: no cover
    if updated is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    return updated


@router.delete("/api/foundry/monitors/{monitor_id}")
async def delete_monitor(
    monitor_id: str, ctx: UserCtx = Depends(current_user_or_local)
) -> dict[str, bool]:
    await _store().delete_monitor(monitor_id)
    return {"ok": True}


@router.get("/api/foundry/monitors/{monitor_id}/events")
async def monitor_events(
    monitor_id: str,
    limit: int = Query(100, ge=1, le=500),
    ctx: UserCtx = Depends(current_user_or_local),
) -> list[dict[str, Any]]:
    store = _store()
    m = await store.get_monitor(monitor_id)
    if m is None:
        raise HTTPException(status_code=404, detail="monitor not found")
    return await store.get_monitor_events(monitor_id, limit=limit)
