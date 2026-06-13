"""Historical position store — SQLite-backed, async-safe.

Buffers aircraft + vessel position fixes in memory and flushes them to SQLite
on a background task every ~3 s so the hot 1 s ADS-B tick is never blocked.

Schema
------
    positions(kind TEXT, id TEXT, t REAL, lon REAL, lat REAL, track REAL, extra TEXT)
    INDEX on (id, t) — fast per-id range scans
    INDEX on (t)     — fast global time-range scans + prune
"""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any

from app.config import get_settings

log = logging.getLogger(__name__)

# ── tunable constants ──────────────────────────────────────────────────────────
_FLUSH_INTERVAL_S: float = 3.0       # background flush cadence
_RATE_LIMIT_SECS: float = 5.0        # minimum gap between writes for same id
_RATE_LIMIT_DEG: float = 0.01        # OR ~1 km movement triggers immediate write
_MAX_BUFFERED_IDS: int = 60_000      # FIFO-evict beyond this to keep RAM bounded
_PRUNE_INTERVAL_S: float = 3600.0    # enforce retention at most once per hour

# ── module-level state ─────────────────────────────────────────────────────────
# _buffer: ordered list of rows pending flush
# _last: per-id last-buffered (t, lon, lat)  used for rate-limiting
_buffer: list[tuple[str, str, float, float, float, float, str]] = []
_last: collections.OrderedDict[str, tuple[float, float, float]] = collections.OrderedDict()
_rows_written: int = 0
_flush_task: asyncio.Task[None] | None = None
_db_path: str | None = None          # resolved at start(); overridable in tests
_db_path_override: str | None = None  # set by tests via override_db_path()


# ── DB path injection (for tests) ─────────────────────────────────────────────

def override_db_path(path: str | None) -> None:
    """Set a custom DB path (call before start()). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


# ── internal helpers ──────────────────────────────────────────────────────────

def _resolved_db_path() -> str:
    if _db_path_override is not None:
        return _db_path_override
    return get_settings().history_db_path


def _connect() -> sqlite3.Connection:
    path = _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS positions (
            kind  TEXT    NOT NULL,
            id    TEXT    NOT NULL,
            t     REAL    NOT NULL,
            lon   REAL    NOT NULL,
            lat   REAL    NOT NULL,
            track REAL    NOT NULL,
            extra TEXT    NOT NULL DEFAULT '{}'
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_id_t  ON positions (id, t)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_t     ON positions (t)")
    con.commit()
    return con


def _buffer_point(
    kind: str,
    entity_id: str,
    t: float,
    lon: float,
    lat: float,
    track: float,
    extra: dict[str, Any],
) -> None:
    """Append a point to the in-memory buffer if it passes the rate limit."""
    global _buffer, _last

    prev = _last.get(entity_id)
    if prev is not None:
        prev_t, prev_lon, prev_lat = prev
        dt = t - prev_t
        dlat = abs(lat - prev_lat)
        dlon = abs(lon - prev_lon)
        if dt < _RATE_LIMIT_SECS and dlat < _RATE_LIMIT_DEG and dlon < _RATE_LIMIT_DEG:
            return  # rate-limited: too recent + didn't move enough

    # FIFO-evict oldest id if we've hit the cap
    if len(_last) >= _MAX_BUFFERED_IDS and entity_id not in _last:
        _last.popitem(last=False)

    _last[entity_id] = (t, lon, lat)
    _buffer.append((kind, entity_id, t, lon, lat, track, json.dumps(extra)))


# ── public ingest API ─────────────────────────────────────────────────────────

def ingest_aircraft(features: list[dict[str, Any]]) -> None:
    """Buffer aircraft fixes from a GeoJSON FeatureCollection's features list."""
    now = time.time()
    for feat in features:
        try:
            coords: list[float] = feat["geometry"]["coordinates"]
            lon, lat = coords[0], coords[1]
            props: dict[str, Any] = feat.get("properties") or {}
            icao24: str = props.get("icao24") or props.get("id", "")
            if not icao24:
                continue
            entity_id = f"aircraft:{icao24}"
            track = float(props.get("track_deg") or 0.0)
            extra = {
                k: props.get(k)
                for k in ("callsign", "baro_alt_m", "squawk", "category")
                if props.get(k) is not None
            }
            t = float(props.get("timestamp") or now)
            _buffer_point("aircraft", entity_id, t, lon, lat, track, extra)
        except Exception:  # noqa: BLE001
            continue


def ingest_vessels(rows: list[dict[str, Any]]) -> None:
    """Buffer vessel fixes from dicts like {"id":"vessel:<mmsi>","lon":...}."""
    now = time.time()
    for row in rows:
        try:
            entity_id: str = row.get("id", "")
            if not entity_id:
                mmsi = row.get("mmsi", "")
                entity_id = f"vessel:{mmsi}" if mmsi else ""
            if not entity_id:
                continue
            lon = float(row["lon"])
            lat = float(row["lat"])
            track = float(row.get("cog") or row.get("heading") or 0.0)
            extra = {
                k: row.get(k)
                for k in ("name", "ship_type", "status", "speed")
                if row.get(k) is not None
            }
            t = float(row.get("timestamp") or now)
            _buffer_point("vessel", entity_id, t, lon, lat, track, extra)
        except Exception:  # noqa: BLE001
            continue


# ── flush (runs in executor so it doesn't block the event loop) ───────────────

