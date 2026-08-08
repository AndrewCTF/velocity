"""Local SQLite store for the human-in-the-loop action queue.

A proposal is a governed write-back the agent wants to make and is waiting for
an operator to approve. It used to live in a module-level dict, which meant a
backend restart silently emptied the approval queue: the operator saw pending
work, the process bounced, and the work was gone with no record that it had
existed. "The agent re-proposes on its next run" was the stated defence, and it
only holds if the agent runs again — an operator who left three proposals open
overnight came back to none.

Same idiom as ``action_log_local.py`` beside it: WAL SQLite under ``./data``, a
fresh connection per operation off the default executor, an
``override_db_path()`` test hook, and no ``Settings`` entry for a path nobody
has asked to relocate.

Expiry is unchanged and is enforced on read as well as on write, so a proposal
that aged out while the process was down is never handed back as pending.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = "./data/action_proposals.db"

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
CREATE TABLE IF NOT EXISTS action_proposals (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.0,
  created    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_action_proposals_created
  ON action_proposals(created);
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


def _row(r: tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": r[0],
        "name": r[1],
        "params": json.loads(r[2]),
        "confidence": r[3],
        "created": r[4],
    }


async def add(
    name: str, params: dict[str, Any], confidence: float, ttl_s: float
) -> str:
    """Queue a proposal and return its id, pruning anything already expired."""
    pid = uuid.uuid4().hex[:12]
    now = time.time()

    def _sync() -> None:
        con = _connect()
        try:
            con.execute(
                "DELETE FROM action_proposals WHERE created < ?", (now - ttl_s,)
            )
            con.execute(
                "INSERT INTO action_proposals (id, name, params, confidence, created)"
                " VALUES (?,?,?,?,?)",
                (pid, name, json.dumps(params), float(confidence), now),
            )
            con.commit()
        finally:
            con.close()

    await _run(_sync)
    return pid


async def list_pending(ttl_s: float) -> list[dict[str, Any]]:
    """Unexpired proposals, oldest first.

    Filters by age in the query rather than trusting a prune to have run: after
    a restart nothing has pruned yet, and a proposal that expired while the
    process was down must not come back looking live.
    """

    def _sync() -> list[dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT id, name, params, confidence, created FROM action_proposals"
                " WHERE created >= ? ORDER BY created ASC",
                (time.time() - ttl_s,),
            ).fetchall()
        finally:
            con.close()
        return [_row(r) for r in rows]

    return await _run(_sync)


async def take(pid: str, ttl_s: float) -> dict[str, Any] | None:
    """Remove and return one unexpired proposal, or None.

    Delete-then-read in one connection so two approvals of the same proposal
    cannot both execute it.
    """

    def _sync() -> dict[str, Any] | None:
        con = _connect()
        try:
            row = con.execute(
                "SELECT id, name, params, confidence, created FROM action_proposals"
                " WHERE id=? AND created >= ?",
                (pid, time.time() - ttl_s),
            ).fetchone()
            if row is None:
                # Still clear an expired row of the same id so the table does
                # not keep one nobody can act on.
                con.execute("DELETE FROM action_proposals WHERE id=?", (pid,))
                con.commit()
                return None
            con.execute("DELETE FROM action_proposals WHERE id=?", (pid,))
            con.commit()
            return _row(row)
        finally:
            con.close()

    return await _run(_sync)


async def prune(ttl_s: float) -> int:
    """Drop expired rows; returns how many went."""

    def _sync() -> int:
        con = _connect()
        try:
            cur = con.execute(
                "DELETE FROM action_proposals WHERE created < ?",
                (time.time() - ttl_s,),
            )
            con.commit()
            return cur.rowcount or 0
        finally:
            con.close()

    return await _run(_sync)
