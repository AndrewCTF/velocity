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
import hashlib
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import Request

from app import schema_version
from app.config import get_settings
from app.keys import UserCtx, _client, _headers
from app.ratelimit import client_key

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
  ts             TEXT NOT NULL,
  prev_hash      TEXT,
  row_hash       TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_log_ts ON audit_log(ts DESC);
"""

#: Bumped by a change that alters the shape of this file (see app/schema_version.py).
SCHEMA_VERSION = 1

# Append-only, like the Supabase action_log (ASVS V16.4.2). These stop an
# accidental or careless UPDATE/DELETE from the app or an operator's sqlite3
# shell; they cannot stop a process that owns the file from dropping them. The
# hash chain below is what makes such an edit visible afterwards.
_TRIGGER_NO_UPDATE = """
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END
"""
_TRIGGER_NO_DELETE = """
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END
"""

# Written by this file: the retention prune, at most once per interval.
_PRUNE_INTERVAL_S = 3600.0
_last_prune = 0.0


def _local_connect() -> sqlite3.Connection:
    path = _local_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_LOCAL_SCHEMA)
    # A log created before the chain existed: add the columns (ALTER is not an
    # UPDATE, so the triggers do not fire). Its old rows stay unchained.
    cols = {r[1] for r in con.execute("PRAGMA table_info(audit_log)")}
    for col in ("prev_hash", "row_hash"):
        if col not in cols:
            con.execute(f"ALTER TABLE audit_log ADD COLUMN {col} TEXT")
    con.execute(_TRIGGER_NO_UPDATE)
    con.execute(_TRIGGER_NO_DELETE)
    schema_version.ensure(con, "audit", SCHEMA_VERSION)
    con.commit()
    return con


_CHAIN_FIELDS = (
    "user_id", "action", "resource_type", "target_id", "classification", "params",
    "actor_email", "ip", "user_agent", "ts",
)


def _row_hash(prev_hash: str, values: tuple[Any, ...]) -> str:
    """SHA-256 over the previous row's hash and this row's stored values."""
    body = json.dumps([prev_hash, *values], separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(body.encode()).hexdigest()


def _write_local_sync(row: dict[str, Any]) -> None:
    global _last_prune
    con = _local_connect()
    try:
        values = (
            row["user_id"], row["action"], row["resource_type"], row["target_id"],
            int(row["classification"]), json.dumps(row["params"]),
            row["actor_email"], row.get("ip"), row.get("user_agent"),
            row.get("ts") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        # IMMEDIATE: two writers must not both chain onto the same previous row.
        con.execute("BEGIN IMMEDIATE")
        last = con.execute("SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
        prev = (last[0] if last else "") or ""
        con.execute(
            "INSERT INTO audit_log (user_id, action, resource_type, target_id,"
            " classification, params, actor_email, ip, user_agent, ts, prev_hash, row_hash)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (*values, prev, _row_hash(prev, values)),
        )
        con.commit()
    finally:
        con.close()
    days = get_settings().audit_retention_days
    now = time.time()
    if days > 0 and now - _last_prune >= _PRUNE_INTERVAL_S:
        _last_prune = now
        prune_local_sync(days)


def verify_local_chain_sync() -> dict[str, Any]:
    """Walk the local chain oldest to newest. Rows written before the chain
    existed are skipped; the oldest chained row anchors it (retention may have
    pruned its predecessor, so its ``prev_hash`` is taken as given). Detects an
    edited or inserted row; cannot detect the oldest rows being cut off, which
    is exactly what a prune does."""
    if not Path(_local_db_path()).exists():
        return {"ok": True, "rows": 0, "first_bad_id": None}
    con = _local_connect()
    try:
        rows = con.execute(
            "SELECT id, " + ", ".join(_CHAIN_FIELDS) + ", prev_hash, row_hash"
            " FROM audit_log ORDER BY id"
        ).fetchall()
    finally:
        con.close()
    expected: str | None = None
    checked = 0
    for r in rows:
        rid, values, prev, stored = r[0], tuple(r[1:11]), r[11], r[12]
        if stored is None and expected is None:
            continue  # legacy, pre-chain row
        if stored is None or (expected is not None and prev != expected):
            return {"ok": False, "rows": checked, "first_bad_id": rid}
        if _row_hash(prev or "", values) != stored:
            return {"ok": False, "rows": checked, "first_bad_id": rid}
        expected = stored
        checked += 1
    return {"ok": True, "rows": checked, "first_bad_id": None}


def prune_local_sync(retention_days: int) -> int:
    """Delete local audit rows older than ``retention_days`` (0 = keep all);
    returns how many (ASVS V14.2.4). The delete trigger is lifted for this one
    transaction only, and the chain stays verifiable from the new oldest row."""
    if retention_days <= 0 or not Path(_local_db_path()).exists():
        return 0
    cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - retention_days * 86_400))
    con = _local_connect()
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("DROP TRIGGER IF EXISTS audit_log_no_delete")
        n = con.execute("DELETE FROM audit_log WHERE ts < ?", (cutoff,)).rowcount
        con.execute(_TRIGGER_NO_DELETE)
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
    if n:
        log.info("audit retention pruned rows=%s older_than_days=%s", n, retention_days)
    return int(n)


def list_local_rows_sync(limit: int) -> list[dict[str, Any]]:
    """Newest local ``audit_log`` rows (mutation attempts, OSINT/extract audits)."""
    if not Path(_local_db_path()).exists():
        return []
    con = _local_connect()
    try:
        rows = con.execute(
            "SELECT user_id, action, resource_type, target_id, classification, params,"
            " ts FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    finally:
        con.close()
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            params = json.loads(r[5])
        except ValueError:
            params = {}
        out.append({
            "user_id": r[0], "action": r[1], "resource_type": r[2],
            "target_id": r[3] or "", "classification": r[4], "params": params,
            "ts": r[6], "store": "audit_log",
        })
    return out


async def list_local_rows(limit: int) -> list[dict[str, Any]]:
    return await asyncio.get_running_loop().run_in_executor(None, list_local_rows_sync, limit)


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
        # The client as the rate limiter and security log see it (XFF believed
        # only from TRUSTED_PROXIES), not the proxy's address (ASVS V15.3.4).
        row["ip"] = client_key(client.host if client else "", request.headers)
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


# ── mutation audit (G15) ─────────────────────────────────────────────────────
#
# One seam instead of a hand-written call per handler: state-changing routers
# carry ``dependencies=[Depends(audit_mutation)]`` and every POST/PUT/PATCH/
# DELETE on them records "who attempted what, on which resource" BEFORE the
# handler runs. It records the attempt, not the outcome. The write is scheduled
# as a background task so a slow or dead audit store can never add latency to,
# or fail, the action itself. ``tests/test_audit_mutations.py`` walks the
# routers and fails if a mutating route lacks the dependency.

_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_pending: set[asyncio.Task[Any]] = set()


def audit_background(ctx: UserCtx, action: str, resource_type: str, resource_id: str = "",
                     **kw: Any) -> None:
    """Fire-and-forget ``audit()``. Never raises, never awaits the store."""
    async def _run() -> None:
        try:
            await audit(ctx, action, resource_type, resource_id, **kw)
        except Exception as exc:  # noqa: BLE001 — audit must never break the action
            log.warning("audit task error: %s", exc)

    try:
        task = asyncio.get_running_loop().create_task(_run())
    except RuntimeError:  # no running loop — nothing to schedule on
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


def _actor(request: Request) -> UserCtx:
    """Identity for the row without re-validating: a bearer token counts only if
    the auth layer already validated it (it is in the per-token cache); a static
    key holder is ``api-key``; an ingest sender is ``ingest``; else ``local``.
    The ingest token is never read here."""
    from app.auth import (  # noqa: PLC0415
        _bearer,
        _internal_ok_until,
        _jwt_claims,
        _token_ok_until,
    )

    token = _bearer(request.headers) or ""
    if token and token in _internal_ok_until:
        return UserCtx(user_id="mcp-internal", token="")
    if token and token in _token_ok_until:
        sub = (_jwt_claims(token) or {}).get("sub")
        if sub:
            return UserCtx(user_id=str(sub), token=token)
    if request.url.path.startswith("/api/ingest/"):
        return UserCtx(user_id="ingest", token="")
    if request.headers.get("x-api-key"):
        return UserCtx(user_id="api-key", token="")
    return UserCtx(user_id="local", token="")


async def audit_mutation(request: Request) -> None:
    """Router dependency: audit every mutating request (see block comment)."""
    if request.method not in _MUTATING:
        return
    route = request.scope.get("route")
    template = getattr(route, "path", request.url.path)
    tags = getattr(route, "tags", None) or ["api"]
    params = {k: str(v) for k, v in request.path_params.items()}
    audit_background(
        _actor(request),
        f"{request.method} {template}",
        str(tags[0]),
        "/".join(params.values()),
        detail={"path_params": params} if params else None,
        request=request,
    )
