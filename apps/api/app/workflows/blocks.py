"""Block registry — the Workflows DAG's typed vocabulary.

Each block declares a JSON-serializable ``config_schema`` (rendered generically
by the frontend into a config form) and an async ``run(config, inputs, ctx)``
that returns the block's output rows. ``engine.py`` resolves the DAG and calls
these; no block ever raises un-caught into the API layer — a raised exception
here fails the RUN (status="failed"), never the HTTP request.

Catalog (16 blocks — see the skip note below for the 17th):
  Sources (0 inputs): aircraft, vessels, countries, dataset, ontology, alerts,
    quakes.
  Ops (1-2 inputs): steps (foundry DSL), geo, python, sql, llm.
  Sinks (1 input, pass rows through): alert, ontology, dataset, memory.

SKIPPED (named, not faked): ``op.country`` (point → ISO country via catalog
polygons/bboxes) from the plan's block list. Verified against source
(``app/osint/country_catalog.py`` + every ``country_data/*.json``): the
catalog is an OSINT-resource directory keyed by
``code/name/region/iso2/source_url/note/resources`` — it carries NO polygon
or bbox geometry for any country, and no other keyless country-boundary
dataset exists in this repo. Implementing point-in-country would require
inventing a geometry table not sourced from anywhere in the codebase, which
the task explicitly forbids ("don't fake it"). ``source.countries`` (the
catalog's metadata rows) IS implemented below.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.correlate.bus import bus
from app.correlate.types import Alert
from app.foundry import sqlrun
from app.foundry import transforms as tf
from app.foundry.ingest import infer_schema
from app.foundry.store import FoundryError, FoundryStore
from app.intel.ontology import _KNOWN_KINDS, Object, get_registry
from app.intel.ontology_local import _connect as _ontology_connect
from app.keys import UserCtx
from app.workflows import python_exec
from app.workflows.store import WorkflowError

Row = dict[str, Any]

# ── shared caps ────────────────────────────────────────────────────────────────

PREVIEW_SOURCE_CAP = 500
ROW_CAP_PER_BLOCK = 200_000
MAX_ALERTS_PER_RUN = 20
_LLM_ROWS_CAP = 100
_LLM_BYTES_CAP = 20_000
_LLM_PER_ROW_CAP = 50


# ── block context ──────────────────────────────────────────────────────────────


@dataclass
class BlockCtx:
    """Threaded through every block's ``run``.

    ``memory`` is the whole workflow's persisted memory dict, loaded once by
    the engine at run start and persisted once at run end — blocks read/write
    it directly (get_memory/set_memory helpers below just make that explicit
    at call sites). ``alert_budget`` is a single-element mutable list shared
    by every ``sink.alert`` block in one run, capping total publishes at
    ``MAX_ALERTS_PER_RUN`` workflow-wide (not per block).
    """

    user_ctx: UserCtx
    workflow_id: str
    memory: dict[str, Any]
    preview: bool = False
    alert_budget: list[int] = field(default_factory=lambda: [MAX_ALERTS_PER_RUN])

    def get_memory(self, key: str, default: Any = None) -> Any:
        return self.memory.get(key, default)

    def set_memory(self, key: str, value: Any) -> None:
        self.memory[key] = value

    @property
    def source_row_cap(self) -> int:
        return PREVIEW_SOURCE_CAP if self.preview else ROW_CAP_PER_BLOCK


# ── config schema primitives ────────────────────────────────────────────────────


@dataclass(frozen=True)
class ConfigField:
    key: str
    type: str  # "string"|"int"|"float"|"bool"|"text"|"select"|"json"
    label: str
    required: bool = False
    default: Any = None
    options: list[str] | None = None
    placeholder: str = ""
    help: str = ""

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "key": self.key,
            "type": self.type,
            "label": self.label,
            "required": self.required,
        }
        if self.default is not None:
            d["default"] = self.default
        if self.options is not None:
            d["options"] = self.options
        if self.placeholder:
            d["placeholder"] = self.placeholder
        if self.help:
            d["help"] = self.help
        return d


BlockRunFn = Callable[[dict[str, Any], list[list[Row]], BlockCtx], Awaitable[list[Row]]]


@dataclass(frozen=True)
class BlockSpec:
    type: str
    category: str  # "source"|"op"|"sink"
    title: str
    description: str
    min_inputs: int
    max_inputs: int
    config_schema: list[ConfigField]
    run: BlockRunFn

    def to_json(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "category": self.category,
            "title": self.title,
            "description": self.description,
            "min_inputs": self.min_inputs,
            "max_inputs": self.max_inputs,
            "config_schema": [f.to_json() for f in self.config_schema],
        }


BLOCKS: dict[str, BlockSpec] = {}


def _register(spec: BlockSpec) -> None:
    BLOCKS[spec.type] = spec


# ── small helpers ────────────────────────────────────────────────────────────────


def _num(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_bbox(raw: Any) -> tuple[float, float, float, float] | None:
    """``"min_lon,min_lat,max_lon,max_lat"`` (or a 4-item list) → tuple."""
    if raw is None or raw == "":
        return None
    parts = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    if len(parts) != 4:
        raise WorkflowError(422, "bbox must have 4 values: min_lon,min_lat,max_lon,max_lat")
    try:
        min_lon, min_lat, max_lon, max_lat = (float(p) for p in parts)
    except (TypeError, ValueError) as exc:
        raise WorkflowError(422, f"bbox values must be numeric: {exc}") from exc
    return min_lon, min_lat, max_lon, max_lat


def _in_bbox(lon: float | None, lat: float | None, bbox: tuple[float, float, float, float]) -> bool:
    if lon is None or lat is None:
        return False
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _cap(rows: list[Row], ctx: BlockCtx) -> list[Row]:
    return rows[: ctx.source_row_cap]


# ═══════════════════════════════════════════════════════════════════════════════
# Sources (0 inputs)
# ═══════════════════════════════════════════════════════════════════════════════


async def _run_source_aircraft(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Live aircraft snapshot. Calls ``global_snapshot()`` — the internal
    accessor every non-route consumer must use (never the route handler in-
    process; see ``app/routes/adsb.py:1559`` docstring). Degrades to []
    (never blocks a run) if the feed hasn't warmed yet."""
    from app.routes import adsb as adsb_routes  # noqa: PLC0415 — avoid import cycle at module load

    try:
        snap = await adsb_routes.global_snapshot()
    except Exception:  # noqa: BLE001 — a cold/broken feed must not fail the run
        return []
    features = (snap or {}).get("features") or []
    bbox = _parse_bbox(config.get("bbox"))
    rows: list[Row] = []
    for f in features:
        coords = ((f.get("geometry") or {}).get("coordinates")) or [None, None, None]
        lon, lat = coords[0], coords[1]
        if bbox is not None and not _in_bbox(lon, lat, bbox):
            continue
        props = f.get("properties") or {}
        alt_m = coords[2] if len(coords) > 2 else None
        rows.append({"lon": lon, "lat": lat, "alt_m": alt_m, **props})
    return _cap(rows, ctx)


