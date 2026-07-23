"""Local SQLite history sink for news editions/analysis/briefs (Track A3).

``app/news/store.py`` only ever holds the LATEST edition/analysis in process
memory — a restart or a redeploy loses it, and there is no way to look back at
what the wall said an hour ago. This module gives the news engine the same
keyless, zero-config persistence idiom the rest of the platform already uses
for local-first stores: WAL SQLite under ``./data``, a fresh connection per
operation run off the event loop's default executor, and an
``override_db_path()`` test hook. Cloned from
``app/intel/action_log_local.py`` (see that module's docstring for the
ontology-local-first-store background, docs/decisions.md#ontology-local-first-store-2026-07-07).

Three kinds of snapshot share one table, distinguished by ``kind``:
``edition`` (the public news wall), ``analysis`` (the debias agent output),
``brief`` (the assembled synthesis in :mod:`app.news.brief`). Each kind is
independently pruned to its newest 200 rows so one chatty kind can never push
another out.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = "./data/news_history.db"

_VALID_KINDS = frozenset({"edition", "analysis", "brief"})

_MAX_ROWS_PER_KIND = 200

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
CREATE TABLE IF NOT EXISTS news_editions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  created_utc TEXT NOT NULL,
  payload TEXT NOT NULL,
  article_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_news_editions_kind_ts ON news_editions(kind, created_utc DESC);
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


def _check_kind(kind: str) -> None:
    if kind not in _VALID_KINDS:
        raise ValueError(
            f"invalid news history kind: {kind!r} (expected one of {sorted(_VALID_KINDS)})"
        )


def _row_to_dict(r: tuple) -> dict[str, Any]:
    return {
        "id": r[0],
        "kind": r[1],
        "created_utc": r[2],
        "payload": json.loads(r[3]),
        "article_count": r[4],
        "verified_count": r[5],
    }


async def append_snapshot(
    kind: str,
    payload: dict[str, Any],
    *,
    article_count: int = 0,
    verified_count: int = 0,
) -> int:
    """Persist one snapshot and prune ``kind`` to its newest 200 rows.

    Returns the new row's id.
    """
    _check_kind(kind)
    created_utc = datetime.now(UTC).isoformat()
    payload_json = json.dumps(payload)

    def _sync() -> int:
        con = _connect()
        try:
            cur = con.execute(
                "INSERT INTO news_editions"
                " (kind, created_utc, payload, article_count, verified_count)"
                " VALUES (?,?,?,?,?)",
                (kind, created_utc, payload_json, int(article_count), int(verified_count)),
            )
            new_id = int(cur.lastrowid)
            con.execute(
                "DELETE FROM news_editions WHERE kind = ? AND id NOT IN ("
                "  SELECT id FROM news_editions WHERE kind = ?"
                "  ORDER BY id DESC LIMIT ?"
                ")",
                (kind, kind, _MAX_ROWS_PER_KIND),
            )
            con.commit()
            return new_id
        finally:
            con.close()

    return await _run(_sync)


async def list_snapshots(kind: str, limit: int = 20) -> list[dict[str, Any]]:
    """Recent snapshots of ``kind``, newest first."""
    _check_kind(kind)

    def _sync() -> list[dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT id, kind, created_utc, payload, article_count, verified_count"
                " FROM news_editions WHERE kind = ? ORDER BY id DESC LIMIT ?",
                (kind, int(limit)),
            ).fetchall()
        finally:
            con.close()
        return [_row_to_dict(r) for r in rows]

    return await _run(_sync)


async def latest(kind: str) -> dict[str, Any] | None:
    """Most recent snapshot of ``kind``, or ``None`` if there is none yet."""
    rows = await list_snapshots(kind, limit=1)
    return rows[0] if rows else None
