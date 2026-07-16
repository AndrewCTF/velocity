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
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from app import memtier
from app.config import get_settings

log = logging.getLogger(__name__)

# ── tunable constants ──────────────────────────────────────────────────────────
_FLUSH_INTERVAL_S: float = 3.0       # background flush cadence
_RATE_LIMIT_SECS: float = 5.0        # minimum gap between writes for same id
_RATE_LIMIT_DEG: float = 0.01        # OR ~1 km movement triggers immediate write
_MAX_BUFFERED_IDS: int = 60_000      # FIFO-evict beyond this to keep RAM bounded
_PRUNE_INTERVAL_S: float = 3600.0    # enforce retention at most once per hour
_WAL_SIZE_LIMIT_BYTES: int = 512 * 1024**2  # truncate the WAL back to <=512 MB
# Coverage aggregates the whole archive (83 M rows measured -> 73 s), so it
# cannot be recomputed per poll: the replay bar asks every 5 s, and a query
# that outlives its own poll interval means a read transaction is ALWAYS open.
# That is what pinned the WAL. The numbers it feeds (recording-since, GB, fix
# count, per-hour density) move slowly, so serve a cached answer and let the
# scan run at most this often.
_COVERAGE_TTL_S: float = 120.0

# ── module-level state ─────────────────────────────────────────────────────────
# _buffer: ordered list of rows pending flush
# _last: per-id last-buffered (t, lon, lat)  used for rate-limiting
_buffer: list[tuple[str, str, float, float, float, float, str]] = []
_last: collections.OrderedDict[str, tuple[float, float, float]] = collections.OrderedDict()
_rows_written: int = 0
_flush_task: asyncio.Task[None] | None = None
# (window_hours, bucket_hours), computed_at, payload — see coverage() for why
# this cache is a correctness control and not a speed optimisation.
_coverage_cache: tuple[tuple[int, int], float, dict[str, Any]] | None = None
_coverage_lock: asyncio.Lock = asyncio.Lock()
_db_path: str | None = None          # resolved at start(); overridable in tests
_db_path_override: str | None = None  # set by tests via override_db_path()
# Phase 1: vessels we've already run through entity resolution this process, so
# the resolver fires once per distinct vessel (on first sight) — not every poll.
_resolved_seen: set[str] = set()
_RESOLVE_SEEN_MAX: int = 200_000


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


def _clamped_retention_hours() -> int:
    """Effective time-prune window, clamped so retention stays bounded.

    Retention is operator-tunable (``history_retention_hours``) to lift replay
    beyond the old ~24 h live window — multi-day scrub — but it must stay
    bounded: a fat-fingered env var (e.g. 1_000_000) would otherwise let the DB
    grow until only the byte cap reins it in, much later. We clamp into
    ``[1, history_retention_max_hours]``. A ceiling of 0 disables the upper
    bound (the byte cap is then the only limit), but the floor of 1 always
    holds so the prune cutoff is never in the future / non-positive.

    NOTE: this is a *time* bound only. The byte cap (``enforce_size_cap`` +
    ``_vacuum``) is the binding storage limit and is unchanged; raising the
    hour window never removes the cap.
    """
    settings = get_settings()
    hours = int(settings.history_retention_hours)
    # Archive mode overrides only how the ceiling is computed (reusing the
    # existing ceiling=0 "no upper bound" branch below) — operators who don't
    # want ARCHIVE_MODE to also uncap retention can still set
    # HISTORY_RETENTION_MAX_HOURS=0 directly, unchanged.
    ceiling = 0 if settings.archive_mode else int(settings.history_retention_max_hours)
    if hours < 1:
        hours = 1
    if ceiling > 0 and hours > ceiling:
        hours = ceiling
    return hours


def _connect() -> sqlite3.Connection:
    path = _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    # A WAL only checkpoints past its OLDEST live reader. The recorder writes
    # continuously, so one long-running read holds every frame written during
    # it, and without a size limit the file is never truncated back after the
    # checkpoint that finally clears it. Measured on the dev box: a 15.2 GB
    # archive carrying a 49.6 GB WAL, of which a TRUNCATE checkpoint reclaimed
    # 48.6 GB — 98 % of it redundant page versions pinned by readers. The limit
    # bounds the file whatever the read pattern does.
    con.execute(f"PRAGMA journal_size_limit={_WAL_SIZE_LIMIT_BYTES}")
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
            _resolve_vessel(entity_id, row)
        except Exception:  # noqa: BLE001
            continue


def _resolve_vessel(entity_id: str, row: dict[str, Any]) -> None:
    """Best-effort entity resolution on first sight of a vessel (Phase 1).

    Builds the alias graph (mmsi/imo/name/callsign → one canonical identity) so a
    vessel observed under multiple MMSIs becomes ONE object. Throttled by a
    process-lifetime seen-set so steady-state cost is ~0, and never raises — a
    resolver hiccup must not drop a position fix.
    """
    if entity_id in _resolved_seen:
        return
    try:
        from app.intel import resolve  # lazy: avoid import cost at module load

        ids: dict[str, Any] = {"mmsi": row.get("mmsi") or entity_id.split(":", 1)[-1]}
        for src_key, dst_key in (("imo", "imo"), ("name", "name"),
                                 ("ship_name", "name"), ("callsign", "callsign")):
            val = row.get(src_key)
            if val:
                ids.setdefault(dst_key, val)
        resolve.resolve("vessel", ids)
        if len(_resolved_seen) < _RESOLVE_SEEN_MAX:
            _resolved_seen.add(entity_id)
    except Exception:  # noqa: BLE001
        pass


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


