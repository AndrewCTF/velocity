"""Historical position store — Postgres + TimescaleDB backend.

The same archive `app/history.py` keeps in SQLite, in the store it moves to
when ``HISTORY_PG_DSN`` is set (operator decision 2026-09-17; the plan's §H).
`history.py` owns the public surface, the in-RAM buffer and the 3 s flush loop
and *delegates* to this module; nothing here is called by a route directly, and
the wire shapes returned by the query functions are byte-for-byte the shapes
`history.py` returns from SQLite.

What moves and why
------------------
SQLite carried 55 M fixes in an 11 GB file at ~200 B/row, one zlib'd `extra`
JSON blob per fix; coverage aggregated the whole archive on every call and
pinned a 49.6 GB WAL (docs/decisions.md 2026-07-16). Here:

* the `extra` blob becomes typed columns, because columnar compression works
  per column and a JSON blob compresses as one opaque string;
* retention is `drop_chunks`, not `DELETE` + `VACUUM` — **no VACUUM runs
  anywhere on this path**, which is what the sharding machinery in `history.py`
  exists to work around;
* coverage and the 1-hour timeseries read a continuous aggregate.

Encoding
--------
Positions are integer micro-degrees (``round(lat * 1e6)``), course is tenths of
a degree (``round(track * 10)``), speed is **tenths of a knot** (AIS SOG x 10)
and altitude is whole metres. ``kind`` is 0 = aircraft, 1 = vessel.
``source`` is 0 = observed by this deployment, 1 = migrated from the legacy
SQLite archive, 2 = reserved for an opt-in upstream backfill; the live recorder
only ever writes 0. The full column table is in
``infra/db/20_history_timescale.sql``, which is also the schema this module
applies.

Freshness
---------
``coverage()`` and the 1-hour bucket of ``count_timeseries()`` read the
``positions_hourly`` continuous aggregate. Its refresh policy runs every 10
minutes, but the view is declared ``materialized_only = false``, so Timescale
UNIONs the live rows for the not-yet-materialised tail: the answer is current,
and only the *cost* (not the content) depends on the refresh. Every other read
goes to the raw hypertable and has no lag at all.

Nothing in here logs the DSN. Failures log the exception class plus
``host:port/db``; a password in the DSN would otherwise be a leak with several
copies (the same rule `foundry/connections.py` keeps for operator SQL sources).
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import math
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import asyncpg

from app.config import get_settings

log = logging.getLogger(__name__)

# ── encoding constants ────────────────────────────────────────────────────────

KIND_AIRCRAFT = 0
KIND_VESSEL = 1
_KIND_TO_INT: dict[str, int] = {"aircraft": KIND_AIRCRAFT, "vessel": KIND_VESSEL}
_INT_TO_KIND: dict[int, str] = {v: k for k, v in _KIND_TO_INT.items()}

#: Observed by this deployment's own feed union — the only value the recorder writes.
SOURCE_LIVE = 0
#: Copied out of the legacy SQLite archive by the migration script.
SOURCE_MIGRATED = 1
#: Reserved: an opt-in backfill from a public upstream archive, licence in hand.
SOURCE_UPSTREAM = 2

_SCHEMA_SQL = Path(__file__).resolve().parents[3] / "infra" / "db" / "20_history_timescale.sql"

# A read that outlives its own poll interval is what pinned the SQLite WAL; on
# Postgres the equivalent damage is a transaction that never ends. Cap both.
_STATEMENT_TIMEOUT_MS = 60_000
_POOL_MIN = 1
_POOL_MAX = 8

# ── module state ──────────────────────────────────────────────────────────────

_pool: asyncpg.Pool | None = None
_pool_loop: asyncio.AbstractEventLoop | None = None
_pool_lock: asyncio.Lock | None = None
_schema_applied = False
_stats: dict[str, Any] = {}
_stats_at: float = 0.0


def _lock() -> asyncio.Lock:
    """The pool lock, created against whatever loop is running.

    An ``asyncio.Lock`` created at import time binds to no loop on 3.10+, but a
    lock created under one loop and awaited under another raises. The test
    suite gives every test its own loop, so the lock is (re)made alongside the
    pool rather than at module scope.
    """
    global _pool_lock
    if _pool_lock is None:
        _pool_lock = asyncio.Lock()
    return _pool_lock


def dsn_label(dsn: str) -> str:
    """``host:port/db`` for logs. NEVER the DSN — it can carry a password."""
    try:
        parts = urlsplit(dsn)
        host = parts.hostname or "?"
        port = parts.port or 5432
        db = (parts.path or "/").lstrip("/") or "?"
        return f"{host}:{port}/{db}"
    except Exception:  # noqa: BLE001 — a label must never be the thing that raises
        return "?"


# ── schema ────────────────────────────────────────────────────────────────────


def split_sql(text: str) -> list[str]:
    """Split a schema file into individual statements.

    Needed because ``CREATE MATERIALIZED VIEW ... WITH
    (timescaledb.continuous)`` cannot run inside a transaction block, and
    asyncpg sends a multi-statement string as one implicit transaction. It
    understands ``--`` comments and single-quoted strings; the schema file
    carries a comment saying not to add dollar-quoted bodies, which this
    deliberately does not parse.
    """
    out: list[str] = []
    buf: list[str] = []
    in_str = False
    in_comment = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_comment:
            if ch == "\n":
                in_comment = False
                buf.append(ch)
            i += 1
            continue
        if in_str:
            buf.append(ch)
            if ch == "'":
                # '' inside a string is an escaped quote, not a terminator.
                if i + 1 < len(text) and text[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "-" and text[i : i + 2] == "--":
            in_comment = True
            i += 2
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
            i += 1
            continue
        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


async def _compression_enabled(con: asyncpg.Connection) -> bool:
    try:
        return bool(
            await con.fetchval(
                "SELECT compression_enabled FROM timescaledb_information.hypertables "
                "WHERE hypertable_name = 'positions'"
            )
        )
    except Exception:  # noqa: BLE001
        return False


async def apply_schema(con: asyncpg.Connection) -> None:
    """Apply ``infra/db/20_history_timescale.sql``, idempotently.

    Two statements need care on a re-run and get it here rather than in SQL:

    * ``CREATE EXTENSION timescaledb`` needs superuser. On a managed Postgres
      where the extension is already installed by the operator, the privilege
      error is not fatal — we only need it to *exist*.
    * ``ALTER TABLE ... SET (timescaledb.compress, ...)`` is skipped once
      compression is on, because re-issuing it against a hypertable that
      already has compressed chunks errors.

    Then the chunk interval and the compression cut-off are reconciled to the
    configured values, so the SQL file can keep the defaults and stay directly
    applicable by psql.
    """
    settings = get_settings()
    sql = _SCHEMA_SQL.read_text(encoding="utf-8")
    compressed = await _compression_enabled(con)
    for stmt in split_sql(sql):
        lowered = stmt.lower()
        if compressed and "timescaledb.compress," in lowered:
            continue
        try:
            await con.execute(stmt)
        except asyncpg.InsufficientPrivilegeError:
            if "create extension" in lowered:
                have = await con.fetchval(
                    "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"
                )
                if have:
                    continue
            raise
    chunk_hours = max(1, int(settings.history_pg_chunk_hours))
    await con.execute(
        "SELECT set_chunk_time_interval('positions', $1::interval)",
        _dt.timedelta(hours=chunk_hours),
    )
    # remove+add rather than add-if-not-exists: with a policy already installed,
    # add_compression_policy(if_not_exists => TRUE) keeps the OLD interval and
    # only warns, so a changed setting would silently never take.
    compress_after = max(1, int(settings.history_pg_compress_after_hours))
    await con.execute("SELECT remove_compression_policy('positions', if_exists => TRUE)")
    await con.execute(
        "SELECT add_compression_policy('positions', $1::interval, if_not_exists => TRUE)",
        _dt.timedelta(hours=compress_after),
    )


# ── pool lifecycle ────────────────────────────────────────────────────────────


async def _ensure_pool() -> asyncpg.Pool:
    """Return the live pool, creating it (and the schema) on first use.

    Every public function goes through here rather than trusting ``start()``:
    ``start()`` is fire-and-forget so a down Postgres cannot block the app's
    lifespan, and a reader that arrives before the pool is up must wait for it
    rather than read nothing.
    """
    global _pool, _pool_loop, _schema_applied
    loop = asyncio.get_running_loop()
    if _pool is not None and _pool_loop is loop and not _pool.is_closing():
        return _pool
    async with _lock():
        if _pool is not None and _pool_loop is loop and not _pool.is_closing():
            return _pool
        if _pool is not None and _pool_loop is not loop:
            # A pool belongs to the loop that created it. This happens in tests
            # (one loop per test); dropping the reference is the only safe move
            # — closing it would await on a loop that is gone.
            log.debug("history_pg: dropping a pool bound to a finished event loop")
            _pool = None
            _schema_applied = False
        dsn = (get_settings().history_pg_dsn or "").strip()
        if not dsn:
            raise RuntimeError("history_pg: no history_pg_dsn configured")
        pool = await asyncpg.create_pool(
            dsn,
            min_size=_POOL_MIN,
            max_size=_POOL_MAX,
            command_timeout=_STATEMENT_TIMEOUT_MS / 1000.0,
            server_settings={
                "statement_timeout": str(_STATEMENT_TIMEOUT_MS),
                "idle_in_transaction_session_timeout": str(_STATEMENT_TIMEOUT_MS),
                "application_name": "velocity-history",
            },
        )
        if not _schema_applied:
            try:
                async with pool.acquire() as con:
                    await apply_schema(con)
            except Exception as exc:  # noqa: BLE001 — any apply failure releases the pool
                # The module global is installed only after a clean apply, so
                # without this close every retry of _ensure_pool would leak a
                # fresh set of connections until Postgres says 'too many
                # clients' and masks the original error.
                log.warning(
                    "history_pg: schema apply failed (%s) against %s, releasing pool",
                    type(exc).__name__,
                    dsn_label(dsn),
                )
                try:
                    await pool.close()
                except Exception:  # noqa: BLE001 — the apply error is the one that matters
                    log.debug("history_pg: pool close after failed apply", exc_info=True)
                raise
            _schema_applied = True
        _pool = pool
        _pool_loop = loop
        return pool


async def start() -> None:
    """Open the pool and apply the schema. Safe to await more than once."""
    settings = get_settings()
    await _ensure_pool()
    log.info(
        "history: started (timescale, %s, chunk=%dh, compress_after=%dh)",
        dsn_label(settings.history_pg_dsn),
        settings.history_pg_chunk_hours,
        settings.history_pg_compress_after_hours,
    )
    await refresh_stats()


async def stop() -> None:
    """Close the pool. Callers flush the buffer BEFORE calling this."""
    global _pool, _pool_loop, _pool_lock, _schema_applied, _stats, _stats_at
    pool, _pool = _pool, None
    _pool_loop = None
    # The lock binds to a loop on its first CONTENDED acquire, so it has to be
    # dropped with the pool — otherwise a lock contended under one test's loop
    # raises "bound to a different event loop" in the next one.
    _pool_lock = None
    _schema_applied = False
    _stats = {}
    _stats_at = 0.0
    if pool is not None:
        try:
            await pool.close()
        except Exception:  # noqa: BLE001 — shutdown must not raise
            log.debug("history_pg: pool close failed", exc_info=True)


# ── row conversion ────────────────────────────────────────────────────────────


def _i(value: Any) -> int | None:
    """Coerce to int for an integer column, or None. ``copy_records_to_table``
    is type-strict: a float handed to a smallint raises and drops the whole
    flush batch, so every integer column goes through here."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return int(round(f))


