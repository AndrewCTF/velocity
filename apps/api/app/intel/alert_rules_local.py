"""Local SQLite alert-rules store — keyless standing-watch persistence (W3).

``routes/alert_rules.py`` historically had exactly one backend: Supabase
PostgREST, RLS-scoped by the caller's token. On a keyless boot (no
``SUPABASE_URL``) that store is unreachable, so ``intel/watch.py``'s
``_list_enabled_rules`` returned ``[]`` unconditionally — a watch rule an
operator defines never fires without signing in to a cloud project. That
contradicts the platform's keyless-first identity (same one that already
moved the ontology to a local SQLite spine — see
``intel/ontology_local.py`` and ``docs/decisions.md``).

This module gives alert rules the same local spine, using the exact
``history.py`` / ``ontology_local.py`` idiom: WAL SQLite under ``./data``, a
fresh connection per operation run off the event loop in the default
executor, and an ``override_db_path()`` test hook. Supabase, when
configured, remains the RLS-scoped remote backend for signed-in multi-tenant
deployments — this store is additive, selected by callers only when
``settings.supabase_url`` is unset (the same predicate ``watch.py`` already
used to detect "keyless").

Two tables:
  * ``alert_rules`` — the rule itself (AOI, kinds, severity floor, delivery
    channel + sink URL). Scoped by ``user_id`` (the shared ``"local"``
    identity on a keyless boot, same single-operator posture as
    ``ontology_local``).
  * ``alert_deliveries`` — an append-only log of every sink-delivery
    attempt (Discord / generic webhook), so "did my alert actually reach my
    phone" is answerable without a browser open — the log IS the proof.
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

# ── DB path injection (for tests) ─────────────────────────────────────────────

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


def _resolved_db_path(settings: Settings | None = None) -> str:
    if _db_path_override is not None:
        return _db_path_override
    return (settings or get_settings()).alert_rules_db_path


# ── connection / schema ───────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS alert_rules (
  user_id      TEXT NOT NULL,
  id           TEXT NOT NULL,
  label        TEXT NOT NULL,
  lat          REAL,
  lon          REAL,
  radius_nm    REAL DEFAULT 50,
  kinds        TEXT NOT NULL DEFAULT '[]',
  min_severity INTEGER NOT NULL DEFAULT 1,
  channel      TEXT NOT NULL DEFAULT 'inapp',
  sink_url     TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  icao24       TEXT,
  mmsi         TEXT,
  callsign     TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS ix_alert_rules_enabled ON alert_rules(user_id, enabled);
CREATE TABLE IF NOT EXISTS alert_deliveries (
  id         INTEGER PRIMARY KEY,
  rule_id    TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  transition TEXT NOT NULL,
  channel    TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  ok         INTEGER NOT NULL DEFAULT 0,
  status     INTEGER,
  error      TEXT,
  message    TEXT NOT NULL DEFAULT '',
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_deliveries_ts ON alert_deliveries(ts DESC);
"""


# Identity columns added after the original table shipped (per-identity watch
# rules); a pre-existing ``alert_rules.db`` on an operator's box needs an
# explicit ALTER TABLE — ``CREATE TABLE IF NOT EXISTS`` above is a no-op once the
# table already exists, so it never adds a column to an old file.
_IDENTITY_COLUMNS = ("icao24", "mmsi", "callsign")


def _migrate(con: sqlite3.Connection) -> None:
    have = {row[1] for row in con.execute("PRAGMA table_info(alert_rules)").fetchall()}
    for col in _IDENTITY_COLUMNS:
        if col not in have:
            con.execute(f"ALTER TABLE alert_rules ADD COLUMN {col} TEXT")
    _relax_aoi_not_null(con)