def _flush_sync(rows: list[tuple[str, str, float, float, float, float, str]]) -> int:
    """Write *rows* to SQLite synchronously. Called via run_in_executor."""
    if not rows:
        return 0
    try:
        con = _connect()
        con.executemany(
            "INSERT INTO positions (kind, id, t, lon, lat, track, extra) VALUES (?,?,?,?,?,?,?)",
            rows,
        )
        con.commit()
        con.close()
        return len(rows)
    except Exception:  # noqa: BLE001
        log.exception("history: flush error")
        return 0


async def _flush_loop() -> None:
    """Background task: drain the buffer to SQLite every _FLUSH_INTERVAL_S and
    enforce retention (prune) at most once per _PRUNE_INTERVAL_S."""
    global _buffer, _rows_written
    next_prune = time.time() + _PRUNE_INTERVAL_S
    while True:
        await asyncio.sleep(_FLUSH_INTERVAL_S)
        loop = asyncio.get_running_loop()
        if _buffer:
            rows, _buffer = _buffer, []
            _rows_written += await loop.run_in_executor(None, _flush_sync, rows)
        # Retention: delete rows past the window so history.db stays bounded.
        if time.time() >= next_prune:
            next_prune = time.time() + _PRUNE_INTERVAL_S
            hours = get_settings().history_retention_hours
            deleted = await loop.run_in_executor(None, prune, hours)
            if deleted:
                log.info("history: pruned %d rows older than %dh", deleted, hours)


# ── query ─────────────────────────────────────────────────────────────────────

def _query_sync(
    kind: str | None,
    bbox: tuple[float, float, float, float] | None,
    t_from: float,
    t_to: float,
    limit_ids: int,
    max_points_per_id: int,
) -> dict[str, Any]:
    """Execute a SQLite range query. Called via run_in_executor."""
    try:
        con = _connect()
        params: list[Any] = [t_from, t_to]
        where = "t >= ? AND t <= ?"
        if kind:
            where += " AND kind = ?"
            params.append(kind)
        if bbox:
            min_lon, min_lat, max_lon, max_lat = bbox
            where += " AND lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?"
            params.extend([min_lon, max_lon, min_lat, max_lat])

        # Fetch all matching rows ordered so we can group by id
        rows = con.execute(
            f"SELECT kind, id, t, lon, lat, track FROM positions WHERE {where} ORDER BY id, t",
            params,
        ).fetchall()
        con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: query error")
        return {"tracks": []}

    # Group into per-id tracks, enforce id + point caps
    tracks: dict[str, dict[str, Any]] = {}
    id_order: list[str] = []
    for row_kind, row_id, t, lon, lat, track in rows:
        if row_id not in tracks:
            if len(tracks) >= limit_ids:
                continue
            tracks[row_id] = {"id": row_id, "kind": row_kind, "points": []}
            id_order.append(row_id)
        pts: list[list[float]] = tracks[row_id]["points"]
        if len(pts) < max_points_per_id:
            pts.append([lon, lat, t, track])

    return {"tracks": [tracks[eid] for eid in id_order]}


async def query_tracks(
    kind: str | None,
    bbox: tuple[float, float, float, float] | None,
    t_from: float,
    t_to: float,
    limit_ids: int = 500,
    max_points_per_id: int = 500,
) -> dict[str, Any]:
    """Return tracks matching the given filters.

    Returns::

        {"tracks": [{"id": str, "kind": str, "points": [[lon,lat,t,track], ...]}, ...]}
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _query_sync, kind, bbox, t_from, t_to, limit_ids, max_points_per_id
    )


# ── prune ─────────────────────────────────────────────────────────────────────

def prune(retention_hours: int) -> int:
    """Delete rows older than *retention_hours* ago. Returns the deleted count."""
    cutoff = time.time() - retention_hours * 3600
    try:
        con = _connect()
        cur = con.execute("DELETE FROM positions WHERE t < ?", (cutoff,))
        deleted = cur.rowcount
        con.commit()
        con.close()
        return deleted
    except Exception:  # noqa: BLE001
        log.exception("history: prune error")
        return 0


# ── lifecycle ─────────────────────────────────────────────────────────────────

def start() -> None:
    """Start the background flush task. No-op when history_enabled=False."""
    global _flush_task
    settings = get_settings()
    if not settings.history_enabled:
        log.info("history: disabled (history_enabled=False)")
        return
    if _flush_task is not None and not _flush_task.done():
        return  # already running
    # Ensure the DB + schema exist immediately so the first query works even
    # before the first flush.
    try:
        con = _connect()
        con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: failed to open DB at start")
    _flush_task = asyncio.ensure_future(_flush_loop())
    log.info("history: started (db=%s)", _resolved_db_path())


async def stop() -> None:
    """Cancel the flush task and do a final flush."""
    global _flush_task, _buffer
    if _flush_task is not None:
        _flush_task.cancel()
        try:
            await _flush_task
        except asyncio.CancelledError:
            pass
        _flush_task = None
    # Final drain
    if _buffer:
        rows, _buffer = _buffer, []
        _flush_sync(rows)


def stats() -> dict[str, Any]:
    """Return diagnostics dict."""
    settings = get_settings()
    return {
        "enabled": settings.history_enabled,
        "db_path": _resolved_db_path(),
        "buffered": len(_buffer),
        "rows_written": _rows_written,
        "task_running": _flush_task is not None and not _flush_task.done(),
    }
