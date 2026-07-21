"""Local SQLite ``action_log`` sink — keyless audit persistence for governed
write-backs (Track C1, deferred "Phase-4" item named in
``docs/decisions.md#ontology-local-first-store-2026-07-07``).

``intel/actions.py``'s ``_append_audit`` historically had exactly one
backend: Supabase PostgREST ``action_log``. On a keyless boot (no
``SUPABASE_URL``) that table doesn't exist — the Supabase ontology backend
was deleted 2026-07-07 — so every governed action 502'd on its final step.
The fail-hard contract ("an unaudited action must not silently succeed") only
makes sense if a keyless deployment has a sink to succeed INTO, which is what
this module gives it.

Same idiom as ``ontology_local.py`` / ``alert_rules_local.py``: WAL SQLite
under ``./data``, a fresh connection per operation run off the event loop's
default executor, and an ``override_db_path()`` test hook. Unlike those two
this module does not read its path from ``Settings`` — it is a single-table,
single-purpose sink, so a hardcoded default keeps it self-contained rather
than reaching into the shared config module for a value nobody has asked to
relocate (ponytail: no config for a value that never changes). Add
``action_log_db_path`` to ``Settings`` if a deployment ever needs to move it.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = "./data/action_log.db"

# ── DB path injection (for tests) ─────────────────────────────────────────────

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


def _resolved_db_path() -> str:
    return _db_path_override or _DEFAULT_DB_PATH


# ── connection / schema ───────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS action_log (
  id        INTEGER PRIMARY KEY,
  user_id   TEXT NOT NULL,
  action    TEXT NOT NULL,
  target_id TEXT NOT NULL,
  params    TEXT NOT NULL DEFAULT '{}',
  ts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_action_log_ts ON action_log(ts DESC);
"""


def _connect() -> sqlite3.Connection:
    path = _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_SCHEMA)
    con.commit()
    return con


async def _run(fn: Any) -> Any:
    return await asyncio.get_running_loop().run_in_executor(None, fn)


async def append_row(row: dict[str, Any]) -> dict[str, Any]:
    """Persist one ``action_log`` row (the exact shape ``actions.audit_row``
    produces) and return it unchanged, so the caller echoes the same receipt
    the Supabase-backed path would.

    Raises on failure (a bad ``sqlite3`` write propagates as-is) — the
    fail-hard contract this sink exists to preserve: a swallowed error here
    would let an unaudited action silently "succeed".
    """

    def _sync() -> None:
        con = _connect()
        try:
            con.execute(
                "INSERT INTO action_log (user_id, action, target_id, params, ts)"
                " VALUES (?,?,?,?,?)",
                (
                    row["user_id"],
                    row["action"],
                    row["target_id"],
                    json.dumps(row["params"]),
                    row["ts"],
                ),
            )
            con.commit()
        finally:
            con.close()

    await _run(_sync)
    return row


async def list_rows(limit: int = 100) -> list[dict[str, Any]]:
    """Recent audit rows, newest first — the read-back proof a governed
    action actually landed (tests / a future keyless ``/api/audit``)."""

    def _sync() -> list[dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT user_id, action, target_id, params, ts FROM action_log"
                " ORDER BY ts DESC, id DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        finally:
            con.close()
        return [
            {
                "user_id": r[0],
                "action": r[1],
                "target_id": r[2],
                "params": json.loads(r[3]),
                "ts": r[4],
            }
            for r in rows
        ]

    return await _run(_sync)
