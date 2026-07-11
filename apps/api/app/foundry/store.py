"""Foundry SQLite store — datasets, versions, rows, transforms, builds,
schedules, bindings.

Same idiom as ``app/history.py`` / ``app/intel/ontology_local.py``: a fresh
``sqlite3.connect`` per operation, WAL journal mode, a module-level
``override_db_path`` hook so tests never touch the repo's ``data/`` dir, and
sync cores run through ``run_in_executor`` from async call sites.

The schema mirrors ``docs/foundry-plan.md`` exactly (frozen contract) — do not
rename columns/tables without updating that doc.
"""

from __future__ import annotations

import asyncio
import calendar
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings

# ── DB path injection (for tests) ─────────────────────────────────────────────

_db_path_override: str | None = None

# Paths whose schema/migrations have already run this process — executescript
# + _ensure_migrations is a per-call PRAGMA/DDL cost paid on every _connect()
# otherwise; a fresh path (real DB or a test's tmp_path) only needs it once.
_initialized_paths: set[str] = set()


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear.

    Also resets the schema-init cache so a test pointing at a brand-new
    tmp_path always gets ``CREATE TABLE``/migrations run against it, and so
    test isolation never sees another test's "already initialized" path.
    """
    global _db_path_override
    _db_path_override = path
    _initialized_paths.clear()


def _resolved_db_path(settings: Settings | None = None) -> str:
    if _db_path_override is not None:
        return _db_path_override
    return (settings or get_settings()).foundry_db_path


# ── schema ─────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'raw',
  schema_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id),
  version INTEGER NOT NULL, row_count INTEGER NOT NULL,
  source TEXT NOT NULL,
  schema_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(dataset_id, version)
);
CREATE TABLE IF NOT EXISTS rows (
  dataset_id TEXT NOT NULL, version INTEGER NOT NULL,
  idx INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(dataset_id, version, idx)
);
CREATE TABLE IF NOT EXISTS transforms (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  inputs_json TEXT NOT NULL,
  output_dataset_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY, transform_id TEXT,
  scope TEXT NOT NULL DEFAULT 'transform',
  status TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  rows_out INTEGER, error TEXT, log_json TEXT NOT NULL DEFAULT '[]',
  input_versions_json TEXT NOT NULL DEFAULT '{}',
  quarantined INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dead_letter (
  id INTEGER PRIMARY KEY, dataset_id TEXT NOT NULL, build_id TEXT NOT NULL,
  step INTEGER NOT NULL, step_type TEXT NOT NULL, error TEXT NOT NULL,
  row_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dead_letter_dataset ON dead_letter(dataset_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, transform_id TEXT NOT NULL, interval_s INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, created_at TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS bindings (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, object_kind TEXT NOT NULL,
  key_column TEXT NOT NULL, prop_map_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_sync TEXT,
  last_result_json TEXT, created_at TEXT NOT NULL,
  resolve INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, params_json TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS check_results (
  dataset_id TEXT NOT NULL, version INTEGER NOT NULL, check_id TEXT NOT NULL,
  passed INTEGER NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, name TEXT NOT NULL,
  trigger TEXT NOT NULL, condition_expr TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL, llm_tier TEXT NOT NULL DEFAULT 'fast',
  llm_system TEXT NOT NULL DEFAULT '', llm_prompt TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium', enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_events (
  id INTEGER PRIMARY KEY, monitor_id TEXT NOT NULL, at TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_monitor_events_monitor ON monitor_events(monitor_id);
"""

# Bounding (docs/foundry-plan.md): per-dataset row cap + version retention.
MAX_ROWS_PER_DATASET = 200_000
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
KEEP_VERSIONS = 5


def _ensure_migrations(con: sqlite3.Connection) -> None:
    """Idempotent ALTER TABLE for columns added after a foundry.db might
    already exist on disk — ``CREATE TABLE IF NOT EXISTS`` never adds columns
    to a table that already exists."""
    cols = {r[1] for r in con.execute("PRAGMA table_info(builds)").fetchall()}
    if "input_versions_json" not in cols:
        con.execute("ALTER TABLE builds ADD COLUMN input_versions_json TEXT NOT NULL DEFAULT '{}'")
    if "quarantined" not in cols:
        con.execute("ALTER TABLE builds ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0")
    sched_cols = {r[1] for r in con.execute("PRAGMA table_info(schedules)").fetchall()}
    if "last_error" not in sched_cols:
        con.execute("ALTER TABLE schedules ADD COLUMN last_error TEXT")
    binding_cols = {r[1] for r in con.execute("PRAGMA table_info(bindings)").fetchall()}
    if "resolve" not in binding_cols:
        con.execute("ALTER TABLE bindings ADD COLUMN resolve INTEGER NOT NULL DEFAULT 0")


