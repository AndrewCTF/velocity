"""Workflows SQLite store — workflows, runs, per-workflow memory, schedules.

Same idiom as ``app/foundry/store.py`` (itself mirroring ``app/history.py`` /
``app/intel/ontology_local.py``): a fresh ``sqlite3.connect`` per operation,
WAL journal mode, a module-level ``override_db_path`` hook so tests never
touch the repo's ``data/`` dir, and sync cores run through
``run_in_executor`` from async call sites.

Schema (docs/dashboard-workflows-plan.md section 2, frozen contract for this
wave — do not rename columns/tables without updating that doc):
  workflows(id, name, description, spec_json, enabled, created_at, updated_at)
    spec_json = {"blocks": [{id, type, config}], "edges": [{from, to}]}
  runs(id, workflow_id, status, started_at, finished_at, trigger, log_json,
       error, output_json)
    log_json is an append-only list of "[block_id] type rows_in→rows_out Xms"
    lines; output_json holds each terminal block's row sample (≤200 rows).
  wf_memory(workflow_id, key, value_json, updated_at) — persistent per-
    workflow key/value memory for cross-run state (dedup, baselines).
  schedules(id, workflow_id, interval_s, enabled, last_run, created_at,
    last_error) — run via app/workflows/scheduler.py, mirroring foundry's.
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
_initialized_paths: set[str] = set()


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear.

    Also resets the schema-init cache so a test pointing at a brand-new
    tmp_path always gets ``CREATE TABLE`` run against it, and so test
    isolation never sees another test's "already initialized" path.
    """
    global _db_path_override
    _db_path_override = path
    _initialized_paths.clear()


def _resolved_db_path(settings: Settings | None = None) -> str:
    if _db_path_override is not None:
        return _db_path_override
    return (settings or get_settings()).workflows_db_path


# ── schema ─────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT DEFAULT '',
  spec_json TEXT NOT NULL DEFAULT '{"blocks":[],"edges":[]}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
  status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  log_json TEXT NOT NULL DEFAULT '[]', error TEXT,
  output_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