def _size_cap_bytes(settings: Any) -> int:
    """Effective byte cap for the hourly prune pass.

    Default profile: sized to available RAM (config value is the hard ceiling),
    so a small box keeps less history on disk and a big one keeps more. Archive
    profile: the operator deliberately allocated disk for a multi-day/week
    archive, so the cap is the fixed disk budget regardless of free RAM —
    falling back to history_max_bytes (with a warning) if the budget wasn't set,
    so an operator opt-in is never a silent no-op.
    """
    if settings.archive_mode:
        if settings.history_disk_budget_gb > 0:
            return int(settings.history_disk_budget_gb * 1024**3)
        log.warning(
            "history: archive_mode=1 but history_disk_budget_gb=0 — "
            "falling back to history_max_bytes (%d)",
            settings.history_max_bytes,
        )
        return int(settings.history_max_bytes)
    return memtier.cache_budget_bytes(
        "history", floor=64 * 1024**2, ceil=int(settings.history_max_bytes)
    )


async def _maintenance_pass() -> None:
    """One retention pass: time-prune to the hour window, then enforce the byte
    cap, then VACUUM so deleted pages return to the filesystem (a bare DELETE
    leaves the file at its high-water mark — the "10 GB history.db" bug).

    Factored out of _flush_loop so the hourly cycle is a single testable unit.
    """
    loop = asyncio.get_running_loop()
    settings = get_settings()
    hours = _clamped_retention_hours()
    size_cap = _size_cap_bytes(settings)
    deleted = await loop.run_in_executor(None, prune, hours)
    deleted += await loop.run_in_executor(None, enforce_size_cap, size_cap)
    if deleted:
        # Archive mode skips the full-file VACUUM here on purpose: at archive
        # scale (tens-to-hundreds of GB) a full VACUUM can stall the writer for
        # minutes, and the archive is byte-budget-capped anyway (enforce_size_cap
        # already ran above), so reclaiming disk space isn't needed until the
        # configured budget is hit.
        if not settings.archive_mode:
            await loop.run_in_executor(None, _vacuum)
        log.info(
            "history: pruned %d rows (>%dh / >%d bytes)%s",
            deleted,
            hours,
            size_cap,
            "" if settings.archive_mode else ", vacuumed",
        )


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
        if time.time() >= next_prune:
            next_prune = time.time() + _PRUNE_INTERVAL_S
            await _maintenance_pass()


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
    except Exception as exc:  # noqa: BLE001
        # Distinguish "the store failed" from "no data in this window" (issue #16):
        # returning a bare empty list on error made a partial outage look like a
        # quiet window. The `degraded` flag lets the caller/UI tell them apart;
        # the failure is also logged here for the operator.
        log.exception("history: query error")
        return {"tracks": [], "degraded": True, "error": f"{type(exc).__name__}"}

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


# ── metrics-over-time (§8) ──────────────────────────────────────────────────

def _timeseries_sync(bucket_sec: int, t_from: float, t_to: float) -> dict[str, Any]:
    """Distinct contact counts per time bucket, split by kind. Real observed data
    from the position store — the source of the Metrics 'over time' trend."""
    try:
        con = _connect()
        rows = con.execute(
            "SELECT CAST(t / ? AS INTEGER) * ? AS bkt, kind, COUNT(DISTINCT id) AS n "
            "FROM positions WHERE t >= ? AND t <= ? GROUP BY bkt, kind ORDER BY bkt",
            [bucket_sec, bucket_sec, t_from, t_to],
        ).fetchall()
        con.close()
    except Exception as exc:  # noqa: BLE001
        # Signal error distinctly from an empty window (issue #16).
        log.exception("history: timeseries error")
        return {"bucket_sec": bucket_sec, "buckets": [], "degraded": True,
                "error": f"{type(exc).__name__}"}

    by_bucket: dict[int, dict[str, Any]] = {}
    for bkt, kind, n in rows:
        b = by_bucket.setdefault(int(bkt), {"t": int(bkt), "aircraft": 0, "vessel": 0, "total": 0})
        if kind in ("aircraft", "vessel"):
            b[kind] = int(n)
        b["total"] += int(n)
    return {"bucket_sec": bucket_sec, "buckets": [by_bucket[k] for k in sorted(by_bucket)]}


async def count_timeseries(bucket_sec: int, t_from: float, t_to: float) -> dict[str, Any]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _timeseries_sync, bucket_sec, t_from, t_to)


# ── coverage (replay ownership chip + heat-strip) ─────────────────────────────