async def _run_source_vessels(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Live AIS union (latest fix per MMSI, all keyless sources — freshest
    wins), via ``app.routes.maritime.vessel_snapshot`` — proven source
    (maritime.py:309, "Latest fix per MMSI across all AIS sources")."""
    from app.routes import maritime as maritime_routes  # noqa: PLC0415

    try:
        snap = maritime_routes.vessel_snapshot()
    except Exception:  # noqa: BLE001
        return []
    features = (snap or {}).get("features") or []
    bbox = _parse_bbox(config.get("bbox"))
    rows: list[Row] = []
    for f in features:
        coords = ((f.get("geometry") or {}).get("coordinates")) or [None, None]
        lon, lat = coords[0], coords[1]
        if bbox is not None and not _in_bbox(lon, lat, bbox):
            continue
        props = f.get("properties") or {}
        rows.append({"lon": lon, "lat": lat, **props})
    return _cap(rows, ctx)


async def _run_source_countries(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """OSINT World Series country catalog rows (metadata only — no
    geometry). Verified: ``app/osint/country_catalog.py:145`` module-level
    ``CATALOG: list[CountryRecord]``."""
    from app.osint import country_catalog  # noqa: PLC0415

    region = (config.get("region") or "").strip().lower() or None
    rows: list[Row] = []
    for rec in country_catalog.CATALOG:
        if region and rec.region.lower() != region:
            continue
        rows.append(
            {
                "code": rec.code,
                "name": rec.name,
                "region": rec.region,
                "iso2": rec.iso2,
                "source_url": rec.source_url,
                "note": rec.note,
                "resource_count": len(rec.resources),
            }
        )
    return _cap(rows, ctx)


async def _run_source_dataset(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Latest-version rows of a Foundry dataset, by id or name."""
    store = FoundryStore()
    dataset_id = (config.get("dataset_id") or "").strip()
    dataset_name = (config.get("dataset_name") or "").strip()
    ds = None
    if dataset_id:
        ds = await store.get_dataset(dataset_id)
    elif dataset_name:
        ds = await store.get_dataset_by_name(dataset_name)
    if ds is None:
        return []
    rows = await store.latest_rows(ds["id"])
    return _cap(rows, ctx)


def _ontology_objects_by_kind(kind: str, user_id: str, s: Any, limit: int) -> list[Row]:
    """Objects whose ``kind`` COLUMN equals ``kind`` (not ``props.kind`` —
    that's the workspace-node convention ``SqliteRegistry.list_by_kind``
    matches). Same direct-SQL pattern ``foundry/binding.py:_resolve_candidates``
    uses (there is no public registry method for this query)."""
    con = _ontology_connect(s)
    try:
        rows = con.execute(
            "SELECT id, kind, props, created_at FROM objects"
            " WHERE user_id=? AND kind=? ORDER BY created_at DESC LIMIT ?",
            (user_id, kind, int(limit)),
        ).fetchall()
    finally:
        con.close()
    out: list[Row] = []
    for object_id, obj_kind, props_json, created_at in rows:
        props = json.loads(props_json)
        out.append({"id": object_id, "kind": obj_kind, "created_at": created_at, **props})
    return out


async def _run_source_ontology(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Ontology objects by kind, flattened (id/kind/created_at + props)."""
    kind = (config.get("kind") or "").strip()
    if not kind:
        raise WorkflowError(422, "source.ontology requires 'kind'")
    reg = get_registry(ctx.user_ctx)
    limit = int(config.get("limit") or 1000)
    rows = await asyncio.get_running_loop().run_in_executor(
        None, _ontology_objects_by_kind, kind, reg.ctx.user_id, reg.s, limit
    )
    return _cap(rows, ctx)


async def _run_source_alerts(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Recent alerts from the in-memory bus ring (``bus.recent``)."""
    limit = int(config.get("limit") or 100)
    alerts = bus.recent(limit)
    rows = [a.to_json() for a in alerts]
    return _cap(rows, ctx)


async def _run_source_quakes(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """USGS earthquake feed. Calls the route function directly WITH an
    explicit ``range`` kwarg (never relying on its ``Query(...)`` default —
    the same trap ``global_snapshot()``'s docstring documents for adsb) so no
    unresolved ``fastapi.Query`` sentinel leaks into the comparison."""
    from app.routes import eq as eq_routes  # noqa: PLC0415

    rng = config.get("range") or "day"
    if rng not in ("hour", "day", "week", "month"):
        rng = "day"
    try:
        fc = await eq_routes.quakes(range=rng)
    except Exception:  # noqa: BLE001 — upstream degrade → empty, never block the run
        return []
    rows: list[Row] = []
    for f in (fc or {}).get("features") or []:
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or [None, None, None]
        props = f.get("properties") or {}
        rows.append(
            {
                "id": f.get("id"),
                "lon": coords[0],
                "lat": coords[1],
                "depth_km": coords[2] if len(coords) > 2 else None,
                "mag": props.get("mag"),
                "place": props.get("place"),
                "time": props.get("time"),
            }
        )
    return _cap(rows, ctx)


_register(
    BlockSpec(
        type="source.aircraft",
        category="source",
        title="Aircraft (live)",
        description="Live global ADS-B snapshot (icao24, callsign, lat/lon, alt, speed, track…).",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField(
                "bbox", "string", "Bounding box (optional)",
                placeholder="min_lon,min_lat,max_lon,max_lat",
                help="Leave empty for the full global snapshot.",
            ),
        ],
        run=_run_source_aircraft,
    )
)
_register(
    BlockSpec(
        type="source.vessels",
        category="source",
        title="Vessels (live AIS)",
        description="Latest fix per MMSI, unioned across every keyless AIS source.",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField(
                "bbox", "string", "Bounding box (optional)",
                placeholder="min_lon,min_lat,max_lon,max_lat",
            ),
        ],
        run=_run_source_vessels,
    )
)
_register(
    BlockSpec(
        type="source.countries",
        category="source",
        title="Countries catalog",
        description="OSINT World Series per-country resource catalog (metadata, no geometry).",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField("region", "string", "Region filter (optional)"),
        ],
        run=_run_source_countries,
    )
)
_register(
    BlockSpec(
        type="source.dataset",
        category="source",
        title="Foundry dataset",
        description="Latest version's rows of a Foundry dataset.",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField("dataset_id", "string", "Dataset id"),
            ConfigField("dataset_name", "string", "...or dataset name"),
        ],
        run=_run_source_dataset,
    )
)
_register(
    BlockSpec(
        type="source.ontology",
        category="source",
        title="Ontology objects",
        description="Objects of a given kind from the local ontology store.",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField(
                "kind", "select", "Object kind", required=True,
                options=sorted(_KNOWN_KINDS),
            ),
            ConfigField("limit", "int", "Limit", default=1000),
        ],
        run=_run_source_ontology,
    )
)
_register(
    BlockSpec(
        type="source.alerts",
        category="source",
        title="Recent alerts",
        description="Recent alerts from the live alert bus ring buffer.",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField("limit", "int", "Limit", default=100),
        ],
        run=_run_source_alerts,
    )
)
_register(
    BlockSpec(
        type="source.quakes",
        category="source",
        title="Earthquakes (USGS)",
        description="USGS earthquake feed for the given range.",
        min_inputs=0,
        max_inputs=0,
        config_schema=[
            ConfigField(
                "range", "select", "Range", default="day",
                options=["hour", "day", "week", "month"],
            ),
        ],
        run=_run_source_quakes,
    )
)