def _clamp_small(value: int | None) -> int | None:
    """Keep a smallint column inside its range instead of raising on garbage."""
    if value is None:
        return None
    if value < -32768 or value > 32767:
        return None
    return value


def _clamp_int4(value: int | None) -> int | None:
    """Keep an int4 column inside its range instead of raising on garbage.

    asyncpg rejects the ENTIRE COPY batch when one value overflows its
    column, so one wild upstream lat/alt must cost one row, never the batch.
    """
    if value is None:
        return None
    if value < -2_147_483_648 or value > 2_147_483_647:
        return None
    return value


def _squawk(value: Any) -> int | None:
    """Mode-A code as a decimal number. It arrives as a 4-character string of
    octal digits ("7700"); it is stored the way it reads, not octal-decoded."""
    if value is None:
        return None
    text = str(value).strip()
    if not text.isdigit():
        return None
    return _clamp_small(int(text))


def _text(value: Any, limit: int = 64) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] or None


def _speed_dm(extra: dict[str, Any]) -> int | None:
    """Speed over ground in TENTHS of a knot.

    ``ingest_vessels`` records AIS SOG under ``speed`` (knots).
    ``ingest_aircraft`` records no speed at all, so aircraft rows carry NULL
    here and the ``series=true`` payload reports ``sog: null`` for them — the
    same thing the SQLite archive holds, said honestly rather than fabricated.
    """
    for key in ("sog", "speed"):
        raw = extra.get(key)
        if raw is None:
            continue
        try:
            knots = float(raw)
        except (TypeError, ValueError):
            return None
        return _clamp_small(_i(knots * 10.0))
    return None