# An identity-only rule (P6.1: icao24/mmsi/callsign with no AOI) persists NULL
# lat/lon/radius_nm — a DB file created before that has a NOT NULL constraint
# on those columns that a plain ALTER TABLE ADD COLUMN can't lift (SQLite has
# no ALTER COLUMN). Rebuild the table instead: rename it aside, let ``_SCHEMA``
# recreate the (already-nullable) definition, copy every row across by name,
# drop the old one. The identity-column migration above must run FIRST so the
# renamed-aside copy already has icao24/mmsi/callsign for the column list to
# select. Runs at most once per DB file: after it, ``lat``'s notnull flag is 0,
# so the next boot's check is a single PRAGMA read.
_ALERT_RULE_COLUMNS = (
    "user_id, id, label, lat, lon, radius_nm, kinds, min_severity, channel,"
    " sink_url, enabled, created_at, icao24, mmsi, callsign"
)


def _relax_aoi_not_null(con: sqlite3.Connection) -> None:
    info = con.execute("PRAGMA table_info(alert_rules)").fetchall()
    lat_notnull = next((row[3] for row in info if row[1] == "lat"), 0)
    if not lat_notnull:
        return
    con.execute("ALTER TABLE alert_rules RENAME TO alert_rules_old")
    con.executescript(_SCHEMA)
    con.execute(
        f"INSERT INTO alert_rules ({_ALERT_RULE_COLUMNS})"
        f" SELECT {_ALERT_RULE_COLUMNS} FROM alert_rules_old"
    )
    con.execute("DROP TABLE alert_rules_old")


def _connect(settings: Settings | None = None) -> sqlite3.Connection:
    path = _resolved_db_path(settings)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_SCHEMA)
    _migrate(con)
    con.commit()
    return con


# Retention: ``alert_deliveries`` is append-only and was never pruned
# (unbounded ``alert_rules.db`` growth once rules fire regularly). Keep only the
# newest N attempts — the log is a "did it reach my phone" proof, not an archive.
DELIVERIES_KEEP = 5000


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


async def _run(fn: Any) -> Any:
    return await asyncio.get_running_loop().run_in_executor(None, fn)


def _row_to_rule(row: tuple[Any, ...]) -> dict[str, Any]:
    (
        rid, label, lat, lon, radius_nm, kinds, min_severity, channel,
        sink_url, enabled, created_at, icao24, mmsi, callsign,
    ) = row
    return {
        "id": rid,
        "label": label,
        "lat": lat,
        "lon": lon,
        "radius_nm": radius_nm,
        "kinds": json.loads(kinds) if kinds else [],
        "min_severity": min_severity,
        "channel": channel,
        "sink_url": sink_url,
        "enabled": bool(enabled),
        "created_at": created_at,
        "icao24": icao24,
        "mmsi": mmsi,
        "callsign": callsign,
    }


# ── rules CRUD ─────────────────────────────────────────────────────────────────


async def list_rules(
    user_id: str, *, enabled_only: bool = False, settings: Settings | None = None
) -> list[dict[str, Any]]:
    """All rules for ``user_id`` (newest first). ``enabled_only`` is what the
    watch evaluator wants; the CRUD route wants everything."""

    def _sync() -> list[dict[str, Any]]:
        con = _connect(settings)
        try:
            q = (
                "SELECT id, label, lat, lon, radius_nm, kinds, min_severity,"
                " channel, sink_url, enabled, created_at, icao24, mmsi,"
                " callsign FROM alert_rules WHERE user_id=?"
            )
            params: list[Any] = [user_id]
            if enabled_only:
                q += " AND enabled=1"
            q += " ORDER BY created_at DESC"
            rows = con.execute(q, params).fetchall()
        finally:
            con.close()
        return [_row_to_rule(r) for r in rows]

    return await _run(_sync)