CREATE TABLE IF NOT EXISTS wf_memory (
  workflow_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(workflow_id, key)
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
  interval_s INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT, created_at TEXT NOT NULL, last_error TEXT
);
"""


def _connect(settings: Settings | None = None) -> sqlite3.Connection:
    path = _resolved_db_path(settings)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    if path not in _initialized_paths:
        con.executescript(_SCHEMA)
        con.commit()
        _initialized_paths.add(path)
    return con


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class WorkflowError(Exception):
    """Raised for store/engine-level failures the route layer maps to HTTP
    errors. Mirrors ``app.foundry.store.FoundryError``."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class WorkflowStore:
    """The Workflows substrate store. One instance is cheap — opens a fresh
    connection per call, exactly like ``FoundryStore``."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.s = settings or get_settings()

    async def _run(self, fn: Any) -> Any:
        return await asyncio.get_running_loop().run_in_executor(None, fn)

    # ---- workflows ------------------------------------------------------------

    def _workflow_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "name": row[1],
            "description": row[2],
            "spec": json.loads(row[3]),
            "enabled": bool(row[4]),
            "created_at": row[5],
            "updated_at": row[6],
        }

    _WORKFLOW_COLS = "id, name, description, spec_json, enabled, created_at, updated_at"

    async def create_workflow(
        self, name: str, description: str, spec: dict[str, Any], enabled: bool = True
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM workflows WHERE name=?", (name,)
                ).fetchone()
                if existing:
                    raise WorkflowError(409, f"workflow {name!r} already exists")
                wid = new_id("wf")
                now = _now_iso()
                con.execute(
                    "INSERT INTO workflows (id, name, description, spec_json,"
                    " enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                    (wid, name, description, json.dumps(spec), int(enabled), now, now),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._WORKFLOW_COLS} FROM workflows WHERE id=?", (wid,)
                ).fetchone()
                return self._workflow_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def list_workflows(self) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    f"SELECT {self._WORKFLOW_COLS} FROM workflows ORDER BY created_at DESC"
                ).fetchall()
                return [self._workflow_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def get_workflow(self, workflow_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    f"SELECT {self._WORKFLOW_COLS} FROM workflows WHERE id=?", (workflow_id,)
                ).fetchone()
                return self._workflow_row(row) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def update_workflow(
        self,
        workflow_id: str,
        name: str,
        description: str,
        spec: dict[str, Any],
        enabled: bool,
    ) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                existing = con.execute(
                    "SELECT id FROM workflows WHERE id=?", (workflow_id,)
                ).fetchone()
                if existing is None:
                    return None
                now = _now_iso()
                con.execute(
                    "UPDATE workflows SET name=?, description=?, spec_json=?,"
                    " enabled=?, updated_at=? WHERE id=?",
                    (name, description, json.dumps(spec), int(enabled), now, workflow_id),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._WORKFLOW_COLS} FROM workflows WHERE id=?", (workflow_id,)
                ).fetchone()
                return self._workflow_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def delete_workflow(self, workflow_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM workflows WHERE id=?", (workflow_id,))
                con.execute("DELETE FROM runs WHERE workflow_id=?", (workflow_id,))
                con.execute("DELETE FROM wf_memory WHERE workflow_id=?", (workflow_id,))
                con.execute("DELETE FROM schedules WHERE workflow_id=?", (workflow_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    # ---- runs -------------------------------------------------------------

    def _run_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "workflow_id": row[1],
            "status": row[2],
            "started_at": row[3],
            "finished_at": row[4],
            "trigger": row[5],
            "log": json.loads(row[6]) if row[6] else [],
            "error": row[7],
            "output": json.loads(row[8]) if row[8] else {},
        }

    _RUN_COLS = (
        "id, workflow_id, status, started_at, finished_at, trigger, log_json,"
        " error, output_json"
    )

    async def create_run(self, workflow_id: str, trigger: str) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                rid = new_id("run")
                now = _now_iso()
                con.execute(
                    "INSERT INTO runs (id, workflow_id, status, started_at,"
                    " trigger, log_json) VALUES (?,?,?,?,?,?)",
                    (rid, workflow_id, "running", now, trigger, "[]"),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._RUN_COLS} FROM runs WHERE id=?", (rid,)
                ).fetchone()
                return self._run_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def finish_run(
        self,
        run_id: str,
        status: str,
        log: list[str],
        error: str | None,
        output: dict[str, Any],
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.execute(
                    "UPDATE runs SET status=?, finished_at=?, log_json=?,"
                    " error=?, output_json=? WHERE id=?",
                    (status, now, json.dumps(log), error, json.dumps(output), run_id),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._RUN_COLS} FROM runs WHERE id=?", (run_id,)
                ).fetchone()
                return self._run_row(row)
            finally:
                con.close()

        return await self._run(_sync)

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        def _sync() -> dict[str, Any] | None:
            con = _connect(self.s)
            try:
                row = con.execute(
                    f"SELECT {self._RUN_COLS} FROM runs WHERE id=?", (run_id,)
                ).fetchone()
                return self._run_row(row) if row else None
            finally:
                con.close()

        return await self._run(_sync)

    async def list_runs(
        self, workflow_id: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                if workflow_id:
                    rows = con.execute(
                        f"SELECT {self._RUN_COLS} FROM runs WHERE workflow_id=?"
                        " ORDER BY started_at DESC LIMIT ?",
                        (workflow_id, int(limit)),
                    ).fetchall()
                else:
                    rows = con.execute(
                        f"SELECT {self._RUN_COLS} FROM runs ORDER BY started_at DESC LIMIT ?",
                        (int(limit),),
                    ).fetchall()
                return [self._run_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    # ---- memory -------------------------------------------------------------

    async def get_memory(self, workflow_id: str) -> dict[str, Any]:
        """All memory keys for a workflow as one dict — loaded once at the
        start of a run."""

        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                rows = con.execute(
                    "SELECT key, value_json FROM wf_memory WHERE workflow_id=?",
                    (workflow_id,),
                ).fetchall()
                return {k: json.loads(v) for k, v in rows}
            finally:
                con.close()

        return await self._run(_sync)

    async def set_memory_all(self, workflow_id: str, memory: dict[str, Any]) -> None:
        """Persist the whole memory dict — called once at run end. A wholesale
        replace (like Foundry's ``objects.props``): keys removed during the
        run are removed from the store too."""

        def _sync() -> None:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.execute("DELETE FROM wf_memory WHERE workflow_id=?", (workflow_id,))
                if memory:
                    con.executemany(
                        "INSERT INTO wf_memory (workflow_id, key, value_json, updated_at)"
                        " VALUES (?,?,?,?)",
                        [
                            (workflow_id, k, json.dumps(v, default=str), now)
                            for k, v in memory.items()
                        ],
                    )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def set_memory_key(self, workflow_id: str, key: str, value: Any) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                now = _now_iso()
                con.execute(
                    "INSERT INTO wf_memory (workflow_id, key, value_json, updated_at)"
                    " VALUES (?,?,?,?)"
                    " ON CONFLICT(workflow_id, key) DO UPDATE SET"
                    " value_json=excluded.value_json, updated_at=excluded.updated_at",
                    (workflow_id, key, json.dumps(value, default=str), now),
                )
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    async def reset_memory(self, workflow_id: str) -> None:
        def _sync() -> None:
            con = _connect(self.s)
            try:
                con.execute("DELETE FROM wf_memory WHERE workflow_id=?", (workflow_id,))
                con.commit()
            finally:
                con.close()

        await self._run(_sync)

    # ---- schedules ----------------------------------------------------------

    _SCHEDULE_COLS = (
        "id, workflow_id, interval_s, enabled, last_run, created_at, last_error"
    )

    def _schedule_row(self, row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": row[0],
            "workflow_id": row[1],
            "interval_s": row[2],
            "enabled": bool(row[3]),
            "last_run": row[4],
            "created_at": row[5],
            "last_error": row[6],
        }

    async def create_schedule(
        self, workflow_id: str, interval_s: int, enabled: bool = True
    ) -> dict[str, Any]:
        def _sync() -> dict[str, Any]:
            con = _connect(self.s)
            try:
                sid = new_id("sch")
                now = _now_iso()
                con.execute(
                    "INSERT INTO schedules (id, workflow_id, interval_s,"
                    " enabled, created_at) VALUES (?,?,?,?,?)",
                    (sid, workflow_id, int(interval_s), int(enabled), now),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE id=?", (sid,)
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
                    f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE id=?", (schedule_id,)
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

    async def list_schedules(self, workflow_id: str | None = None) -> list[dict[str, Any]]:
        def _sync() -> list[dict[str, Any]]:
            con = _connect(self.s)
            try:
                if workflow_id:
                    rows = con.execute(
                        f"SELECT {self._SCHEDULE_COLS} FROM schedules WHERE workflow_id=?"
                        " ORDER BY created_at DESC",
                        (workflow_id,),
                    ).fetchall()
                else:
                    rows = con.execute(
                        f"SELECT {self._SCHEDULE_COLS} FROM schedules ORDER BY created_at DESC"
                    ).fetchall()
                return [self._schedule_row(r) for r in rows]
            finally:
                con.close()

        return await self._run(_sync)

    async def set_schedule_result(
        self, schedule_id: str, *, last_run: str, last_error: str | None
    ) -> None:
        """Record a schedule's outcome. ``last_run`` always advances, success
        or failure — a broken workflow can never hot-loop the poller."""

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
        """Enabled schedules whose ``interval_s`` has elapsed since
        ``last_run`` — mirrors ``FoundryStore.due_schedules`` exactly,
        including the self-repair for a corrupt/unparseable timestamp."""

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