def _record(row: tuple[Any, ...]) -> tuple[Any, ...] | None:
    """One `history._buffer` row → one `positions` record, or None to skip.

    The buffer row is ``(kind, id, t, lon, lat, track, encoded_extra)`` and the
    encoding of that last field is `history._encode_extra`'s business, so the
    decode is borrowed from there rather than reimplemented.

    Never raises: a malformed fix is a skipped row, not a batch-killer. The
    int4 columns are clamped to their range — an out-of-range value would make
    asyncpg reject the entire COPY batch — and a field that cannot even be
    converted is skipped rather than escaping into the flush loop.
    """
    from app.history import _decode_extra  # noqa: PLC0415 — avoids an import cycle

    try:
        kind, entity_id, t, lon, lat, track, extra_blob = row
    except ValueError:  # a row is always a 7-tuple; anything else is garbage
        return None
    kind_i = _KIND_TO_INT.get(str(kind))
    if kind_i is None:
        return None
    extra = _decode_extra(extra_blob)
    try:
        t_dt = _dt.datetime.fromtimestamp(float(t), tz=_dt.UTC)
        lat_e6 = _clamp_int4(_i(float(lat) * 1e6))
        lon_e6 = _clamp_int4(_i(float(lon) * 1e6))
        track_dd = _clamp_small(_i(float(track) * 10.0))
        alt_m = _clamp_int4(_i(extra.get("baro_alt_m")))
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    if lat_e6 is None or lon_e6 is None:
        return None
    return (
        t_dt,
        kind_i,
        str(entity_id),
        lat_e6,
        lon_e6,
        track_dd,
        alt_m,
        _speed_dm(extra),
        _text(extra.get("callsign") or extra.get("name")),
        _squawk(extra.get("squawk")),
        _text(extra.get("category") or extra.get("ship_type"), 32),
        SOURCE_LIVE,
    )


