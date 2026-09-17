"""Local SQLite ``llm_calls`` sink — model-call observability on a keyless box.

``llm._post_call_row`` had exactly one backend: Supabase PostgREST
``llm_calls``. With ``SUPABASE_URL`` unset it returned immediately, so a
deployment that runs entirely local models — the shipping default — kept no
record at all of which model answered what, how long it took, or how many
tokens it burned. "Every model call is audited" was true only for the
deployment that does not need it.

Same idiom as ``intel/action_log_local.py``: WAL SQLite under ``./data``, a
fresh connection per operation run off the event loop's default executor, and
an ``override_db_path()`` test hook. The columns are exactly what
``llm.call_row`` produces plus a server-side ``ts``, so the local row and the
PostgREST row carry the same facts.

Nothing here ever raises into the caller: ``_post_call_row`` is
fire-and-forget telemetry wrapped in its own swallow-everything guard, and an
LLM answer must not fail because its receipt did not land. That is the
opposite of ``action_log_local``'s fail-hard contract, deliberately: an
unaudited *write-back* is dangerous, an unlogged *read* is merely a gap in
metrics.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = "./data/llm_calls.db"

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
CREATE TABLE IF NOT EXISTS llm_calls (
  id                INTEGER PRIMARY KEY,
  ts                TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  backend           TEXT NOT NULL DEFAULT '',
  model_id          TEXT NOT NULL DEFAULT '',
  tier              TEXT NOT NULL DEFAULT '',
  ok                INTEGER NOT NULL DEFAULT 1,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  label             TEXT NOT NULL DEFAULT '',
  error             TEXT
);
CREATE INDEX IF NOT EXISTS ix_llm_calls_ts ON llm_calls(ts DESC);
"""

_COLS = (
    "user_id",
    "backend",
    "model_id",
    "tier",
    "ok",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "latency_ms",
    "tool_calls",
    "label",
    "error",
)


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


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def append(row: dict[str, Any]) -> dict[str, Any]:
    """Persist one ``llm_calls`` row (the shape ``llm.call_row`` produces).

    Returns the stored row (with its ``ts``) so a caller can echo it. Unknown
    keys in ``row`` are ignored rather than rejected: the shaper is allowed to
    grow a field before this sink learns about it, and dropping telemetry is
    better than losing the call it describes.
    """
    stored = {c: row.get(c) for c in _COLS}
    stored["ok"] = 1 if row.get("ok", True) else 0
    stored["ts"] = row.get("ts") or _now_iso()

    def _sync() -> None:
        con = _connect()
        try:
            con.execute(
                "INSERT INTO llm_calls (ts, " + ", ".join(_COLS) + ")"
                " VALUES (" + ", ".join("?" * (len(_COLS) + 1)) + ")",
                (stored["ts"], *(stored[c] for c in _COLS)),
            )
            con.commit()
        finally:
            con.close()

    await _run(_sync)
    return stored


async def list_calls(limit: int = 50) -> list[dict[str, Any]]:
    """Recent model calls, newest first — the read-back behind GET /api/ai/calls."""

    def _sync() -> list[dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT ts, " + ", ".join(_COLS) + " FROM llm_calls"
                " ORDER BY ts DESC, id DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        finally:
            con.close()
        out: list[dict[str, Any]] = []
        for r in rows:
            d: dict[str, Any] = {"ts": r[0]}
            d.update(dict(zip(_COLS, r[1:], strict=True)))
            d["ok"] = bool(d["ok"])
            out.append(d)
        return out

    return await _run(_sync)


async def count() -> int:
    """How many model calls this box has recorded locally."""

    def _sync() -> int:
        con = _connect()
        try:
            return int(con.execute("SELECT COUNT(*) FROM llm_calls").fetchone()[0])
        finally:
            con.close()

    return await _run(_sync)
