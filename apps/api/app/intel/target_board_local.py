"""Local SQLite target-board store — keyless F2T2EA board persistence.

``routes/targets.py`` historically had exactly one backend: Supabase
PostgREST, RLS-scoped by the caller's token. On a keyless boot (no
``SUPABASE_URL``) that store is unreachable, so the board answered 401
(``current_user``) / 503 and the frontend kept everything in memory — losing
the board on reload. Same idiom as ``alert_rules_local.py`` /
``ontology_local.py``: WAL SQLite under ``./data``, a fresh connection per
operation run off the event loop, and an ``override_db_path()`` test hook.
Supabase, when configured, remains the RLS-scoped remote backend.

One table, ``target_board``, mirroring the columns ``routes/targets.py``
reads/writes: id, entity_id, stage, priority, note, requirements (JSON),
classification (banner text), created_at, updated_at — plus the ticket's
classification/compartments/shared columns from migration 0001 are NOT
stored locally (the route never reads them; ``shared``/ticketing is out of
scope for the keyless single-operator spine). Scoped by ``user_id`` (the
shared ``"local"`` identity on a keyless boot).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


def _resolved_db_path(settings: Settings | None = None) -> str:
    if _db_path_override is not None:
        return _db_path_override
    try:
        return (settings or get_settings()).target_board_db_path  # type: ignore[attr-defined]
    except Exception:
        return "./data/target_board.db"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS target_board (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  stage          TEXT NOT NULL DEFAULT 'confirm',
  priority       INTEGER NOT NULL DEFAULT 3,
  note           TEXT NOT NULL DEFAULT '',
  requirements   TEXT NOT NULL DEFAULT '{}',
  classification TEXT NOT NULL DEFAULT 'UNCLAS//FOUO',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_target_board_user_entity
  ON target_board(user_id, entity_id);
CREATE INDEX IF NOT EXISTS ix_target_board_created ON target_board(user_id, created_at DESC);
"""


def _connect(settings: Settings | None = None) -> sqlite3.Connection:
    path = _resolved_db_path(settings)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_SCHEMA)
    con.commit()
    return con


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def _run(fn: Any) -> Any:
    return await asyncio.get_running_loop().run_in_executor(None, fn)


def _row_to_dict(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        rid,
        entity_id,
        stage,
        priority,
        note,
        requirements,
        classification,
        created_at,
        updated_at,
    ) = row
    return {
        "id": rid,
        "entity_id": entity_id,
        "stage": stage,
        "priority": priority,
        "note": note,
        "requirements": json.loads(requirements) if requirements else {},
        "classification": classification,
        "created_at": created_at,
        "updated_at": updated_at,
    }


_COLS = "id, entity_id, stage, priority, note, requirements, classification, created_at, updated_at"


async def list_targets(user_id: str, *, settings: Settings | None = None) -> list[dict[str, Any]]:
    def _sync() -> list[dict[str, Any]]:
        con = _connect(settings)
        try:
            rows = con.execute(
                f"SELECT {_COLS} FROM target_board WHERE user_id=? ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
        finally:
            con.close()
        return [_row_to_dict(r) for r in rows]

    return await _run(_sync)


async def get_target(
    user_id: str, target_id: str, *, settings: Settings | None = None
) -> dict[str, Any] | None:
    def _sync() -> dict[str, Any] | None:
        con = _connect(settings)
        try:
            row = con.execute(
                f"SELECT {_COLS} FROM target_board WHERE user_id=? AND id=?",
                (user_id, target_id),
            ).fetchone()
        finally:
            con.close()
        return _row_to_dict(row) if row else None

    return await _run(_sync)


async def create_target(
    user_id: str, body: dict[str, Any], *, settings: Settings | None = None
) -> dict[str, Any]:
    """Upsert on (user_id, entity_id): re-adding the same entity updates the
    existing row (the same unique(user_id, entity_id) contract the Supabase
    path enforces with merge-duplicates)."""
    now = _now_iso()

    def _sync() -> dict[str, Any]:
        con = _connect(settings)
        try:
            existing = con.execute(
                "SELECT id FROM target_board WHERE user_id=? AND entity_id=?",
                (user_id, body["entity_id"]),
            ).fetchone()
            if existing:
                rid = existing[0]
                con.execute(
                    "UPDATE target_board SET stage=?, priority=?, note=?, requirements=?,"
                    " classification=?, updated_at=? WHERE user_id=? AND id=?",
                    (
                        body.get("stage", "confirm"),
                        int(body.get("priority", 3)),
                        body.get("note", ""),
                        json.dumps(body.get("requirements") or {}),
                        body.get("classification", "UNCLAS//FOUO"),
                        now,
                        user_id,
                        rid,
                    ),
                )
                con.commit()
                row = con.execute(
                    f"SELECT {_COLS} FROM target_board WHERE user_id=? AND id=?", (user_id, rid)
                ).fetchone()
                return _row_to_dict(row)  # type: ignore[arg-type]
            rid = uuid.uuid4().hex[:12]
            con.execute(
                "INSERT INTO target_board (user_id, id, entity_id, stage, priority, note,"
                " requirements, classification, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    user_id,
                    rid,
                    body["entity_id"],
                    body.get("stage", "confirm"),
                    int(body.get("priority", 3)),
                    body.get("note", ""),
                    json.dumps(body.get("requirements") or {}),
                    body.get("classification", "UNCLAS//FOUO"),
                    now,
                    now,
                ),
            )
            con.commit()
            return {
                "id": rid,
                "entity_id": body["entity_id"],
                "stage": body.get("stage", "confirm"),
                "priority": int(body.get("priority", 3)),
                "note": body.get("note", ""),
                "requirements": body.get("requirements") or {},
                "classification": body.get("classification", "UNCLAS//FOUO"),
                "created_at": now,
                "updated_at": now,
            }
        finally:
            con.close()

    return await _run(_sync)


async def update_target(
    user_id: str, target_id: str, patch: dict[str, Any], *, settings: Settings | None = None
) -> dict[str, Any] | None:
    now = _now_iso()

    def _sync() -> dict[str, Any] | None:
        con = _connect(settings)
        try:
            row = con.execute(
                f"SELECT {_COLS} FROM target_board WHERE user_id=? AND id=?", (user_id, target_id)
            ).fetchone()
            if not row:
                return None
            cur = _row_to_dict(row)
            merged = {**cur, **patch, "updated_at": now}
            con.execute(
                "UPDATE target_board SET stage=?, priority=?, note=?, requirements=?,"
                " classification=?, updated_at=? WHERE user_id=? AND id=?",
                (
                    merged["stage"],
                    int(merged["priority"]),
                    merged["note"],
                    json.dumps(merged["requirements"]),
                    merged["classification"],
                    now,
                    user_id,
                    target_id,
                ),
            )
            con.commit()
            updated = con.execute(
                f"SELECT {_COLS} FROM target_board WHERE user_id=? AND id=?", (user_id, target_id)
            ).fetchone()
            return _row_to_dict(updated) if updated else None  # type: ignore[arg-type]
        finally:
            con.close()

    return await _run(_sync)


async def delete_target(user_id: str, target_id: str, *, settings: Settings | None = None) -> bool:
    def _sync() -> bool:
        con = _connect(settings)
        try:
            cur = con.execute(
                "DELETE FROM target_board WHERE user_id=? AND id=?", (user_id, target_id)
            )
            con.commit()
            return cur.rowcount > 0
        finally:
            con.close()

    return await _run(_sync)