def _coverage_sync(window_hours: int, bucket_hours: int) -> dict[str, Any]:
    """Recording-since / total size / row count / per-bucket fix counts — the
    real-data source for the replay bar's ownership chip and heat-strip."""
    path = _resolved_db_path()
    try:
        total_bytes = os.path.getsize(path)
    except OSError:
        total_bytes = 0
    try:
        con = _connect()
        recording_since = con.execute("SELECT MIN(t) FROM positions").fetchone()[0]
        row_count = con.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
        bucket_sec = bucket_hours * 3600
        now = time.time()
        t_from = now - window_hours * 3600
        rows = con.execute(
            "SELECT CAST(t / ? AS INTEGER) * ? AS bkt, COUNT(*) AS n "
            "FROM positions WHERE t >= ? GROUP BY bkt ORDER BY bkt",
            [bucket_sec, bucket_sec, t_from],
        ).fetchall()
        con.close()
    except Exception as exc:  # noqa: BLE001
        # Signal error distinctly from an empty window (issue #16, same pattern
        # as _query_sync/_timeseries_sync above).
        log.exception("history: coverage error")
        return {
            "recording_since": None, "total_bytes": total_bytes, "row_count": 0,
            "buckets": [], "degraded": True, "error": f"{type(exc).__name__}",
        }
    return {
        "recording_since": recording_since,
        "total_bytes": total_bytes,
        "row_count": int(row_count),
        "buckets": [{"t": int(bkt), "count": int(n)} for bkt, n in rows],
    }


async def coverage(window_hours: int, bucket_hours: int) -> dict[str, Any]:
    """Cached: at most one scan per _COVERAGE_TTL_S, and never two at once.

    Both bounds matter, and neither is about latency. The scan holds a read
    transaction for its whole duration, and a WAL cannot checkpoint past its
    oldest reader — so an uncached 73 s scan re-armed every 5 s kept a reader
    permanently open and the WAL grew without limit (49.6 GB against a 15.2 GB
    archive). The lock additionally stops a burst of callers each opening their
    own concurrent scan: an HTTP client that gives up does NOT cancel the
    executor thread it started, so aborted polls used to pile up server-side.
    """
    global _coverage_cache
    key = (window_hours, bucket_hours)
    now = time.time()
    cached = _coverage_cache
    if cached is not None and cached[0] == key and now - cached[1] < _COVERAGE_TTL_S:
        return cached[2]

    async with _coverage_lock:
        # Re-check: a caller queued behind the lock is served by the scan that
        # just finished rather than starting an identical one.
        cached = _coverage_cache
        now = time.time()
        if cached is not None and cached[0] == key and now - cached[1] < _COVERAGE_TTL_S:
            return cached[2]
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, _coverage_sync, window_hours, bucket_hours)
        # Don't cache a degraded answer: a transient error would otherwise stick
        # for the whole TTL.
        if not result.get("degraded"):
            _coverage_cache = (key, time.time(), result)
        return result


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


def enforce_size_cap(max_bytes: int) -> int:
    """Drop the oldest rows until the DB file is under *max_bytes*.

    The on-disk file size only shrinks after a VACUUM, so we cannot delete-and-
    measure in a loop. Instead we estimate the fraction of rows to drop from the
    byte overage (with a 10 % margin) and delete that oldest slice in one pass;
    the caller VACUUMs afterwards and the next hourly pass corrects any residue.
    Returns the deleted row count. A max_bytes of 0 disables the cap.
    """
    if max_bytes <= 0:
        return 0
    path = _resolved_db_path()
    try:
        size = os.path.getsize(path)
    except OSError:
        return 0
    if size <= max_bytes:
        return 0
    try:
        con = _connect()
        try:
            total = con.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
            if total <= 0:
                return 0
            over_frac = 1.0 - (max_bytes / size)
            to_drop = min(total - 1, int(total * over_frac * 1.1) + 1)
            if to_drop <= 0:
                return 0
            # The timestamp of the to_drop-th oldest row is the delete cutoff.
            row = con.execute(
                "SELECT t FROM positions ORDER BY t LIMIT 1 OFFSET ?", (to_drop,)
            ).fetchone()
            if row is None:
                return 0
            cur = con.execute("DELETE FROM positions WHERE t <= ?", (row[0],))
            deleted = cur.rowcount
            con.commit()
            return deleted
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: size-cap error")
        return 0


def _vacuum() -> None:
    """Rewrite the DB file so freed pages return to the filesystem."""
    try:
        con = _connect()
        con.execute("VACUUM")
        con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: vacuum error")


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
    """Return diagnostics dict.

    ``retention_hours`` is the *effective* (clamped) time-prune window, so the
    frontend can bound the replay date-picker to what's actually retained
    rather than the raw, possibly-out-of-range setting.
    """
    settings = get_settings()
    return {
        "enabled": settings.history_enabled,
        "db_path": _resolved_db_path(),
        "buffered": len(_buffer),
        "rows_written": _rows_written,
        "task_running": _flush_task is not None and not _flush_task.done(),
        "retention_hours": _clamped_retention_hours(),
        "retention_max_hours": int(settings.history_retention_max_hours),
        "max_bytes": int(settings.history_max_bytes),
    }