_COLUMNS = [
    "t",
    "kind",
    "id",
    "lat_e6",
    "lon_e6",
    "track_dd",
    "alt_m",
    "speed_dm",
    "callsign",
    "squawk",
    "category",
    "source",
]


def _records_for(rows: list[tuple[Any, ...]]) -> list[tuple[Any, ...]]:
    """Convert a whole buffer batch. Synchronous, run in an executor."""
    return [r for r in (_record(row) for row in rows) if r is not None]


async def flush_rows(rows: list[tuple[Any, ...]]) -> int:
    """COPY a batch of buffered fixes into the hypertable. Returns rows written.

    Never raises: a flush failure must not take the recorder's event loop with
    it, and the buffer it was handed is already detached, so the cost of a
    failure is bounded to that batch (same contract as `history._flush_sync`).
    One malformed fix costs one row — it is skipped at conversion and counted
    in a single log line per batch, never dropped with the good ones.
    """
    if not rows:
        return 0
    # Decoding `extra` is json.loads (plus zlib when history_compress_extra is
    # on) PER ROW, and this runs on the recorder's event loop next to the 1 s
    # ADS-B tick. At the archive's measured steady rate (~55 M fixes over 39
    # days) it is nothing; at firehose scale it is not, and the SQLite path
    # always did its whole write in an executor. Keep that property — and keep
    # the call INSIDE the try, so a conversion error can only lose its batch,
    # never escape into the flush loop.
    loop = asyncio.get_running_loop()
    try:
        records = await loop.run_in_executor(None, _records_for, rows)
        skipped = len(rows) - len(records)
        if skipped:
            log.info(
                "history_pg: flush skipped %d/%d malformed fix(es)",
                skipped,
                len(rows),
            )
        if not records:
            return 0
        pool = await _ensure_pool()
        async with pool.acquire() as con:
            await con.copy_records_to_table("positions", records=records, columns=_COLUMNS)
        return len(records)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "history_pg: flush failed (%s) against %s",
            type(exc).__name__,
            dsn_label(get_settings().history_pg_dsn),
        )
        return 0


# ── read helpers ──────────────────────────────────────────────────────────────


def _ts(t: float) -> _dt.datetime:
    return _dt.datetime.fromtimestamp(float(t), tz=_dt.UTC)


def _epoch(value: _dt.datetime) -> float:
    return value.timestamp()