def _connect(settings: Settings | None = None) -> sqlite3.Connection:
    path = _resolved_db_path(settings)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    if path not in _initialized_paths:
        con.executescript(_SCHEMA)
        _ensure_migrations(con)
        con.commit()
        _initialized_paths.add(path)
    return con


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class FoundryError(Exception):
    """Raised for store-level failures the route layer maps to HTTP errors."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class FoundryStore:
    """The Foundry substrate store. One instance is cheap — opens a fresh
    connection per call, exactly like ``SqliteRegistry``."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.s = settings or get_settings()

    async def _run(self, fn: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(None, fn)

    # ---- datasets -----------------------------------------------------------

    def _dataset_row(self, con: sqlite3.Connection, dataset_id: str) -> dict[str, Any] | None:
        row = con.execute(
            "SELECT id, name, description, kind, schema_json, created_at,"
            " updated_at FROM datasets WHERE id=?",
            (dataset_id,),
        ).fetchone()
        if row is None:
            return None
        latest = con.execute(
            "SELECT version, row_count FROM versions WHERE dataset_id=?"
            " ORDER BY version DESC LIMIT 1",
            (dataset_id,),
        ).fetchone()
        latest_version = latest[0] if latest else 0
        row_count = latest[1] if latest else 0
        return {
            "id": row[0],
            "name": row[1],
            "description": row[2],
            "kind": row[3],
            "schema": json.loads(row[4]),
            "created_at": row[5],
            "updated_at": row[6],
            "latest_version": latest_version,
            "row_count": row_count,
        }

    async def create_dataset(
        self, name: str, description: str = "", kind: str = "raw"
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM datasets WHERE name=?", (name,)
                ).fetchone()
                if existing:
                    raise FoundryError(409, f"dataset {name!r} already exists")
                did = new_id("ds")
                now = _now_iso()
                con.execute(
                    "INSERT INTO datasets (id, name, description, kind,"
                    " schema_json, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (did, name, description, kind, "[]", now, now),
                )
                con.commit()
                return self._dataset_row(con, did)
            finally:
                con.close()

        return await self._run(_sync)

    async def list_datasets(self) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                ids = [
                    r[0]
                    for r in con.execute(
                        "SELECT id FROM datasets ORDER BY created_at DESC"
                    ).fetchall()
                ]
                return [self._dataset_row(con, did) for did in ids]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_dataset(self, dataset_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                return self._dataset_row(con, dataset_id)
            finally:
                con.close()

        return await self._run(_sync)

    async def get_dataset_by_name(self, name: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE name=?", (name,)
                ).fetchone()
                return self._dataset_row(con, row[0]) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_dataset(self, dataset_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                deps = con.execute(
                    "SELECT name FROM transforms WHERE output_dataset_id=?"
                    " OR inputs_json LIKE ?",
                    (dataset_id, f'%"{dataset_id}"%'),
                ).fetchall()
                if deps:
                    names = ", ".join(d[0] for d in deps)
                    raise FoundryError(
                        409,
                        f"dataset is used by transform(s): {names}",
                    )
                con.execute("DELETE FROM rows WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM versions WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM bindings WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM checks WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM check_results WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM dead_letter WHERE dataset_id=?", (dataset_id,))
                con.execute("DELETE FROM datasets WHERE id=?", (dataset_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def _enabled_checks(self, dataset_id: str) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT id, name, type, params_json, severity FROM checks"
                    " WHERE dataset_id=? AND enabled=1",
                    (dataset_id,),
                ).fetchall()
                return [
                    {
                        "id": r[0],
                        "name": r[1],
                        "type": r[2],
                        "params": json.loads(r[3]),
                        "severity": r[4],
                    }
                    for r in rows
                ]
            finally:
                con.close()

        return await self._run(_sync)

    async def _eval_checks_or_raise(
        self, dataset_id: str, rows: list[dict[str, Any]], schema: list[dict[str, str]]
    ) -> list[dict[str, Any]]:
        """Evaluate every enabled check for ``dataset_id`` against candidate
        rows. Raises ``FoundryError(422, ...)`` if any enabled fail-severity
        check fails (nothing is recorded — caller must not write the
        version). Returns the pass/warn-fail results to record once the
        version IS written."""
        from app.foundry import (
            checks as checks_mod,  # noqa: PLC0415 — break the store<->checks cycle
        )

        defs = await self._enabled_checks(dataset_id)
        if not defs:
            return []
        results: list[dict[str, Any]] = []
        blocking: list[str] = []
        for c in defs:
            ok, detail = checks_mod.evaluate_check(c["type"], c["params"], rows, schema)
            results.append({"check_id": c["id"], "passed": ok, "detail": f"{c['name']}: {detail}"})
            if not ok and c["severity"] == "fail":
                blocking.append(f"{c['name']} ({c['type']}): {detail}")
        if blocking:
            raise FoundryError(422, "check(s) failed: " + "; ".join(blocking))
        return results

    async def record_check_results(
        self, dataset_id: str, version: int, results: list[dict[str, Any]]
    ) -> None:
        if not results:
            return

        def _sync() -> None:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.executemany(
                    "INSERT INTO check_results (dataset_id, version, check_id,"
                    " passed, detail, created_at) VALUES (?,?,?,?,?,?)",
                    [
                        (dataset_id, version, r["check_id"], int(r["passed"]), r["detail"], now)
                        for r in results
                    ],
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def add_version(
        self,
        dataset_id: str,
        rows: list[dict[str, Any]],
        schema: list[dict[str, str]],
        source: str,
    ) -> dict[str, Any]:
        """Write a new immutable version (upload or build). Enforces the row
        cap, runs data expectations (checks) — a fail-severity failure blocks
        the write entirely — and prunes rows of versions beyond
        ``KEEP_VERSIONS`` (the version record itself is kept for
        history/lineage)."""
        if len(rows) > MAX_ROWS_PER_DATASET:
            raise FoundryError(
                422,
                f"row cap exceeded: {len(rows)} > {MAX_ROWS_PER_DATASET}",
            )
        try:
            check_results = await self._eval_checks_or_raise(dataset_id, rows, schema)
        except FoundryError as exc:
            from app.foundry import (
                monitors as monitors_mod,  # noqa: PLC0415 — break the store<->monitors cycle
            )

            await monitors_mod.evaluate_monitors(
                self,
                dataset_id,
                trigger_kind="check_failed",
                context={"error": exc.detail, "rows": rows[:50]},
            )
            raise

        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                last = con.execute(
                    "SELECT MAX(version) FROM versions WHERE dataset_id=?",
                    (dataset_id,),
                ).fetchone()
                version = (last[0] or 0) + 1
                now = _now_iso()
                con.execute(
                    "INSERT INTO versions (dataset_id, version, row_count,"
                    " source, schema_json, created_at) VALUES (?,?,?,?,?,?)",
                    (
                        dataset_id,
                        version,
                        len(rows),
                        source,
                        json.dumps(schema),
                        now,
                    ),
                )
                con.executemany(
                    "INSERT INTO rows (dataset_id, version, idx, data)"
                    " VALUES (?,?,?,?)",
                    [
                        (dataset_id, version, i, json.dumps(r))
                        for i, r in enumerate(rows)
                    ],
                )
                con.execute(
                    "UPDATE datasets SET schema_json=?, updated_at=?"
                    " WHERE id=?",
                    (json.dumps(schema), now, dataset_id),
                )
                # prune rows of versions beyond the retention window; keep the
                # version record itself for history.
                old_versions = [
                    r[0]
                    for r in con.execute(
                        "SELECT version FROM versions WHERE dataset_id=?"
                        " ORDER BY version DESC",
                        (dataset_id,),
                    ).fetchall()[KEEP_VERSIONS:]
                ]
                for ov in old_versions:
                    con.execute(
                        "DELETE FROM rows WHERE dataset_id=? AND version=?",
                        (dataset_id, ov),
                    )
                con.commit()
                return self._dataset_row(con, dataset_id)
            finally:
                con.close()

        dataset_row = await self._run(_sync)
        await self.record_check_results(dataset_id, dataset_row["latest_version"], check_results)
        from app.foundry import (
            monitors as monitors_mod,  # noqa: PLC0415 — break the store<->monitors cycle
        )

        # Single choke point for the "a version was written" event: every
        # writer (upload, append, rollback, transform build) funnels through
        # add_version, so hooking here — rather than duplicating the call at
        # each of those call sites — covers new_version/row_condition monitors
        # for all of them uniformly.
        await monitors_mod.evaluate_monitors(
            self,
            dataset_id,
            trigger_kind="version_written",
            context={"rows": rows, "schema": schema, "version": dataset_row["latest_version"]},
        )
        return dataset_row

    def _rows_for_version_sync(
        self, con: sqlite3.Connection, dataset_id: str, version: int
    ) -> list[dict[str, Any]]:
        data_rows = con.execute(
            "SELECT data FROM rows WHERE dataset_id=? AND version=? ORDER BY idx",
            (dataset_id, version),
        ).fetchall()
        return [json.loads(r[0]) for r in data_rows]

    def _version_rows_pruned_sync(
        self, con: sqlite3.Connection, dataset_id: str, version: int, expected_row_count: int
    ) -> bool:
        """True iff ``version`` should have rows but its row data was pruned
        by the ``KEEP_VERSIONS`` retention window."""
        if expected_row_count <= 0:
            return False
        actual = con.execute(
            "SELECT COUNT(*) FROM rows WHERE dataset_id=? AND version=?",
            (dataset_id, version),
        ).fetchone()[0]
        return actual == 0

    async def append_version(
        self, dataset_id: str, new_rows: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """Append transaction: new version's rows = latest version's rows +
        ``new_rows``; schema is re-inferred over the union (existing
        schema-merge logic in ``ingest.infer_schema``). 404 unknown dataset,
        410 if the latest version's rows were pruned by retention."""

        def _read_latest() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                last = con.execute(
                    "SELECT version, row_count FROM versions WHERE dataset_id=?"
                    " ORDER BY version DESC LIMIT 1",
                    (dataset_id,),
                ).fetchone()
                if last is None:
                    return []
                last_version, last_count = last
                if self._version_rows_pruned_sync(con, dataset_id, last_version, last_count):
                    raise FoundryError(
                        410, f"latest version {last_version}'s rows were pruned; cannot append"
                    )
                return self._rows_for_version_sync(con, dataset_id, last_version)
            finally:
                con.close()

        existing_rows = await self._run(_read_latest)
        from app.foundry.ingest import (
            infer_schema,  # noqa: PLC0415 — break the store<->ingest cycle
        )

        combined = [*existing_rows, *new_rows]
        schema = infer_schema(combined)
        return await self.add_version(dataset_id, combined, schema, source="upload:append")

    async def get_version(self, dataset_id: str, version: int) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT version, row_count, source, created_at FROM versions"
                    " WHERE dataset_id=? AND version=?",
                    (dataset_id, version),
                ).fetchone()
                if row is None:
                    return None
                return {
                    "version": row[0],
                    "row_count": row[1],
                    "source": row[2],
                    "created_at": row[3],
                }
            finally:
                con.close()

        return await self._run(_sync)

    async def rollback_version(self, dataset_id: str, target_version: int) -> dict[str, Any]:
        """Create a NEW latest version whose rows/schema are copied from
        ``target_version``. 404 unknown dataset, 422 unknown version, 410 if
        that version's rows were pruned by retention."""

        def _read_target() -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                ver = con.execute(
                    "SELECT row_count, schema_json FROM versions"
                    " WHERE dataset_id=? AND version=?",
                    (dataset_id, target_version),
                ).fetchone()
                if ver is None:
                    raise FoundryError(422, f"unknown version: {target_version}")
                row_count, schema_json = ver
                if self._version_rows_pruned_sync(con, dataset_id, target_version, row_count):
                    raise FoundryError(
                        410,
                        f"version {target_version}'s rows were pruned; cannot roll back",
                    )
                rows = self._rows_for_version_sync(con, dataset_id, target_version)
                schema = json.loads(schema_json)
                return rows, schema
            finally:
                con.close()

        rows, schema = await self._run(_read_target)
        return await self.add_version(
            dataset_id, rows, schema, source=f"rollback:{target_version}"
        )

    async def get_versions(self, dataset_id: str) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT version, row_count, source, created_at FROM"
                    " versions WHERE dataset_id=? ORDER BY version DESC",
                    (dataset_id,),
                ).fetchall()
                return [
                    {
                        "version": r[0],
                        "row_count": r[1],
                        "source": r[2],
                        "created_at": r[3],
                    }
                    for r in rows
                ]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_rows(
        self,
        dataset_id: str,
        version: int | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                ds = con.execute(
                    "SELECT schema_json FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if ds is None:
                    return None
                v = version
                if v is None:
                    last = con.execute(
                        "SELECT MAX(version) FROM versions WHERE dataset_id=?",
                        (dataset_id,),
                    ).fetchone()
                    v = last[0] or 0
                ver_row = con.execute(
                    "SELECT schema_json, row_count FROM versions"
                    " WHERE dataset_id=? AND version=?",
                    (dataset_id, v),
                ).fetchone()
                schema = json.loads(ver_row[0]) if ver_row else json.loads(ds[0])
                total = ver_row[1] if ver_row else 0
                data_rows = con.execute(
                    "SELECT data FROM rows WHERE dataset_id=? AND version=?"
                    " ORDER BY idx LIMIT ? OFFSET ?",
                    (dataset_id, v, int(limit), int(offset)),
                ).fetchall()
                return {
                    "schema": schema,
                    "rows": [json.loads(r[0]) for r in data_rows],
                    "total": total,
                    "version": v,
                }
            finally:
                con.close()

        return await self._run(_sync)

    async def latest_rows(self, dataset_id: str) -> list[dict[str, Any]]:
        """All rows of the latest version — used by transform execution."""

        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                last = con.execute(
                    "SELECT MAX(version) FROM versions WHERE dataset_id=?",
                    (dataset_id,),
                ).fetchone()
                v = last[0] if last else None
                if v is None:
                    return []
                data_rows = con.execute(
                    "SELECT data FROM rows WHERE dataset_id=? AND version=?"
                    " ORDER BY idx",
                    (dataset_id, v),
                ).fetchall()
                return [json.loads(r[0]) for r in data_rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_stats(
        self, dataset_id: str, version: int | None = None
    ) -> list[dict[str, Any]] | None:
        payload = await self.get_rows(
            dataset_id, version=version, limit=MAX_ROWS_PER_DATASET, offset=0
        )
        if payload is None:
            return None
        rows = payload["rows"]
        schema = payload["schema"]
        stats: list[dict[str, Any]] = []
        for col in schema:
            name = col["name"]
            values = [r.get(name) for r in rows]
            non_null = [v for v in values if v is not None]
            nulls = len(values) - len(non_null)
            distinct = len({json.dumps(v, sort_keys=True) for v in non_null})
            numeric = [
                v for v in non_null
                if isinstance(v, (int, float)) and not isinstance(v, bool)
            ]
            vmin: Any = None
            vmax: Any = None
            if numeric:
                vmin, vmax = min(numeric), max(numeric)
            elif non_null:
                try:
                    vmin, vmax = min(non_null), max(non_null)
                except TypeError:
                    vmin = vmax = None
            stats.append(
                {
                    "name": name,
                    "type": col.get("type", "str"),
                    "nulls": nulls,
                    "distinct": distinct,
                    "min": vmin,
                    "max": vmax,
                }
            )
        return stats

    # ---- transforms -----------------------------------------------------------

    def _transform_row(self, con: sqlite3.Connection, tid: str) -> dict[str, Any] | None:
        row = con.execute(
            "SELECT id, name, description, inputs_json, output_dataset_id,"
            " steps_json, created_at, updated_at FROM transforms WHERE id=?",
            (tid,),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "name": row[1],
            "description": row[2],
            "inputs": json.loads(row[3]),
            "output_dataset_id": row[4],
            "steps": json.loads(row[5]),
            "created_at": row[6],
            "updated_at": row[7],
        }

    async def create_transform(
        self,
        name: str,
        description: str,
        inputs: list[str],
        output_dataset_id: str,
        steps: list[dict[str, Any]],
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM transforms WHERE name=?", (name,)
                ).fetchone()
                if existing:
                    raise FoundryError(409, f"transform {name!r} already exists")
                tid = new_id("tf")
                now = _now_iso()
                con.execute(
                    "INSERT INTO transforms (id, name, description,"
                    " inputs_json, output_dataset_id, steps_json,"
                    " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
                    (
                        tid,
                        name,
                        description,
                        json.dumps(inputs),
                        output_dataset_id,
                        json.dumps(steps),
                        now,
                        now,
                    ),
                )
                con.commit()
                return self._transform_row(con, tid)
            finally:
                con.close()

        return await self._run(_sync)

    async def update_transform(
        self,
        transform_id: str,
        name: str,
        description: str,
        inputs: list[str],
        output_dataset_id: str,
        steps: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM transforms WHERE id=?", (transform_id,)
                ).fetchone()
                if existing is None:
                    return None
                now = _now_iso()
                con.execute(
                    "UPDATE transforms SET name=?, description=?,"
                    " inputs_json=?, output_dataset_id=?, steps_json=?,"
                    " updated_at=? WHERE id=?",
                    (
                        name,
                        description,
                        json.dumps(inputs),
                        output_dataset_id,
                        json.dumps(steps),
                        now,
                        transform_id,
                    ),
                )
                con.commit()
                return self._transform_row(con, transform_id)
            finally:
                con.close()

        return await self._run(_sync)

    async def list_transforms(self) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                ids = [
                    r[0]
                    for r in con.execute(
                        "SELECT id FROM transforms ORDER BY created_at DESC"
                    ).fetchall()
                ]
                return [self._transform_row(con, tid) for tid in ids]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_transform(self, transform_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                return self._transform_row(con, transform_id)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_transform(self, transform_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM transforms WHERE id=?", (transform_id,))
                con.execute(
                    "DELETE FROM schedules WHERE transform_id=?", (transform_id,)
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    # ---- builds -----------------------------------------------------------

    def _build_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "transform_id": row[1],
            "scope": row[2],
            "status": row[3],
            "started_at": row[4],
            "finished_at": row[5],
            "rows_out": row[6],
            "error": row[7],
            "log": json.loads(row[8]) if row[8] else [],
            "input_versions": json.loads(row[9]) if len(row) > 9 and row[9] else {},
            "quarantined": row[10] if len(row) > 10 and row[10] is not None else 0,
        }

    async def set_build_input_versions(
        self, build_id: str, input_versions: dict[str, int]
    ) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute(
                    "UPDATE builds SET input_versions_json=? WHERE id=?",
                    (json.dumps(input_versions), build_id),
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def most_recent_successful_build_for_transform(
        self, transform_id: str
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds WHERE transform_id=? AND status='succeeded'"
                    " ORDER BY finished_at DESC LIMIT 1",
                    (transform_id,),
                ).fetchone()
                return self._build_row(row) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def create_build(
        self, transform_id: str | None, scope: str
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                bid = new_id("bld")
                now = _now_iso()
                con.execute(
                    "INSERT INTO builds (id, transform_id, scope, status,"
                    " started_at, log_json) VALUES (?,?,?,?,?,?)",
                    (bid, transform_id, scope, "running", now, "[]"),
                )
                con.commit()
                row = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds"
                    " WHERE id=?",
                    (bid,),
                ).fetchone()
                return self._build_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def finish_build(
        self,
        build_id: str,
        status: str,
        rows_out: int | None,
        error: str | None,
        log: list[str],
        quarantined: int = 0,
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.execute(
                    "UPDATE builds SET status=?, finished_at=?, rows_out=?,"
                    " error=?, log_json=?, quarantined=? WHERE id=?",
                    (status, now, rows_out, error, json.dumps(log), int(quarantined), build_id),
                )
                con.commit()
                row = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds"
                    " WHERE id=?",
                    (build_id,),
                ).fetchone()
                return self._build_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def get_build(self, build_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds"
                    " WHERE id=?",
                    (build_id,),
                ).fetchone()
                return self._build_row(row) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def list_builds(self, limit: int = 50) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds"
                    " ORDER BY started_at DESC LIMIT ?",
                    (int(limit),),
                ).fetchall()
                return [self._build_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def builds_since(self, iso_cutoff: str) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT id, transform_id, scope, status, started_at,"
                    " finished_at, rows_out, error, log_json, input_versions_json,"
                    " quarantined"
                    " FROM builds"
                    " WHERE started_at >= ?",
                    (iso_cutoff,),
                ).fetchall()
                return [self._build_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    # ---- dead-letter (quarantined rows) --------------------------------------

    async def record_dead_letter(
        self, dataset_id: str, build_id: str, rows: list[dict[str, Any]]
    ) -> None:
        """Persist the rows a build quarantined during filter/derive. Replaces
        any prior dead-letter for the dataset — the table reflects the LATEST
        build's bad rows, not an ever-growing pile."""
        if not rows:
            # A clean build clears a prior build's stale dead-letter.
            def _clear() -> None:
                con = _connect(self.s)
                try:
                    con.execute("DELETE FROM dead_letter WHERE dataset_id=?", (dataset_id,))
                    con.commit()
                finally:
                    con.close()

            await self._run(_clear)
            return

        def _sync() -> None:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.execute("DELETE FROM dead_letter WHERE dataset_id=?", (dataset_id,))
                con.executemany(
                    "INSERT INTO dead_letter (dataset_id, build_id, step,"
                    " step_type, error, row_json, created_at) VALUES (?,?,?,?,?,?,?)",
                    [
                        (
                            dataset_id,
                            build_id,
                            r.get("step", 0),
                            r.get("step_type", ""),
                            r.get("error", ""),
                            json.dumps(r.get("row", {})),
                            now,
                        )
                        for r in rows
                    ],
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def get_dead_letter(
        self, dataset_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT build_id, step, step_type, error, row_json, created_at"
                    " FROM dead_letter WHERE dataset_id=? ORDER BY id LIMIT ?",
                    (dataset_id, int(limit)),
                ).fetchall()
                return [
                    {
                        "build_id": r[0],
                        "step": r[1],
                        "step_type": r[2],
                        "error": r[3],
                        "row": json.loads(r[4]),
                        "created_at": r[5],
                    }
                    for r in rows
                ]
            finally:
                con.close()

        return await self._run(_sync)

    # ---- schedules ----------------------------------------------------------

    _SCHEDULE_COLS = "id, transform_id, interval_s, enabled, last_run, created_at, last_error"

    def _schedule_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "transform_id": row[1],
            "interval_s": row[2],
            "enabled": bool(row[3]),
            "last_run": row[4],
            "created_at": row[5],
            "last_error": row[6] if len(row) > 6 else None,
        }

    async def create_schedule(
        self, transform_id: str, interval_s: int, enabled: bool = True
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                sid = new_id("sch")
                now = _now_iso()
                con.execute(
                    "INSERT INTO schedules (id, transform_id, interval_s,"
                    " enabled, created_at) VALUES (?,?,?,?,?)",
                    (sid, transform_id, int(interval_s), int(enabled), now),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE id=?",
                    (sid,),
                ).fetchone()
                return self._schedule_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def update_schedule(
        self, schedule_id: str, interval_s: int, enabled: bool
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM schedules WHERE id=?", (schedule_id,)
                ).fetchone()
                if existing is None:
                    return None
                con.execute(
                    "UPDATE schedules SET interval_s=?, enabled=? WHERE id=?",
                    (int(interval_s), int(enabled), schedule_id),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE id=?",
                    (schedule_id,),
                ).fetchone()
                return self._schedule_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_schedule(self, schedule_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def list_schedules(self) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules ORDER BY created_at DESC"
                ).fetchall()
                return [self._schedule_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def mark_schedule_ran(self, schedule_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute(
                    "UPDATE schedules SET last_run=? WHERE id=?",
                    (_now_iso(), schedule_id),
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def set_schedule_result(
        self, schedule_id: str, *, last_run: str, last_error: str | None
    ) -> None:
        """Record a schedule's outcome — called by the scheduler after every
        tick, success or failure, so ``last_run`` always advances (a broken
        transform can never hot-loop the poller) and the failure is visible
        instead of swallowed. ``last_error=None`` clears a prior failure."""

        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute(
                    "UPDATE schedules SET last_run=?, last_error=? WHERE id=?",
                    (last_run, last_error, schedule_id),
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def due_schedules(self) -> list[dict[str, Any]]:
        """Enabled schedules whose ``interval_s`` has elapsed since ``last_run``.

        A schedule whose ``last_run``/``created_at`` fails to parse (corrupt
        data) is treated as due exactly ONCE and immediately self-repaired
        with a fresh ``last_run`` here — so a malformed timestamp can never
        make a schedule "always due" and hot-loop the 5 s poller."""

        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE enabled=1"
                ).fetchall()
                return [self._schedule_row(r) for r in rows]
            finally:
                con.close()

        all_enabled = await self._run(_sync)
        now = time.time()
        due = []
        for sch in all_enabled:
            last = sch["last_run"] or sch["created_at"]
            try:
                # timestamps are UTC ("...Z", written by _now_iso via
                # time.gmtime) — timegm parses the struct as UTC; mktime
                # would wrongly interpret it as local time and skew "due" by
                # the box's UTC offset.
                last_t = calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ"))
            except (ValueError, TypeError):
                due.append(sch)
                await self.set_schedule_result(
                    sch["id"], last_run=_now_iso(), last_error=sch.get("last_error")
                )
                continue
            if now - last_t >= sch["interval_s"]:
                due.append(sch)
        return due

    # ---- bindings -------------------------------------------------------------

    def _binding_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "dataset_id": row[1],
            "object_kind": row[2],
            "key_column": row[3],
            "prop_map": json.loads(row[4]),
            "enabled": bool(row[5]),
            "last_sync": row[6],
            "last_result": json.loads(row[7]) if row[7] else None,
            "created_at": row[8],
            "resolve": bool(row[9]) if len(row) > 9 else False,
        }

    _BINDING_COLS = (
        "id, dataset_id, object_kind, key_column, prop_map_json, enabled,"
        " last_sync, last_result_json, created_at, resolve"
    )

    async def create_binding(
        self,
        dataset_id: str,
        object_kind: str,
        key_column: str,
        prop_map: dict[str, str],
        enabled: bool = True,
        resolve: bool = False,
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                bid = new_id("bnd")
                now = _now_iso()
                con.execute(
                    "INSERT INTO bindings (id, dataset_id, object_kind,"
                    " key_column, prop_map_json, enabled, created_at, resolve)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (
                        bid,
                        dataset_id,
                        object_kind,
                        key_column,
                        json.dumps(prop_map),
                        int(enabled),
                        now,
                        int(resolve),
                    ),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._BINDING_COLS} FROM bindings WHERE id=?",
                    (bid,),
                ).fetchone()
                return self._binding_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def update_binding(
        self,
        binding_id: str,
        object_kind: str,
        key_column: str,
        prop_map: dict[str, str],
        enabled: bool,
        resolve: bool = False,
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM bindings WHERE id=?", (binding_id,)
                ).fetchone()
                if existing is None:
                    return None
                con.execute(
                    "UPDATE bindings SET object_kind=?, key_column=?,"
                    " prop_map_json=?, enabled=?, resolve=? WHERE id=?",
                    (
                        object_kind,
                        key_column,
                        json.dumps(prop_map),
                        int(enabled),
                        int(resolve),
                        binding_id,
                    ),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._BINDING_COLS} FROM bindings WHERE id=?",
                    (binding_id,),
                ).fetchone()
                return self._binding_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_binding(self, binding_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM bindings WHERE id=?", (binding_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def list_bindings(self) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    f"SELECT {self._BINDING_COLS} FROM bindings ORDER BY created_at DESC"
                ).fetchall()
                return [self._binding_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_binding(self, binding_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    f"SELECT {self._BINDING_COLS} FROM bindings WHERE id=?",
                    (binding_id,),
                ).fetchone()
                return self._binding_row(row) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def record_binding_sync(
        self, binding_id: str, result: dict[str, Any]
    ) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute(
                    "UPDATE bindings SET last_sync=?, last_result_json=?"
                    " WHERE id=?",
                    (_now_iso(), json.dumps(result), binding_id),
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    # ---- checks (data expectations) --------------------------------------------

    def _check_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "dataset_id": row[1],
            "name": row[2],
            "type": row[3],
            "params": json.loads(row[4]),
            "severity": row[5],
            "enabled": bool(row[6]),
            "created_at": row[7],
        }

    _CHECK_COLS = (
        "id, dataset_id, name, type, params_json, severity, enabled, created_at"
    )

    async def create_check(
        self,
        dataset_id: str,
        name: str,
        type_: str,
        params: dict[str, Any],
        severity: str = "warn",
        enabled: bool = True,
    ) -> dict[str, Any]:
        from app.foundry import checks as checks_mod  # noqa: PLC0415

        checks_mod.validate_check(type_, params, severity)

        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                cid = new_id("ck")
                now = _now_iso()
                con.execute(
                    "INSERT INTO checks (id, dataset_id, name, type,"
                    " params_json, severity, enabled, created_at)"
                    " VALUES (?,?,?,?,?,?,?,?)",
                    (cid, dataset_id, name, type_, json.dumps(params), severity, int(enabled), now),
                )
                con.commit()
                r = con.execute(
                    f"SELECT {self._CHECK_COLS} FROM checks WHERE id=?", (cid,)
                ).fetchone()
                return self._check_row(r)
            finally:
                con.close()

        return await self._run(_sync)

    async def update_check(
        self,
        check_id: str,
        name: str,
        type_: str,
        params: dict[str, Any],
        severity: str,
        enabled: bool,
        dataset_id: str | None = None,
    ) -> dict[str, Any] | None:
        from app.foundry import checks as checks_mod  # noqa: PLC0415

        checks_mod.validate_check(type_, params, severity)

        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT dataset_id FROM checks WHERE id=?", (check_id,)
                ).fetchone()
                if existing is None:
                    return None
                # Only touch dataset_id (and clear stale results) on an ACTUAL
                # reassignment — a rename/toggle/param edit sends the same
                # dataset_id and must keep the check's result history intact.
                if dataset_id is not None and dataset_id != existing[0]:
                    ds = con.execute(
                        "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                    ).fetchone()
                    if ds is None:
                        raise FoundryError(404, "dataset not found")
                    con.execute(
                        "UPDATE checks SET name=?, type=?, params_json=?,"
                        " severity=?, enabled=?, dataset_id=? WHERE id=?",
                        (
                            name,
                            type_,
                            json.dumps(params),
                            severity,
                            int(enabled),
                            dataset_id,
                            check_id,
                        ),
                    )
                    # Old check_results belong to the previous dataset/version —
                    # drop them so checks_failing_count doesn't carry a stale
                    # failure onto a dataset the check hasn't run against yet.
                    con.execute("DELETE FROM check_results WHERE check_id=?", (check_id,))
                    con.commit()
                    r = con.execute(
                        f"SELECT {self._CHECK_COLS} FROM checks WHERE id=?", (check_id,)
                    ).fetchone()
                    return self._check_row(r)
                con.execute(
                    "UPDATE checks SET name=?, type=?, params_json=?,"
                    " severity=?, enabled=? WHERE id=?",
                    (name, type_, json.dumps(params), severity, int(enabled), check_id),
                )
                con.commit()
                r = con.execute(
                    f"SELECT {self._CHECK_COLS} FROM checks WHERE id=?", (check_id,)
                ).fetchone()
                return self._check_row(r)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_check(self, check_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM checks WHERE id=?", (check_id,))
                con.execute("DELETE FROM check_results WHERE check_id=?", (check_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def get_check(self, check_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                r = con.execute(
                    f"SELECT {self._CHECK_COLS} FROM checks WHERE id=?", (check_id,)
                ).fetchone()
                return self._check_row(r) if r else None
            finally:
                con.close()

        return await self._run(_sync)

    async def list_checks(self, dataset_id: str | None = None) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                if dataset_id:
                    rows = con.execute(
                        f"SELECT {self._CHECK_COLS} FROM checks WHERE dataset_id=?"
                        " ORDER BY created_at DESC",
                        (dataset_id,),
                    ).fetchall()
                else:
                    rows = con.execute(
                        f"SELECT {self._CHECK_COLS} FROM checks ORDER BY created_at DESC"
                    ).fetchall()
                return [self._check_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def check_results_for_version(
        self, dataset_id: str, version: int
    ) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT check_id, passed, detail, created_at FROM check_results"
                    " WHERE dataset_id=? AND version=? ORDER BY created_at",
                    (dataset_id, version),
                ).fetchall()
                return [
                    {"check_id": r[0], "passed": bool(r[1]), "detail": r[2], "created_at": r[3]}
                    for r in rows
                ]
            finally:
                con.close()

        return await self._run(_sync)

    async def checks_failing_count(self) -> int:
        """Count enabled checks whose most-recent recorded result has
        ``passed=0`` (used by ``GET /api/foundry/summary``). One query — a
        window function ranks each check's results most-recent-first so we
        never do an N+1 lookup per check."""

        def _sync() -> int:
            con = _connect(self.s)
            try:
                r = con.execute(
                    "SELECT COUNT(*) FROM ("
                    "  SELECT cr.passed, ROW_NUMBER() OVER ("
                    "    PARTITION BY cr.check_id ORDER BY cr.created_at DESC, cr.rowid DESC"
                    "  ) AS rn"
                    "  FROM check_results cr"
                    "  JOIN checks c ON c.id = cr.check_id"
                    "  WHERE c.enabled = 1"
                    ") WHERE rn = 1 AND passed = 0"
                ).fetchone()
                return r[0]
            finally:
                con.close()

        return await self._run(_sync)

    # ---- monitors ---------------------------------------------------------------

    _MONITOR_COLS = (
        "id, dataset_id, name, trigger, condition_expr, action, llm_tier,"
        " llm_system, llm_prompt, severity, enabled, created_at, updated_at"
    )

    def _monitor_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "dataset_id": row[1],
            "name": row[2],
            "trigger": row[3],
            "condition_expr": row[4],
            "action": row[5],
            "llm_tier": row[6],
            "llm_system": row[7],
            "llm_prompt": row[8],
            "severity": row[9],
            "enabled": bool(row[10]),
            "created_at": row[11],
            "updated_at": row[12],
        }

    def _monitor_event_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "monitor_id": row[1],
            "at": row[2],
            "kind": row[3],
            "summary": row[4],
            "detail": json.loads(row[5]) if row[5] else {},
        }

    async def create_monitor(
        self,
        dataset_id: str,
        name: str,
        trigger: str,
        condition_expr: str,
        action: str,
        llm_tier: str,
        llm_system: str,
        llm_prompt: str,
        severity: str,
        enabled: bool = True,
    ) -> dict[str, Any]:
        from app.foundry import monitors as monitors_mod  # noqa: PLC0415

        monitors_mod.validate_monitor(trigger, action, condition_expr, severity)

        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                row = con.execute(
                    "SELECT id FROM datasets WHERE id=?", (dataset_id,)
                ).fetchone()
                if row is None:
                    raise FoundryError(404, "dataset not found")
                mid = new_id("mon")
                now = _now_iso()
                con.execute(
                    "INSERT INTO monitors (id, dataset_id, name, trigger,"
                    " condition_expr, action, llm_tier, llm_system, llm_prompt,"
                    " severity, enabled, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        mid,
                        dataset_id,
                        name,
                        trigger,
                        condition_expr,
                        action,
                        llm_tier,
                        llm_system,
                        llm_prompt,
                        severity,
                        int(enabled),
                        now,
                        now,
                    ),
                )
                con.commit()
                r = con.execute(
                    f"SELECT {self._MONITOR_COLS} FROM monitors WHERE id=?", (mid,)
                ).fetchone()
                return self._monitor_row(r)
            finally:
                con.close()

        return await self._run(_sync)

    async def update_monitor(
        self,
        monitor_id: str,
        name: str,
        trigger: str,
        condition_expr: str,
        action: str,
        llm_tier: str,
        llm_system: str,
        llm_prompt: str,
        severity: str,
        enabled: bool,
    ) -> dict[str, Any] | None:
        from app.foundry import monitors as monitors_mod  # noqa: PLC0415

        monitors_mod.validate_monitor(trigger, action, condition_expr, severity)

        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM monitors WHERE id=?", (monitor_id,)
                ).fetchone()
                if existing is None:
                    return None
                now = _now_iso()
                con.execute(
                    "UPDATE monitors SET name=?, trigger=?, condition_expr=?,"
                    " action=?, llm_tier=?, llm_system=?, llm_prompt=?,"
                    " severity=?, enabled=?, updated_at=? WHERE id=?",
                    (
                        name,
                        trigger,
                        condition_expr,
                        action,
                        llm_tier,
                        llm_system,
                        llm_prompt,
                        severity,
                        int(enabled),
                        now,
                        monitor_id,
                    ),
                )
                con.commit()
                r = con.execute(
                    f"SELECT {self._MONITOR_COLS} FROM monitors WHERE id=?", (monitor_id,)
                ).fetchone()
                return self._monitor_row(r)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_monitor(self, monitor_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM monitors WHERE id=?", (monitor_id,))
                con.execute("DELETE FROM monitor_events WHERE monitor_id=?", (monitor_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def get_monitor(self, monitor_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                r = con.execute(
                    f"SELECT {self._MONITOR_COLS} FROM monitors WHERE id=?", (monitor_id,)
                ).fetchone()
                return self._monitor_row(r) if r else None
            finally:
                con.close()

        return await self._run(_sync)

    async def list_monitors(self, dataset_id: str | None = None) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                if dataset_id:
                    rows = con.execute(
                        f"SELECT {self._MONITOR_COLS} FROM monitors WHERE dataset_id=?"
                        " ORDER BY created_at DESC",
                        (dataset_id,),
                    ).fetchall()
                else:
                    rows = con.execute(
                        f"SELECT {self._MONITOR_COLS} FROM monitors ORDER BY created_at DESC"
                    ).fetchall()
                return [self._monitor_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def record_monitor_event(
        self, monitor_id: str, kind: str, summary: str, detail: dict[str, Any]
    ) -> dict[str, Any]:
        """Insert one event and prune older events beyond the last 200 for
        this monitor — events are a rolling window, not an ever-growing log."""

        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                now = _now_iso()
                cur = con.execute(
                    "INSERT INTO monitor_events (monitor_id, at, kind, summary,"
                    " detail_json) VALUES (?,?,?,?,?)",
                    (monitor_id, now, kind, summary, json.dumps(detail, default=str)),
                )
                eid = cur.lastrowid
                con.execute(
                    "DELETE FROM monitor_events WHERE monitor_id=? AND id NOT IN ("
                    "  SELECT id FROM monitor_events WHERE monitor_id=?"
                    "  ORDER BY id DESC LIMIT 200"
                    ")",
                    (monitor_id, monitor_id),
                )
                con.commit()
                r = con.execute(
                    "SELECT id, monitor_id, at, kind, summary, detail_json"
                    " FROM monitor_events WHERE id=?",
                    (eid,),
                ).fetchone()
                return self._monitor_event_row(r)
            finally:
                con.close()

        return await self._run(_sync)

    async def get_monitor_events(
        self, monitor_id: str, limit: int = 100
    ) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT id, monitor_id, at, kind, summary, detail_json"
                    " FROM monitor_events WHERE monitor_id=? ORDER BY id DESC LIMIT ?",
                    (monitor_id, int(limit)),
                ).fetchall()
                return [self._monitor_event_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def count_monitors(self) -> int:
        def _sync() -> int:
            con = _connect(self.s)
            try:
                return con.execute("SELECT COUNT(*) FROM monitors").fetchone()[0]
            finally:
                con.close()

        return await self._run(_sync)

    async def count_monitor_events_since(self, iso_cutoff: str) -> int:
        def _sync() -> int:
            con = _connect(self.s)
            try:
                r = con.execute(
                    "SELECT COUNT(*) FROM monitor_events WHERE at >= ?", (iso_cutoff,)
                ).fetchone()
                return r[0]
            finally:
                con.close()

        return await self._run(_sync)

    # ---- summary --------------------------------------------------------------

    async def total_rows(self) -> int:
        """Sum of each dataset's latest-version row count — one aggregate
        query instead of a per-dataset round trip."""

        def _sync() -> int:
            con = _connect(self.s)
            try:
                r = con.execute(
                    "SELECT COALESCE(SUM(v.row_count), 0) FROM versions v"
                    " WHERE v.version = ("
                    "   SELECT MAX(v2.version) FROM versions v2"
                    "   WHERE v2.dataset_id = v.dataset_id"
                    " )"
                ).fetchone()
                return r[0]
            finally:
                con.close()

        return await self._run(_sync)

    async def count_transforms(self) -> int:
        def _sync() -> int:
            con = _connect(self.s)
            try:
                return con.execute("SELECT COUNT(*) FROM transforms").fetchone()[0]
            finally:
                con.close()

        return await self._run(_sync)