# ═══════════════════════════════════════════════════════════════════════════════
# Ops (1-2 inputs)
# ═══════════════════════════════════════════════════════════════════════════════


async def _run_op_steps(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Foundry DSL step list (filter/derive/join/aggregate/sort/limit/dedup/
    select/rename/cast/…) over this block's primary input, full reuse of
    ``app.foundry.transforms.run_steps``/``validate_steps``. A second input
    (if wired) is available to ``join``/``union`` steps whose ``right`` equals
    the literal ``"input2"`` — workflow blocks have no named foundry
    datasets, so that's the only "right" value that resolves to real rows;
    any other value is a dead join (returns []), which is safer than silently
    hitting an unrelated foundry dataset."""
    steps = config.get("steps") or []
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except json.JSONDecodeError as exc:
            raise WorkflowError(422, f"op.steps: 'steps' is not valid JSON: {exc}") from exc
    try:
        tf.validate_steps(steps)
    except FoundryError as exc:
        raise WorkflowError(exc.status_code, exc.detail) from exc
    base_rows = inputs[0] if inputs else []
    second = inputs[1] if len(inputs) > 1 else []

    def provider(dataset_id: str) -> list[Row]:
        return second if dataset_id == "input2" else []

    try:
        rows = tf.run_steps(steps, base_rows, provider, tf.QuarantineSink())
    except FoundryError as exc:
        raise WorkflowError(exc.status_code, exc.detail) from exc
    return rows[:ROW_CAP_PER_BLOCK]


async def _run_op_geo(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Geo filter/join. mode=within_bbox|within_radius|near_join."""
    mode = config.get("mode") or "within_bbox"
    lat_col = config.get("lat_col") or "lat"
    lon_col = config.get("lon_col") or "lon"
    rows = inputs[0] if inputs else []

    if mode == "within_bbox":
        bbox = _parse_bbox(config.get("bbox"))
        if bbox is None:
            raise WorkflowError(422, "op.geo within_bbox requires 'bbox'")
        return [r for r in rows if _in_bbox(_num(r.get(lon_col)), _num(r.get(lat_col)), bbox)][
            :ROW_CAP_PER_BLOCK
        ]

    if mode == "within_radius":
        clat, clon = _num(config.get("center_lat")), _num(config.get("center_lon"))
        radius_km = _num(config.get("radius_km"))
        if clat is None or clon is None or radius_km is None:
            raise WorkflowError(
                422, "op.geo within_radius requires 'center_lat', 'center_lon', 'radius_km'"
            )
        out = []
        for r in rows:
            lat, lon = _num(r.get(lat_col)), _num(r.get(lon_col))
            if lat is None or lon is None:
                continue
            if _haversine_km(clat, clon, lat, lon) <= radius_km:
                out.append(r)
        return out[:ROW_CAP_PER_BLOCK]

    if mode == "near_join":
        if len(inputs) < 2:
            raise WorkflowError(422, "op.geo near_join requires 2 inputs")
        right_rows = inputs[1]
        right_lat_col = config.get("right_lat_col") or lat_col
        right_lon_col = config.get("right_lon_col") or lon_col
        max_km = _num(config.get("max_km")) or 10.0
        out = []
        for lr in rows:
            llat, llon = _num(lr.get(lat_col)), _num(lr.get(lon_col))
            if llat is None or llon is None:
                continue
            for rr in right_rows:
                rlat, rlon = _num(rr.get(right_lat_col)), _num(rr.get(right_lon_col))
                if rlat is None or rlon is None:
                    continue
                dist = _haversine_km(llat, llon, rlat, rlon)
                if dist <= max_km:
                    merged = {**rr, **lr, "distance_km": round(dist, 3)}
                    out.append(merged)
                    if len(out) >= ROW_CAP_PER_BLOCK:
                        return out
        return out

    raise WorkflowError(422, f"op.geo: unknown mode {mode!r}")


async def _run_op_python(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    code = config.get("code") or ""
    if not isinstance(code, str) or not code.strip():
        raise WorkflowError(422, "op.python requires non-empty 'code'")
    timeout_s = config.get("timeout_s") or python_exec.DEFAULT_TIMEOUT_S
    rows = inputs[0] if inputs else []
    try:
        out_rows, out_memory = await python_exec.run_python_block(
            code, rows, dict(ctx.memory), timeout_s=float(timeout_s)
        )
    except python_exec.PythonExecError as exc:
        raise WorkflowError(422, str(exc)) from exc
    ctx.memory.clear()
    ctx.memory.update(out_memory)
    return out_rows[:ROW_CAP_PER_BLOCK]


async def _run_op_sql(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    query = config.get("query") or ""
    if not isinstance(query, str) or not query.strip():
        raise WorkflowError(422, "op.sql requires non-empty 'query'")
    tables: dict[str, list[Row]] = {}
    if inputs and len(inputs) >= 1:
        tables["t"] = inputs[0]
    if len(inputs) >= 2:
        tables["t2"] = inputs[1]
    try:
        rows, _cols = await asyncio.to_thread(
            sqlrun.run_sql, query, tables, timeout_s=10.0, max_rows=ROW_CAP_PER_BLOCK
        )
    except sqlrun.SqlError as exc:
        raise WorkflowError(422, str(exc)) from exc
    return rows


def _render_template(template: str, rows: list[Row], memory: dict[str, Any]) -> str:
    payload = json.dumps(rows[:_LLM_ROWS_CAP], default=str)[:_LLM_BYTES_CAP]
    mem_payload = json.dumps(memory, default=str)[:_LLM_BYTES_CAP]
    return template.replace("{rows}", payload).replace("{memory}", mem_payload)


async def _run_op_llm(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    from app import (
        llm,  # noqa: PLC0415 — imported lazily so tests can monkeypatch app.workflows.blocks.llm
    )

    tier = config.get("tier") or "fast"
    system = config.get("system") or "You are a data analyst."
    prompt = config.get("prompt") or "{rows}"
    mode = config.get("mode") or "per_batch"
    json_mode = bool(config.get("json_mode", True))
    rows = inputs[0] if inputs else []

    async def _call(user_content: str) -> Any:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ]
        if json_mode:
            parsed, res = await llm.chat_json(messages, tier=tier, label="workflows.op_llm")
            if not res.ok:
                raise WorkflowError(502, f"llm call failed: {res.error or 'unknown error'}")
            return parsed
        res = await llm.chat(messages, tier=tier, label="workflows.op_llm")
        if not res.ok:
            raise WorkflowError(502, f"llm call failed: {res.error or 'unknown error'}")
        return res.text

    if mode == "per_row":
        out: list[Row] = []
        for r in rows[:_LLM_PER_ROW_CAP]:
            content = _render_template(prompt, [r], ctx.memory)
            try:
                result = await _call(content)
            except WorkflowError as exc:
                out.append({**r, "llm": None, "llm_error": exc.detail})
                continue
            out.append({**r, "llm": result})
        return out

    # per_batch — one summary row.
    content = _render_template(prompt, rows, ctx.memory)
    try:
        result = await _call(content)
    except WorkflowError as exc:
        return [{"llm_error": exc.detail}]
    if isinstance(result, dict):
        return [result]
    return [{"result": result}]


_register(
    BlockSpec(
        type="op.steps",
        category="op",
        title="Steps (Foundry DSL)",
        description=(
            "filter/derive/join/aggregate/sort/limit/dedup/select/rename/cast,"
            " reusing the Foundry transform DSL."
        ),
        min_inputs=1,
        max_inputs=2,
        config_schema=[
            ConfigField(
                "steps", "json", "Steps (JSON list)", required=True,
                help='e.g. [{"type":"filter","expr":"alt_m > 3000"}]. A second input\'s'
                " rows are reachable from a join/union step via \"right\": \"input2\".",
            ),
        ],
        run=_run_op_steps,
    )
)
_register(
    BlockSpec(
        type="op.geo",
        category="op",
        title="Geo filter/join",
        description="within_bbox | within_radius | near_join (haversine).",
        min_inputs=1,
        max_inputs=2,
        config_schema=[
            ConfigField(
                "mode", "select", "Mode", required=True, default="within_bbox",
                options=["within_bbox", "within_radius", "near_join"],
            ),
            ConfigField("lat_col", "string", "Latitude column", default="lat"),
            ConfigField("lon_col", "string", "Longitude column", default="lon"),
            ConfigField(
                "bbox", "string", "Bounding box (within_bbox)",
                placeholder="min_lon,min_lat,max_lon,max_lat",
            ),
            ConfigField("center_lat", "float", "Center latitude (within_radius)"),
            ConfigField("center_lon", "float", "Center longitude (within_radius)"),
            ConfigField("radius_km", "float", "Radius km (within_radius)"),
            ConfigField("right_lat_col", "string", "2nd input latitude column (near_join)"),
            ConfigField("right_lon_col", "string", "2nd input longitude column (near_join)"),
            ConfigField("max_km", "float", "Max distance km (near_join)", default=10.0),
        ],
        run=_run_op_geo,
    )
)
_register(
    BlockSpec(
        type="op.python",
        category="op",
        title="Python",
        description="Run operator code: def run(rows, memory) -> rows | {rows, memory}.",
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField(
                "code", "text", "Python code", required=True,
                help="Must define run(rows: list[dict], memory: dict) -> list[dict]"
                " | {'rows': [...], 'memory': {...}}. Runs in a resource-limited"
                " subprocess on your own machine (BYO-compute, not a hostile-tenant sandbox).",
            ),
            ConfigField("timeout_s", "int", "Timeout (s, max 60)", default=30),
        ],
        run=_run_op_python,
    )
)
_register(
    BlockSpec(
        type="op.sql",
        category="op",
        title="SQL",
        description="Read-only SELECT/WITH over this block's input(s) as tables t (and t2).",
        min_inputs=1,
        max_inputs=2,
        config_schema=[
            ConfigField(
                "query", "text", "SQL query", required=True, placeholder="SELECT * FROM t LIMIT 50",
            ),
        ],
        run=_run_op_sql,
    )
)
_register(
    BlockSpec(
        type="op.llm",
        category="op",
        title="LLM",
        description=(
            "Call the LLM ladder over rows: per_batch (one summary row) or per_row (≤50 rows)."
        ),
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField("tier", "select", "Tier", default="fast", options=["fast", "reason"]),
            ConfigField("system", "text", "System prompt"),
            ConfigField(
                "prompt", "text", "Prompt template", required=True,
                help="Use {rows} (JSON, capped 100 rows/20KB) and {memory}.",
            ),
            ConfigField(
                "mode", "select", "Mode", default="per_batch", options=["per_batch", "per_row"],
            ),
            ConfigField("json_mode", "bool", "Parse reply as JSON", default=True),
        ],
        run=_run_op_llm,
    )
)


# ═══════════════════════════════════════════════════════════════════════════════
# Sinks (1 input, pass rows through)
# ═══════════════════════════════════════════════════════════════════════════════


def _template_row(template: str, row: Row) -> str:
    out = template
    for k, v in row.items():
        out = out.replace("{" + k + "}", str(v))
    return out


async def _run_sink_alert(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    rows = inputs[0] if inputs else []
    severity = config.get("severity") or "info"
    if severity not in ("info", "low", "medium", "high", "critical"):
        severity = "info"
    template = config.get("message_template") or "workflow alert ({count} rows)"
    mode = config.get("mode") or "summary"
    rule_id = f"workflow:{ctx.workflow_id}"

    def _publish(message: str, lon: float, lat: float) -> None:
        if ctx.alert_budget[0] <= 0:
            return
        ctx.alert_budget[0] -= 1
        bus.publish(
            Alert(
                id=f"wf_{uuid.uuid4().hex[:12]}",
                rule_id=rule_id,
                severity=severity,  # type: ignore[arg-type]
                t=time.time(),
                lon=lon,
                lat=lat,
                confidence=1.0,
                message=message,
            )
        )

    if mode == "per_row":
        for r in rows:
            if ctx.alert_budget[0] <= 0:
                break
            lon = _num(r.get("lon")) or 0.0
            lat = _num(r.get("lat")) or 0.0
            _publish(_template_row(template, r), lon, lat)
    else:
        lon = lat = 0.0
        for r in rows:
            lo, la = _num(r.get("lon")), _num(r.get("lat"))
            if lo is not None and la is not None:
                lon, lat = lo, la
                break
        _publish(template.replace("{count}", str(len(rows))), lon, lat)

    return rows


async def _run_sink_ontology(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    """Upsert objects ``workflow:{wf_id}:{key}`` — same id scheme and
    ``upsert`` (not ``assert_props``) usage as the Foundry binding sync
    (``app/foundry/binding.py``, verified there NOT to have the
    kind-only-set-on-INSERT bug ``assert_props`` has)."""
    rows = inputs[0] if inputs else []
    object_kind = (config.get("object_kind") or "").strip()
    key_column = (config.get("key_column") or "").strip()
    if object_kind not in _KNOWN_KINDS:
        raise WorkflowError(422, f"sink.ontology: unknown object_kind {object_kind!r}")
    if not key_column:
        raise WorkflowError(422, "sink.ontology requires 'key_column'")
    prop_columns_raw = config.get("prop_columns")
    reg = get_registry(ctx.user_ctx)
    source = f"workflow:{ctx.workflow_id}"
    minted = updated = skipped = 0
    for row in rows:
        key_val = row.get(key_column)
        if key_val is None:
            skipped += 1
            continue
        object_id = f"workflow:{ctx.workflow_id}:{key_val}"
        if prop_columns_raw:
            cols = (
                prop_columns_raw
                if isinstance(prop_columns_raw, list)
                else str(prop_columns_raw).split(",")
            )
            props = {c.strip(): row.get(c.strip()) for c in cols if c.strip()}
        else:
            props = dict(row)
        existing = await reg.get(object_id)
        await reg.upsert(Object(id=object_id, kind=object_kind, props=props), source=source)
        if existing is None:
            minted += 1
        else:
            updated += 1
    ctx.set_memory(
        "_sink_ontology_last", {"minted": minted, "updated": updated, "skipped": skipped}
    )
    return rows


async def _run_sink_dataset(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    rows = inputs[0] if inputs else []
    name = (config.get("dataset_name") or "").strip()
    if not name:
        raise WorkflowError(422, "sink.dataset requires 'dataset_name'")
    store = FoundryStore()
    ds = await store.get_dataset_by_name(name)
    if ds is None:
        ds = await store.create_dataset(
            name, description=f"workflow:{ctx.workflow_id}", kind="derived"
        )
    schema = infer_schema(rows)
    try:
        await store.add_version(ds["id"], rows, schema, source=f"workflow:{ctx.workflow_id}")
    except FoundryError as exc:
        raise WorkflowError(exc.status_code, exc.detail) from exc
    return rows


async def _run_sink_memory(
    config: dict[str, Any], inputs: list[list[Row]], ctx: BlockCtx
) -> list[Row]:
    rows = inputs[0] if inputs else []
    key = (config.get("key") or "").strip()
    if not key:
        raise WorkflowError(422, "sink.memory requires 'key'")
    ctx.set_memory(key, rows)
    return rows


_register(
    BlockSpec(
        type="sink.alert",
        category="sink",
        title="Alert",
        description="Publish an Alert to the live bus (summary or per-row), capped 20/run.",
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField(
                "mode", "select", "Mode", default="summary", options=["summary", "per_row"],
            ),
            ConfigField(
                "severity", "select", "Severity", default="info",
                options=["info", "low", "medium", "high", "critical"],
            ),
            ConfigField(
                "message_template", "string", "Message template",
                help="summary: {count}. per_row: {col_name} for any input column.",
            ),
        ],
        run=_run_sink_alert,
    )
)
_register(
    BlockSpec(
        type="sink.ontology",
        category="sink",
        title="Ontology",
        description="Upsert rows as ontology objects workflow:{wf_id}:{key}.",
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField(
                "object_kind", "select", "Object kind", required=True, options=sorted(_KNOWN_KINDS),
            ),
            ConfigField("key_column", "string", "Key column", required=True),
            ConfigField(
                "prop_columns", "string", "Prop columns (comma-separated, optional)",
                help="Empty = every column becomes a prop.",
            ),
        ],
        run=_run_sink_ontology,
    )
)
_register(
    BlockSpec(
        type="sink.dataset",
        category="sink",
        title="Foundry dataset",
        description="Write rows as a new version of a named Foundry dataset (created if missing).",
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField("dataset_name", "string", "Dataset name", required=True),
        ],
        run=_run_sink_dataset,
    )
)
_register(
    BlockSpec(
        type="sink.memory",
        category="sink",
        title="Memory",
        description="Write this block's input rows into workflow memory under a key.",
        min_inputs=1,
        max_inputs=1,
        config_schema=[
            ConfigField("key", "string", "Memory key", required=True),
        ],
        run=_run_sink_memory,
    )
)


def catalog() -> list[dict[str, Any]]:
    """The block catalog as JSON — ``GET /api/workflows/blocks``."""
    return [BLOCKS[t].to_json() for t in BLOCKS]