def _bbox_e6(bbox: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """(min_lon, min_lat, max_lon, max_lat) degrees → micro-degree bounds.

    Floor the minima and ceil the maxima: a row stored as ``round(lat * 1e6)``
    must not fall outside a box whose own edge rounded the other way.
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    return (
        math.floor(min_lon * 1e6),
        math.floor(min_lat * 1e6),
        math.ceil(max_lon * 1e6),
        math.ceil(max_lat * 1e6),
    )


def _degraded(what: str, exc: Exception, payload: dict[str, Any]) -> dict[str, Any]:
    """The `history.py` error contract: say "the store failed", never let a
    partial outage look like a quiet window (issue #16)."""
    log.warning(
        "history_pg: %s failed (%s) against %s",
        what,
        type(exc).__name__,
        dsn_label(get_settings().history_pg_dsn),
    )
    return {**payload, "degraded": True, "error": f"{type(exc).__name__}"}


# ── queries ───────────────────────────────────────────────────────────────────


async def query_tracks(
    kind: str | None,
    bbox: tuple[float, float, float, float] | None,
    t_from: float,
    t_to: float,
    limit_ids: int,
    max_points_per_id: int,
) -> dict[str, Any]:
    """Tracks matching the filters, in `history.query_tracks`'s exact shape.

    Unlike the SQLite path this bounds the SCAN as well as the result
    (``LIMIT limit_ids * max_points_per_id`` under ``ORDER BY id, t``): the
    caps exist to bound the answer, and on an archive this size fetching every
    matching row first to throw most of them away is how a read becomes an
    outage.
    """
    params: list[Any] = [_ts(t_from), _ts(t_to)]
    where = "t >= $1 AND t <= $2"
    if kind:
        params.append(_KIND_TO_INT.get(kind, -1))
        where += f" AND kind = ${len(params)}"
    if bbox:
        lo_lon, lo_lat, hi_lon, hi_lat = _bbox_e6(bbox)
        params.extend([lo_lon, hi_lon, lo_lat, hi_lat])
        n = len(params)
        where += (
            f" AND lon_e6 >= ${n - 3} AND lon_e6 <= ${n - 2}"
            f" AND lat_e6 >= ${n - 1} AND lat_e6 <= ${n}"
        )
    params.append(max(1, limit_ids * max(1, max_points_per_id)))
    try:
        pool = await _ensure_pool()
        rows = await pool.fetch(
            "SELECT kind, id, t, lon_e6, lat_e6, track_dd FROM positions "
            f"WHERE {where} ORDER BY id, t LIMIT ${len(params)}",
            *params,
        )
    except Exception as exc:  # noqa: BLE001
        return _degraded("query_tracks", exc, {"tracks": []})

    tracks: dict[str, dict[str, Any]] = {}
    id_order: list[str] = []
    for row in rows:
        row_id = row["id"]
        if row_id not in tracks:
            if len(tracks) >= limit_ids:
                continue
            tracks[row_id] = {
                "id": row_id,
                "kind": _INT_TO_KIND.get(int(row["kind"]), ""),
                "points": [],
            }
            id_order.append(row_id)
        pts: list[list[float]] = tracks[row_id]["points"]
        if len(pts) < max_points_per_id:
            pts.append(
                [
                    (row["lon_e6"] or 0) / 1e6,
                    (row["lat_e6"] or 0) / 1e6,
                    _epoch(row["t"]),
                    (row["track_dd"] or 0) / 10.0,
                ]
            )
    return {"tracks": [tracks[eid] for eid in id_order]}


async def query_track_by_id(
    entity_id: str,
    t_from: float,
    t_to: float,
    limit: int,
    include_series: bool = False,
) -> dict[str, Any]:
    """One identity's track over a window, off ``idx_positions_id_t``.

    With ``include_series`` the parallel ``series`` array carries the archived
    behaviour — ``t``, ``alt_m``, ``sog``, ``callsign`` — under the keys the
    frontend already reads. ``sog`` is ``speed_dm / 10`` (knots), which is what
    the SQLite path *meant* to return: it reads ``extra["sog"]`` while
    `ingest_vessels` writes ``extra["speed"]``, so on SQLite a vessel's speed
    series is null for every row. Here vessels report their real SOG; aircraft
    still report null, because `ingest_aircraft` records no speed at all.
    """
    try:
        pool = await _ensure_pool()
        rows = await pool.fetch(
            "SELECT t, lon_e6, lat_e6, track_dd, alt_m, speed_dm, callsign "
            "FROM positions WHERE id = $1 AND t BETWEEN $2 AND $3 ORDER BY t LIMIT $4",
            entity_id,
            _ts(t_from),
            _ts(t_to),
            limit,
        )
    except Exception as exc:  # noqa: BLE001
        return _degraded("query_track_by_id", exc, {"tracks": []})

    kind = entity_id.split(":", 1)[0] if ":" in entity_id else ""
    points = [
        [
            (r["lon_e6"] or 0) / 1e6,
            (r["lat_e6"] or 0) / 1e6,
            _epoch(r["t"]),
            (r["track_dd"] or 0) / 10.0,
        ]
        for r in rows
    ]
    out: dict[str, Any] = {"tracks": [{"id": entity_id, "kind": kind, "points": points}]}
    if include_series:
        out["series"] = [
            {
                "t": _epoch(r["t"]),
                "alt_m": r["alt_m"],
                "sog": None if r["speed_dm"] is None else r["speed_dm"] / 10.0,
                "callsign": r["callsign"],
            }
            for r in rows
        ]
    return out


async def count_timeseries(bucket_sec: int, t_from: float, t_to: float) -> dict[str, Any]:
    """Distinct contact counts per time bucket, split by kind.

    At a 1-hour bucket this reads ``positions_hourly``, where ``ids`` is an
    exact per-bucket ``count(DISTINCT id)``. At any other width it counts over
    the raw hypertable, because distinct counts do not sum: a contact seen in
    two hours is one contact, and adding two hourly buckets would report it
    twice. The route's own bounds (window <= 24 h) keep the raw path bounded.
    """
    use_agg = bucket_sec == 3600
    try:
        pool = await _ensure_pool()
        if use_agg:
            rows = await pool.fetch(
                "SELECT extract(epoch FROM bucket) AS bkt, kind, ids AS n "
                "FROM positions_hourly WHERE bucket >= $1 AND bucket <= $2 ORDER BY bucket",
                _ts(t_from),
                _ts(t_to),
            )
        else:
            rows = await pool.fetch(
                "SELECT floor(extract(epoch FROM t) / $1) * $1 AS bkt, kind, "
                "count(DISTINCT id) AS n FROM positions "
                "WHERE t >= $2 AND t <= $3 GROUP BY 1, 2 ORDER BY 1",
                float(bucket_sec),
                _ts(t_from),
                _ts(t_to),
            )
    except Exception as exc:  # noqa: BLE001
        return _degraded("timeseries", exc, {"bucket_sec": bucket_sec, "buckets": []})

    by_bucket: dict[int, dict[str, Any]] = {}
    for row in rows:
        bkt = int(row["bkt"])
        b = by_bucket.setdefault(bkt, {"t": bkt, "aircraft": 0, "vessel": 0, "total": 0})
        name = _INT_TO_KIND.get(int(row["kind"]))
        n = int(row["n"])
        if name:
            b[name] = n
        b["total"] += n
    return {
        "bucket_sec": bucket_sec,
        "buckets": [by_bucket[k] for k in sorted(by_bucket)],
    }


async def coverage(window_hours: int, bucket_hours: int) -> dict[str, Any]:
    """Recording-since / archive size / row count / per-bucket fix counts.

    Fix counts come from ``positions_hourly`` at any bucket width: ``n`` is
    ``count(*)``, which IS summable across hours (unlike the distinct-id
    column). ``oldest_ts`` is a one-row ordered read of the hypertable, which
    stops at the first chunk rather than scanning.

    ``total_bytes`` is ``hypertable_size('positions')`` — the compressed
    on-disk size, so it is directly comparable with the SQLite file it
    replaces, and it is what the byte budget in ``enforce_budget`` measures.
    """
    now = time.time()
    t_from = now - window_hours * 3600
    bucket_sec = bucket_hours * 3600
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as con:
            oldest = await con.fetchval("SELECT t FROM positions ORDER BY t LIMIT 1")
            total_bytes = await con.fetchval("SELECT hypertable_size('positions')") or 0
            row_count = await con.fetchval("SELECT coalesce(sum(n), 0) FROM positions_hourly")
            rows = await con.fetch(
                "SELECT floor(extract(epoch FROM bucket) / $1) * $1 AS bkt, sum(n) AS n "
                "FROM positions_hourly WHERE bucket >= $2 GROUP BY 1 ORDER BY 1",
                float(bucket_sec),
                _ts(t_from),
            )
    except Exception as exc:  # noqa: BLE001
        return _degraded(
            "coverage",
            exc,
            {
                "recording_since": None,
                "oldest_ts": None,
                "total_bytes": 0,
                "row_count": 0,
                "buckets": [],
            },
        )
    oldest_ts = _epoch(oldest) if oldest is not None else None
    return {
        "recording_since": oldest_ts,
        "oldest_ts": oldest_ts,
        "total_bytes": int(total_bytes),
        "row_count": int(row_count or 0),
        "buckets": [{"t": int(r["bkt"]), "count": int(r["n"])} for r in rows],
    }


async def ids_in_window(
    kind: str | None,
    bbox: tuple[float, float, float, float],
    t_from: float,
    t_to: float,
) -> dict[str, tuple[float, float, float]]:
    """``{id: (t, lon, lat)}`` for the LAST fix each id had in the box+window.

    One row per contact by construction (``DISTINCT ON``) rather than the
    SQLite path's "scan every row ordered by t and let the last write win", so
    the diff's cost tracks contacts rather than fixes.
    """
    lo_lon, lo_lat, hi_lon, hi_lat = _bbox_e6(bbox)
    params: list[Any] = [_ts(t_from), _ts(t_to), lo_lon, hi_lon, lo_lat, hi_lat]
    where = (
        "t >= $1 AND t <= $2 AND lon_e6 >= $3 AND lon_e6 <= $4 AND lat_e6 >= $5 AND lat_e6 <= $6"
    )
    if kind:
        params.append(_KIND_TO_INT.get(kind, -1))
        where += f" AND kind = ${len(params)}"
    try:
        pool = await _ensure_pool()
        rows = await pool.fetch(
            f"SELECT DISTINCT ON (id) id, t, lon_e6, lat_e6 FROM positions "
            f"WHERE {where} ORDER BY id, t DESC",
            *params,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("history_pg: ids_in_window failed (%s)", type(exc).__name__)
        return {}
    return {
        str(r["id"]): (_epoch(r["t"]), (r["lon_e6"] or 0) / 1e6, (r["lat_e6"] or 0) / 1e6)
        for r in rows
    }


async def distinct_ids_per_bucket(
    kind: str,
    bbox: tuple[float, float, float, float],
    t_from: float,
    t_to: float,
    bucket_sec: float,
) -> list[tuple[float, int]]:
    """Distinct ids inside *bbox*, bucketed by time — the chokepoint-traffic
    primitive. Buckets are half-open ``[start, start + bucket_sec)`` anchored at
    *t_from*, matching the SQLite path so the caller keeps control of the day
    boundary."""
    lo_lon, lo_lat, hi_lon, hi_lat = _bbox_e6(bbox)
    try:
        pool = await _ensure_pool()
        rows = await pool.fetch(
            "SELECT floor(extract(epoch FROM t - $1::timestamptz) / $2) AS bucket, "
            "count(DISTINCT id) AS n FROM positions "
            "WHERE kind = $3 AND t >= $1 AND t < $4 "
            "AND lon_e6 >= $5 AND lon_e6 <= $6 AND lat_e6 >= $7 AND lat_e6 <= $8 "
            "GROUP BY 1 ORDER BY 1",
            _ts(t_from),
            float(bucket_sec),
            _KIND_TO_INT.get(kind, -1),
            _ts(t_to),
            lo_lon,
            hi_lon,
            lo_lat,
            hi_lat,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("history_pg: distinct_ids_per_bucket failed (%s)", type(exc).__name__)
        return []
    return [(t_from + int(r["bucket"]) * bucket_sec, int(r["n"])) for r in rows]


# ── retention and byte budget ─────────────────────────────────────────────────


async def prune(retention_hours: int) -> int:
    """Drop whole chunks that end before the retention cutoff. Returns the
    number of chunks dropped.

    ``drop_chunks`` only removes chunks entirely older than the cutoff, so the
    archive keeps up to one chunk interval (``history_pg_chunk_hours``, 6 h by
    default) past the nominal window. That is the price of never issuing a
    DELETE — and never issuing a DELETE is the point: no row deletes, no
    VACUUM, no WAL amplification, and the space comes back at once.
    """
    if retention_hours <= 0:
        return 0
    try:
        pool = await _ensure_pool()
        rows = await pool.fetch(
            "SELECT drop_chunks('positions', older_than => $1::timestamptz)",
            _ts(time.time() - retention_hours * 3600),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("history_pg: prune failed (%s)", type(exc).__name__)
        return 0
    if rows:
        log.info("history_pg: dropped %d chunk(s) older than %dh", len(rows), retention_hours)
    return len(rows)


async def hypertable_bytes() -> int:
    try:
        pool = await _ensure_pool()
        return int(await pool.fetchval("SELECT hypertable_size('positions')") or 0)
    except Exception as exc:  # noqa: BLE001
        log.warning("history_pg: hypertable_size failed (%s)", type(exc).__name__)
        return 0


async def enforce_budget(max_bytes: int) -> int:
    """Drop the OLDEST chunk until the hypertable fits *max_bytes*.

    Exact rather than estimated, and the newest chunk is never dropped: the
    recorder is writing into it, and an operator whose budget is smaller than
    one chunk should be told, not silently left with an empty archive (the same
    rule the sharded SQLite path keeps). 0 disables the cap.
    """
    if max_bytes <= 0:
        return 0
    dropped = 0
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as con:
            while True:
                size = int(await con.fetchval("SELECT hypertable_size('positions')") or 0)
                if size <= max_bytes:
                    break
                chunks = await con.fetch(
                    "SELECT range_end FROM timescaledb_information.chunks "
                    "WHERE hypertable_name = 'positions' ORDER BY range_start"
                )
                if len(chunks) <= 1:
                    log.warning(
                        "history_pg: archive is %d bytes, over the %d-byte budget, and "
                        "only the newest chunk is left — raise HISTORY_BUDGET_GB. "
                        "Nothing has been thinned.",
                        size,
                        max_bytes,
                    )
                    break
                gone = await con.fetch(
                    "SELECT drop_chunks('positions', older_than => $1::timestamptz)",
                    chunks[0]["range_end"],
                )
                if not gone:
                    break
                dropped += len(gone)
                log.info(
                    "history_pg: dropped %d chunk(s) to stay under the %d-byte budget",
                    len(gone),
                    max_bytes,
                )
    except Exception as exc:  # noqa: BLE001
        log.warning("history_pg: enforce_budget failed (%s)", type(exc).__name__)
    return dropped


async def maintenance(retention_hours: int, max_bytes: int) -> int:
    """One retention pass: time window, then byte budget. No VACUUM, ever —
    that machinery exists in the SQLite path to work around SQLite."""
    dropped = await prune(retention_hours)
    dropped += await enforce_budget(max_bytes)
    return dropped


# ── stats ─────────────────────────────────────────────────────────────────────


async def refresh_stats() -> None:
    """Recompute the cached stats snapshot.

    ``/api/history/stats`` is a SYNCHRONOUS route handler (`routes/history.py`),
    and asyncpg is not. So the numbers are refreshed from the flush loop and
    `stats_snapshot()` serves the last good set; ``stats_age_s`` says how old
    they are rather than implying they are live.
    """
    global _stats, _stats_at
    try:
        pool = await _ensure_pool()
        async with pool.acquire() as con:
            size = int(await con.fetchval("SELECT hypertable_size('positions')") or 0)
            rows = int(await con.fetchval("SELECT coalesce(sum(n), 0) FROM positions_hourly") or 0)
            if rows == 0:
                rows = int(await con.fetchval("SELECT approximate_row_count('positions')") or 0)
            oldest = await con.fetchval("SELECT t FROM positions ORDER BY t LIMIT 1")
            chunks = int(
                await con.fetchval(
                    "SELECT count(*) FROM timescaledb_information.chunks "
                    "WHERE hypertable_name = 'positions'"
                )
                or 0
            )
            comp = await con.fetchrow(
                "SELECT number_compressed_chunks, "
                "coalesce(before_compression_total_bytes, 0) AS before_bytes, "
                "coalesce(after_compression_total_bytes, 0) AS after_bytes "
                "FROM hypertable_compression_stats('positions')"
            )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "history_pg: stats refresh failed (%s) against %s",
            type(exc).__name__,
            dsn_label(get_settings().history_pg_dsn),
        )
        return
    _stats = {
        "archive_bytes": size,
        "row_count": rows,
        "oldest_ts": _epoch(oldest) if oldest is not None else None,
        "chunks": chunks,
        "compressed_chunks": int((comp["number_compressed_chunks"] if comp else 0) or 0),
        "uncompressed_bytes": int((comp["before_bytes"] if comp else 0) or 0),
        "compressed_bytes": int((comp["after_bytes"] if comp else 0) or 0),
    }
    _stats_at = time.time()


def stats_snapshot() -> dict[str, Any]:
    """The last refreshed numbers, plus their age. Synchronous on purpose —
    see `refresh_stats`."""
    out: dict[str, Any] = {
        "archive_bytes": 0,
        "row_count": 0,
        "oldest_ts": None,
        "chunks": 0,
        "compressed_chunks": 0,
        "uncompressed_bytes": 0,
        "compressed_bytes": 0,
    }
    out.update(_stats)
    out["stats_age_s"] = None if _stats_at == 0.0 else round(time.time() - _stats_at, 1)
    return out


# ── test support ──────────────────────────────────────────────────────────────

_DB_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def dsn_for_database(dsn: str, database: str) -> str:
    """Same server, different database. Used by the pg test fixture to build a
    throwaway database's DSN without string surgery on the operator's."""
    if not _DB_NAME_RE.match(database):
        raise ValueError(f"unsafe database name: {database!r}")
    return urlsplit(dsn)._replace(path=f"/{database}").geturl()
