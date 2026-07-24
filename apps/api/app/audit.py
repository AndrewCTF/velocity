"""Immutable audit — append a who/what/when/where row to ``action_log``.

The database makes the table append-only (a ``BEFORE UPDATE/DELETE`` trigger plus
revoked grants — see the gotham-substrate migration). This writes one row per
audited action with the caller's own token: the ``action_log_self_insert`` RLS
policy lets a user record their OWN actions, and they can neither alter nor delete
them afterwards. Best-effort by design — an audit write failure is logged but never
blocks the user's action, so audit can't take the app down — but every mutating
intel route SHOULD call ``audit(...)``.

On a keyless boot (no ``SUPABASE_URL``) there is no ``action_log`` table to write
to, so this used to no-op — a keyless deployment ran investigations, extracts,
country ingests, etc. with no durable record any of it happened. The local
fallback below gives it the same local-SQLite pattern the ontology/alert-rules
stores already use: one append-only table, written only when Supabase isn't
configured. Supabase, when configured, is untouched — same request, same row
shape, same best-effort semantics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import Request

from app.config import get_settings
from app.keys import UserCtx, _client, _headers

log = logging.getLogger("velocity.audit")


def _url() -> str:
    s = get_settings()
    return (s.supabase_url.rstrip("/") + "/rest/v1/action_log") if s.supabase_url else ""


# ── local fallback (keyless: no Supabase configured) ───────────────────────────
#
# Same idiom as intel/ontology_local.py / intel/alert_rules_local.py: WAL
# SQLite under ./data, schema-on-first-use, a fresh connection per write run off
# the event loop, and an ``override_db_path()`` test hook. No Settings field
# (this fix's file ownership is scoped to this module) — the default mirrors the
# other stores' "./data/<name>.db" convention directly.

_LOCAL_DB_PATH_DEFAULT = "./data/audit_log.db"
_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom local-audit DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


def _local_db_path() -> str:
    return _db_path_override or _LOCAL_DB_PATH_DEFAULT


_LOCAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY,
  user_id        TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  target_id      TEXT,
  classification INTEGER NOT NULL DEFAULT 0,
  params         TEXT NOT NULL DEFAULT '{}',
  actor_email    TEXT,
  ip             TEXT,
  user_agent     TEXT,
  ts             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_log_ts ON audit_log(ts DESC);
"""


def _local_connect() -> sqlite3.Connection:
    path = _local_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_LOCAL_SCHEMA)
    con.commit()
    return con


def _write_local_sync(row: dict[str, Any]) -> None:
    con = _local_connect()
    try:
        con.execute(
            "INSERT INTO audit_log (user_id, action, resource_type, target_id,"
            " classification, params, actor_email, ip, user_agent, ts)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                row["user_id"], row["action"], row["resource_type"], row["target_id"],
                int(row["classification"]), json.dumps(row["params"]),
                row["actor_email"], row.get("ip"), row.get("user_agent"),
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            ),
        )
        con.commit()
    finally:
        con.close()


async def _audit_local(row: dict[str, Any]) -> bool:
    try:
        await asyncio.get_running_loop().run_in_executor(None, _write_local_sync, row)
        return True
    except Exception as exc:  # noqa: BLE001 — audit must never break the action
        log.warning("local audit write error: %s", exc)
        return False


async def audit(
    ctx: UserCtx,
    action: str,
    resource_type: str,
    resource_id: str = "",
    *,
    classification: int = 0,
    detail: dict[str, Any] | None = None,
    request: Request | None = None,
    actor_email: str = "",
) -> bool:
    """Append one immutable audit row. Returns True on success, False otherwise.

    Never raises — callers should not have to wrap this; a failed audit is logged.
    """
    s = get_settings()
    row: dict[str, Any] = {
        "user_id": ctx.user_id,
        "action": action,
        "resource_type": resource_type,
        "target_id": resource_id or None,
        "classification": int(classification),
        "params": detail or {},
        "actor_email": actor_email or None,
    }
    if request is not None:
        client = request.client
        row["ip"] = client.host if client else None
        row["user_agent"] = request.headers.get("user-agent")

    url = _url()
    if not url:
        # Keyless boot: no action_log table to write to. Durably record the
        # same row locally instead of silently no-op'ing.
        return await _audit_local(row)

    headers = {**_headers(ctx, s, write=True), "Prefer": "return=minimal"}
    try:
        async with _client() as c:
            r = await c.post(url, json=row, headers=headers)
        if r.status_code in (200, 201, 204):
            return True
        log.warning("audit write rejected: %s %s", r.status_code, (r.text or "")[:200])
        return False
    except Exception as exc:  # noqa: BLE001 — audit must never break the action
        log.warning("audit write error: %s", exc)
        return False