async def create_rule(
    user_id: str, body: dict[str, Any], *, settings: Settings | None = None
) -> dict[str, Any]:
    rid = uuid.uuid4().hex[:12]
    created_at = _now_iso()
    kinds = list(body.get("kinds") or [])
    row = {
        "id": rid,
        "label": body["label"],
        # An identity-only rule (icao24/mmsi/callsign, no AOI — AlertRuleIn's
        # model validator guarantees one or the other) carries None here; keep
        # it None rather than crashing on float(None) or fabricating a 0/50
        # geofence the evaluator was never told to enforce.
        "lat": float(body["lat"]) if body.get("lat") is not None else None,
        "lon": float(body["lon"]) if body.get("lon") is not None else None,
        "radius_nm": (
            float(body["radius_nm"]) if body.get("radius_nm") is not None else None
        ),
        "kinds": kinds,
        "min_severity": int(body.get("min_severity", 1)),
        "channel": body.get("channel") or "inapp",
        "sink_url": body.get("sink_url"),
        "enabled": bool(body.get("enabled", True)),
        "created_at": created_at,
        "icao24": body.get("icao24"),
        "mmsi": body.get("mmsi"),
        "callsign": body.get("callsign"),
    }

    def _sync() -> None:
        con = _connect(settings)
        try:
            con.execute(
                "INSERT INTO alert_rules (user_id, id, label, lat, lon,"
                " radius_nm, kinds, min_severity, channel, sink_url, enabled,"
                " created_at, icao24, mmsi, callsign)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    user_id, row["id"], row["label"], row["lat"], row["lon"],
                    row["radius_nm"], json.dumps(kinds), row["min_severity"],
                    row["channel"], row["sink_url"], int(row["enabled"]),
                    created_at, row["icao24"], row["mmsi"], row["callsign"],
                ),
            )
            con.commit()
        finally:
            con.close()

    await _run(_sync)
    return row


async def delete_rule(
    user_id: str, rule_id: str, *, settings: Settings | None = None
) -> bool:
    def _sync() -> bool:
        con = _connect(settings)
        try:
            cur = con.execute(
                "DELETE FROM alert_rules WHERE user_id=? AND id=?",
                (user_id, rule_id),
            )
            con.commit()
            return cur.rowcount > 0
        finally:
            con.close()

    return await _run(_sync)


# ── delivery log (append-only proof the sink push happened) ────────────────────


async def record_delivery(
    *,
    rule_id: str,
    entity_id: str,
    transition: str,
    channel: str,
    target: str,
    ok: bool,
    status: int | None,
    error: str | None,
    message: str,
    settings: Settings | None = None,
) -> None:
    ts = _now_iso()

    def _sync() -> None:
        con = _connect(settings)
        try:
            con.execute(
                "INSERT INTO alert_deliveries (rule_id, entity_id, transition,"
                " channel, target, ok, status, error, message, ts)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    rule_id, entity_id, transition, channel, target,
                    int(ok), status, error, message, ts,
                ),
            )
            # Bound the append-only log: drop everything older than the newest
            # DELIVERIES_KEEP rows (id is a monotonic rowid, so this is exact).
            con.execute(
                "DELETE FROM alert_deliveries WHERE id <= "
                "(SELECT MAX(id) FROM alert_deliveries) - ?",
                (DELIVERIES_KEEP,),
            )
            con.commit()
        finally:
            con.close()

    await _run(_sync)


async def recent_deliveries(
    limit: int = 50, *, settings: Settings | None = None
) -> list[dict[str, Any]]:
    def _sync() -> list[dict[str, Any]]:
        con = _connect(settings)
        try:
            rows = con.execute(
                "SELECT rule_id, entity_id, transition, channel, target, ok,"
                " status, error, message, ts FROM alert_deliveries"
                " ORDER BY id DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        finally:
            con.close()
        return [
            {
                "rule_id": r[0],
                "entity_id": r[1],
                "transition": r[2],
                "channel": r[3],
                "target": r[4],
                "ok": bool(r[5]),
                "status": r[6],
                "error": r[7],
                "message": r[8],
                "ts": r[9],
            }
            for r in rows
        ]

    return await _run(_sync)
