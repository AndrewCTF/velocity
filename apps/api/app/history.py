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
import zlib
from pathlib import Path
from typing import Any

from app import memtier
from app.config import get_settings

log = logging.getLogger(__name__)


def _encode_extra(extra: dict[str, Any]) -> str | bytes:
    """Encode the per-fix ``extra`` blob for storage. With
    ``history_compress_extra`` on, zlib-compress the compact JSON (a pure density
    win — the column is write-only today, so there is no read path to update);
    otherwise store compact JSON text. A future reader must go through
    ``_decode_extra``."""
    raw = json.dumps(extra, separators=(",", ":"))
    if get_settings().history_compress_extra:
        return zlib.compress(raw.encode("utf-8"))
    return raw


def _decode_extra(value: Any) -> dict[str, Any]:
    """Inverse of ``_encode_extra``, tolerant of a mixed column (rows written
    before/after the flag flipped): a zlib blob is decompressed, plain text is
    parsed, anything undecodable degrades to ``{}`` — never crash a reader."""
    if value is None:
        return {}
    try:
        if isinstance(value, (bytes, bytearray)):
            return json.loads(zlib.decompress(bytes(value)).decode("utf-8"))
        return json.loads(str(value))
    except Exception:  # noqa: BLE001 — best-effort decode of a write-only blob
        return {}

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
# per-id last-buffered (t, lon, lat, track) — track is part of the key because a
# contact that turns without translating IS a new observation.
_last: collections.OrderedDict[str, tuple[float, float, float, float]] = (
    collections.OrderedDict()
)
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
# SQLite's compile-time SQLITE_MAX_ATTACHED default is 10, and `main` uses one
# of the slots. Keep a margin.
_MAX_ATTACHED: int = 8


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


# ── storage roots and daily shards ────────────────────────────────────────────
#
# One file on one disk was the whole storage story, and it produced three
# separate problems: an operator with a big spindle and a small SSD could not
# say where the archive lives; retention had to DELETE rows and VACUUM, which is
# what produced the 49.6 GB WAL runaway (docs/decisions.md, 2026-07-16); and the
# byte cap could only overshoot between hourly passes.
#
# Rolling daily shards fix all three at once. Each UTC day is its own plain
# SQLite file under one of OSINT_HISTORY_ROOTS; a new day opens in whichever
# root has the most free space; retention becomes os.remove(). Reads ATTACH the
# shards that overlap the window and expose a UNION ALL view named `positions`,
# so every existing query works unchanged.
#
# Sharding is OPT-IN: with no roots configured the single legacy file behaves
# exactly as before, so an existing install migrates when the operator asks and
# not before. When roots ARE set, a pre-existing legacy file is still read as
# one more shard, so no history is stranded.


def _roots() -> list[Path]:
    """Configured storage roots, in order. Empty when unset (legacy mode)."""
    raw = (get_settings().history_roots or "").strip()
    if not raw:
        return []
    return [Path(p.strip()).expanduser() for p in raw.split(",") if p.strip()]


def sharded() -> bool:
    """True when the operator has chosen one or more storage roots.

    ``override_db_path`` deliberately does NOT disable this — it overrides where
    the *legacy* file is, which is what lets a test exercise sharding without
    the real ``./data/history.db`` joining the union as a shard.
    """
    return bool(_roots())


def _shard_day(t: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t))


def _shard_dir(root: Path) -> Path:
    return root / "history"


def _free_bytes(path: Path) -> int:
    try:
        path.mkdir(parents=True, exist_ok=True)
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize
    except OSError:
        return 0


def _shard_path_for(t: float) -> Path:
    """Where the shard covering *t* lives.

    If a shard for that day already exists in any root, that one wins — a root
    list reordered between boots must never split one day across two files.
    Otherwise it opens in the root with the most free space, which is what makes
    "no single-disk assumption" true rather than merely configurable.
    """
    day = _shard_day(t)
    roots = _roots()
    for root in roots:
        candidate = _shard_dir(root) / f"{day}.db"
        if candidate.exists():
            return candidate
    best = max(roots, key=_free_bytes)
    _shard_dir(best).mkdir(parents=True, exist_ok=True)
    return _shard_dir(best) / f"{day}.db"


def _all_shards() -> list[tuple[str, Path]]:
    """Every shard we can read, oldest first, as (day, path).

    A legacy single-file archive is included under the sentinel day "legacy" and
    sorts first, so switching an existing install to roots keeps its history
    queryable instead of silently hiding it.
    """
    out: list[tuple[str, Path]] = []
    legacy = Path(_resolved_db_path())
    if legacy.exists():
        out.append(("legacy", legacy))
    for root in _roots():
        d = _shard_dir(root)
        if not d.is_dir():
            continue
        for f in d.glob("*.db"):
            out.append((f.stem, f))
    out.sort(key=lambda p: ("" if p[0] == "legacy" else p[0]))
    return out


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


def _connect(path: str | None = None) -> sqlite3.Connection:
    """Open the WRITE connection: the legacy file, or today's shard when roots
    are configured. Pass *path* to open one specific shard."""
    if path is None:
        path = str(_shard_path_for(time.time())) if sharded() else _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    # auto_vacuum only takes on a FRESH db (or after a full VACUUM), and must be
    # set before the first table is created — so issue it here, ahead of the
    # CREATE TABLE below. On an existing store it is a no-op until the next full
    # VACUUM converts it; the maintenance pass falls back to full VACUUM then.
    if get_settings().history_incremental_vacuum:
        con.execute("PRAGMA auto_vacuum=INCREMENTAL")
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


def _read_connect() -> sqlite3.Connection:
    """Open a READ connection spanning every shard.

    In legacy mode this is just ``_connect()``. When sharded, it opens the
    newest shard as ``main``, ATTACHes the rest, and replaces ``positions`` with
    a UNION ALL view over all of them — so every query in this module keeps
    working against the name ``positions`` and none of them had to learn about
    shards.

    SQLite's default attach limit is 10, so the newest ``_MAX_ATTACHED`` shards
    are used and older ones are skipped. That is a real bound: it is logged, not
    silent, because a coverage answer that quietly omits half the archive is
    worse than a slow one.
    """
    if not sharded():
        return _connect()
    shards = _all_shards()
    if not shards:
        return _connect()
    newest = shards[-1]
    older = shards[:-1]
    if len(older) > _MAX_ATTACHED:
        dropped = len(older) - _MAX_ATTACHED
        log.warning(
            "history: %d shard(s) older than %s are outside this read "
            "(attach limit %d) — raise HISTORY_ROOTS consolidation or query a "
            "narrower window",
            dropped, older[dropped][0], _MAX_ATTACHED,
        )
        older = older[-_MAX_ATTACHED:]
    con = _connect(str(newest[1]))
    names = ["main"]
    for i, (_day, path) in enumerate(older):
        alias = f"s{i}"
        try:
            con.execute("ATTACH DATABASE ? AS " + alias, (str(path),))
            # A shard written by an older build, or a half-created file, must not
            # take the whole read down with it.
            con.execute(f"SELECT 1 FROM {alias}.positions LIMIT 1")
            names.append(alias)
        except sqlite3.Error:
            log.warning("history: skipping unreadable shard %s", path)
    if len(names) > 1:
        union = " UNION ALL ".join(f"SELECT * FROM {n}.positions" for n in names)
        con.execute(f"CREATE TEMP VIEW positions AS {union}")
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
    """Buffer a fix unless it is the same observation we already stored.

    CHANGE-based, not time-based (2026-07-28). The old rule dropped anything that
    arrived within ``_RATE_LIMIT_SECS`` (5.0) and had moved less than
    ``_RATE_LIMIT_DEG`` (0.01, about 1.1 km). At the 1 Hz snapshot tick that
    discarded roughly four fixes in five for any slow or moored contact — a
    moored vessel got one row every five seconds no matter how many times it was
    observed, and its dwell was recorded at a fifth of the fidelity it was seen
    at. That is the "the data is not complete, you cut a lot of it just to save
    usage" report, and it was a default, not a law.

    The rule now: record a fix when it DIFFERS from the last one stored for that
    id, skip it when it is identical. A contact that has not moved between polls
    is not a new observation and costs nothing; a contact that has moved by any
    amount is recorded at the rate it was seen. Cost therefore tracks how much
    the world actually moves rather than a clock.

    ``history_min_interval_s`` / ``history_min_move_deg`` restore the old
    behaviour for an operator who wants to trade completeness for disk — both
    default to 0, so the trade is opt-in rather than the default.
    """
    global _buffer, _last

    prev = _last.get(entity_id)
    if prev is not None:
        prev_t, prev_lon, prev_lat, prev_track = prev
        # Identical observation → nothing new happened. This is the only
        # unconditional skip, and it drops no information at all.
        if lon == prev_lon and lat == prev_lat and track == prev_track:
            return
        settings = get_settings()
        min_dt = settings.history_min_interval_s
        min_deg = settings.history_min_move_deg
        if min_dt > 0.0 or min_deg > 0.0:
            if (t - prev_t) < min_dt and abs(lat - prev_lat) < min_deg \
                    and abs(lon - prev_lon) < min_deg:
                return  # operator opted into sampling

    # FIFO-evict oldest id if we've hit the cap
    if len(_last) >= _MAX_BUFFERED_IDS and entity_id not in _last:
        _last.popitem(last=False)

    _last[entity_id] = (t, lon, lat, track)
    _buffer.append((kind, entity_id, t, lon, lat, track, _encode_extra(extra)))


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
    # An explicit archive budget wins over everything, in either profile. Sizing
    # the archive to *free RAM* (the default branch below, 5 % of MemAvailable
    # clamped to <=2 GB) is what silently shrank history on a memory-tight box:
    # the operator asked for days of replay and got 64 MiB because something else
    # was using the machine. Disk is what an archive costs; RAM is not.
    if settings.history_budget_gb > 0:
        return int(settings.history_budget_gb * 1024**3)
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
    deleted = 0
    # Tiered resolution (opt-in): thin OLD data first so the byte cap then bounds a
    # denser, coarser tail rather than dropping whole recent slices.
    if settings.history_decimate_after_hours > 0:
        deleted += await loop.run_in_executor(
            None,
            decimate,
            settings.history_decimate_after_hours,
            max(2, settings.history_decimate_stride),
        )
    deleted += await loop.run_in_executor(None, prune, hours)
    if sharded():
        # Exact, and free: a whole day's file is unlinked rather than its rows
        # deleted, so there is nothing left to VACUUM and no overshoot between
        # passes (the old estimator ran a 2 GB cap up to a measured 4-5 GB).
        deleted += await loop.run_in_executor(None, enforce_budget, size_cap)
    else:
        deleted += await loop.run_in_executor(None, enforce_size_cap, size_cap)
    if deleted:
        # Archive mode skips the full-file VACUUM here on purpose: at archive
        # scale (tens-to-hundreds of GB) a full VACUUM can stall the writer for
        # minutes, and the archive is byte-budget-capped anyway (enforce_size_cap
        # already ran above), so reclaiming disk space isn't needed until the
        # configured budget is hit.
        if not settings.archive_mode:
            await loop.run_in_executor(None, _reclaim)
        log.info(
            "history: pruned %d rows (>%dh / >%d bytes)%s",
            deleted,
            hours,
            size_cap,
            "" if settings.archive_mode else ", reclaimed",
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
        con = _read_connect()
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


def _query_by_id_sync(
    entity_id: str,
    t_from: float,
    t_to: float,
    limit: int,
    include_series: bool = False,
) -> dict[str, Any]:
    """Execute a single-id range scan via idx_id_t. Called via run_in_executor."""
    try:
        con = _read_connect()
        rows = con.execute(
            "SELECT t, lon, lat, track, extra FROM positions "
            "WHERE id = ? AND t BETWEEN ? AND ? ORDER BY t LIMIT ?",
            (entity_id, t_from, t_to, limit),
        ).fetchall()
        con.close()
    except Exception as exc:  # noqa: BLE001
        # Same degraded-vs-empty distinction as _query_sync (issue #16).
        log.exception("history: query-by-id error")
        return {"tracks": [], "degraded": True, "error": f"{type(exc).__name__}"}

    kind = entity_id.split(":", 1)[0] if ":" in entity_id else ""
    points = [[lon, lat, t, track] for t, lon, lat, track, _extra in rows]
    out: dict[str, Any] = {"tracks": [{"id": entity_id, "kind": kind, "points": points}]}
    if include_series:
        # The archive has been carrying altitude and speed in `extra` since
        # ingest, and this query threw them away. Surfacing them is what turns a
        # sparkline from "whatever this browser tab happened to observe since it
        # was opened" into "what the archive actually holds" - the difference
        # between a position and a behaviour, and the whole reason owning the
        # history is worth anything.
        #
        # Emitted as a parallel array rather than widening `points`, because
        # several callers index that shape positionally.
        series: list[dict[str, Any]] = []
        for t, _lon, _lat, _track, extra in rows:
            e = _decode_extra(extra)
            series.append(
                {
                    "t": float(t),
                    "alt_m": e.get("baro_alt_m"),
                    "sog": e.get("sog"),
                    "callsign": e.get("callsign"),
                }
            )
        out["series"] = series
    return out


async def query_track_by_id(
    entity_id: str,
    t_from: float,
    t_to: float,
    limit: int = 5000,
    include_series: bool = False,
) -> dict[str, Any]:
    """Return the single track for *entity_id* (e.g. ``aircraft:af351f``) in the
    given time window — the identity-scoped counterpart to ``query_tracks``'s
    bbox+time scan, answering "where was this tail/MMSI on date X" directly off
    the ``idx_id_t`` index instead of a full-window bbox scan.

    Returns the same shape as ``query_tracks`` (a ``tracks`` list), but always
    with at most one entry, so callers can share a renderer.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _query_by_id_sync, entity_id, t_from, t_to, limit, include_series
    )


# ── metrics-over-time (§8) ──────────────────────────────────────────────────

def _timeseries_sync(bucket_sec: int, t_from: float, t_to: float) -> dict[str, Any]:
    """Distinct contact counts per time bucket, split by kind. Real observed data
    from the position store — the source of the Metrics 'over time' trend."""
    try:
        con = _read_connect()
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
    real-data source for the replay bar's ownership chip and heat-strip.

    ``oldest_ts`` is the same value as ``recording_since`` (global ``MIN(t)``
    over ``positions``) under an unambiguous name: "recording_since" reads
    like a fixed deployment date, but it is recomputed on every scan and
    marches forward whenever the byte cap or hour-window prune drops the
    oldest rows — it IS the effective retention floor, not when the app was
    first started. ``oldest_ts`` is the name callers (the scrubber's "history
    available from" copy) should reach for; ``recording_since`` stays for
    back-compat with existing consumers.

    Cost: this is a single indexed lookup, not a table scan — ``EXPLAIN QUERY
    PLAN`` on the live ~2 GB / ~10-19M-row dev archive reports ``SEARCH
    positions USING COVERING INDEX idx_t`` (idx_t is created in _connect()
    above) and measures <1 ms. It rides the same connection this function
    already opens for row_count/buckets, so exposing it under a second key
    costs nothing extra — no additional query, no additional scan.
    """
    path = _resolved_db_path()
    try:
        total_bytes = os.path.getsize(path)
    except OSError:
        total_bytes = 0
    try:
        con = _read_connect()
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
            "recording_since": None, "oldest_ts": None, "total_bytes": total_bytes,
            "row_count": 0, "buckets": [], "degraded": True,
            "error": f"{type(exc).__name__}",
        }
    return {
        "recording_since": recording_since,
        "oldest_ts": recording_since,
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

def _drop_shard(path: Path) -> None:
    """Remove a shard and its WAL/SHM siblings. This is what makes sharded
    retention free: no DELETE, no VACUUM, no WAL amplification, and the space is
    returned to the filesystem immediately instead of at the next vacuum."""
    for suffix in ("", "-wal", "-shm"):
        try:
            Path(str(path) + suffix).unlink(missing_ok=True)
        except OSError:
            log.warning("history: could not remove %s%s", path, suffix)


def prune(retention_hours: int) -> int:
    """Delete rows older than *retention_hours* ago. Returns the deleted count.

    Sharded: whole days that end before the cutoff are unlinked, and only the
    day the cutoff falls inside is row-deleted. Legacy: unchanged row delete.
    """
    cutoff = time.time() - retention_hours * 3600
    try:
        if sharded():
            deleted = 0
            cutoff_day = _shard_day(cutoff)
            for day, path in _all_shards():
                if day == "legacy":
                    continue
                if day < cutoff_day:
                    _drop_shard(path)
                    deleted += 1  # counted in shards, see the log line below
                elif day == cutoff_day:
                    con = _connect(str(path))
                    con.execute("DELETE FROM positions WHERE t < ?", (cutoff,))
                    con.commit()
                    con.close()
            if deleted:
                log.info("history: dropped %d shard(s) older than %s", deleted, cutoff_day)
            return deleted
        con = _connect()
        cur = con.execute("DELETE FROM positions WHERE t < ?", (cutoff,))
        deleted = cur.rowcount
        con.commit()
        con.close()
        return deleted
    except Exception:  # noqa: BLE001
        log.exception("history: prune error")
        return 0


def archive_bytes() -> int:
    """Total bytes on disk across every shard (plus the legacy file)."""
    total = 0
    for _day, path in _all_shards():
        for suffix in ("", "-wal"):
            try:
                total += Path(str(path) + suffix).stat().st_size
            except OSError:
                pass
    return total


def enforce_budget(max_bytes: int) -> int:
    """Sharded byte cap: drop whole oldest shards until the archive fits.

    Exact rather than an overshoot — the old path estimated a row fraction from
    the byte overage and corrected on the next hourly pass, which is how a 2 GB
    cap became a measured 4-5 GB between passes. Today's shard is never dropped:
    the recorder is writing into it, and an operator whose budget is smaller than
    one day of data should be told, not silently left with an empty archive.
    """
    if max_bytes <= 0:
        return 0
    dropped = 0
    today = _shard_day(time.time())
    # Never unlink today's shard (the recorder is writing to it) and never
    # unlink the legacy file. The legacy file is a path the OPERATOR configured
    # directly and may hold their entire pre-sharding archive; a budget sweep
    # that deletes it would destroy history we only ever promised to read.
    # It is reported in archive_bytes() so the budget still accounts for it.
    shards = [s for s in _all_shards() if s[0] != today and s[0] != "legacy"]
    while archive_bytes() > max_bytes and shards:
        day, path = shards.pop(0)
        _drop_shard(path)
        dropped += 1
        log.info("history: dropped shard %s to stay under the %d-byte budget", day, max_bytes)
    if archive_bytes() > max_bytes and not shards:
        log.warning(
            "history: archive is %d bytes, over the %d-byte budget, and only "
            "today's shard is left — raise HISTORY_BUDGET_GB or add a root to "
            "HISTORY_ROOTS. Nothing has been thinned.",
            archive_bytes(), max_bytes,
        )
    return dropped


def decimate(after_hours: int, stride: int) -> int:
    """Thin each track OLDER than *after_hours* to one fix in every *stride*,
    deleting the rest; recent data (within the window) is untouched. Kept fixes
    are evenly spaced along each track and always include the segment's first fix,
    so a short old track keeps at least one point rather than vanishing. Returns
    the deleted row count. Tiered resolution: far more time-span fits the byte
    cap at the cost of old-data precision."""
    if after_hours <= 0 or stride < 2:
        return 0
    cutoff = time.time() - after_hours * 3600
    try:
        con = _connect()
        try:
            cur = con.execute(
                "DELETE FROM positions WHERE rowid IN ("
                "  SELECT rowid FROM ("
                "    SELECT rowid, ROW_NUMBER() OVER (PARTITION BY id ORDER BY t) AS rn"
                "    FROM positions WHERE t < ?"
                "  ) WHERE rn % ? != 1"
                ")",
                (cutoff, stride),
            )
            deleted = cur.rowcount
            con.commit()
            return deleted
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: decimate error")
        return 0


def enforce_size_cap(max_bytes: int) -> int:
    """Drop the oldest rows until the DB's IN-USE size is under *max_bytes*.

    Sizing off ``os.path.getsize`` would over-delete: a bare DELETE (this pass
    runs right after ``prune``) leaves reclaimable free pages that the on-disk
    file still counts because auto_vacuum is off, and the caller VACUUMs
    immediately afterwards. We would then drop an extra oldest slice that the
    VACUUM was about to hand back for free — chronically shortening the replay
    window. So measure in-use bytes (page_count - freelist_count) * page_size,
    which is what the file becomes after the VACUUM.

    The size only shrinks on VACUUM, so we cannot delete-and-measure in a loop.
    Instead we estimate the fraction of rows to drop from the byte overage (with
    a 10 % margin) and delete that oldest slice in one pass; the next hourly pass
    corrects any residue. Returns the deleted row count. max_bytes 0 disables it.
    """
    if max_bytes <= 0:
        return 0
    try:
        con = _connect()
        try:
            page_size = con.execute("PRAGMA page_size").fetchone()[0]
            page_count = con.execute("PRAGMA page_count").fetchone()[0]
            freelist = con.execute("PRAGMA freelist_count").fetchone()[0]
            in_use = (page_count - freelist) * page_size
            if in_use <= max_bytes:
                return 0
            total = con.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
            if total <= 0:
                return 0
            over_frac = 1.0 - (max_bytes / in_use)
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


def _reclaim() -> None:
    """Return freed pages to the filesystem. In INCREMENTAL auto_vacuum mode
    (history_incremental_vacuum, once the store was created/converted that way) a
    PRAGMA incremental_vacuum reclaims the freelist cheaply without the full-file
    rewrite; otherwise fall back to a full VACUUM. A bare DELETE alone leaves the
    file at its high-water mark (the "10 GB history.db" bug)."""
    if not get_settings().history_incremental_vacuum:
        _vacuum()
        return
    try:
        con = _connect()
        try:
            # 2 == INCREMENTAL. An existing non-auto_vacuum store reports 0 until a
            # full VACUUM converts it, so do that once and let the next pass go
            # incremental.
            mode = con.execute("PRAGMA auto_vacuum").fetchone()[0]
            if mode == 2:
                con.execute("PRAGMA incremental_vacuum")
                con.commit()
            else:
                con.execute("VACUUM")
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        log.exception("history: reclaim error")


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
    # Report where writes ACTUALLY land. Logging the legacy path while sharded
    # sends an operator to the wrong file when they go looking for their archive.
    if sharded():
        log.info(
            "history: started (sharded, roots=%s, active=%s)",
            ",".join(str(r) for r in _roots()),
            _shard_path_for(time.time()),
        )
    else:
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
        # Storage layout, so an operator can see WHERE their archive is and how
        # much of the budget it is using without reading the source.
        "sharded": sharded(),
        "roots": [str(r) for r in _roots()],
        "shards": [{"day": d, "path": str(p)} for d, p in _all_shards()],
        "archive_bytes": archive_bytes(),
        "budget_bytes": _size_cap_bytes(settings),
        # Completeness: 0/0 means every distinct observation is recorded.
        "min_interval_s": settings.history_min_interval_s,
        "min_move_deg": settings.history_min_move_deg,
    }


def _distinct_ids_per_bucket_sync(
    kind: str,
    bbox: tuple[float, float, float, float],
    t_from: float,
    t_to: float,
    bucket_sec: float,
) -> list[tuple[float, int]]:
    """Distinct entity ids seen inside `bbox`, bucketed by time.

    The counting primitive behind a chokepoint answer: "how many separate
    vessels crossed this box today, and how does that compare with a normal
    day". Counting DISTINCT ids rather than rows is the whole point - a ship
    that sits in the strait for six hours contributes many position rows and one
    transit, and rows would make a traffic jam look like heavy traffic.

    Buckets are half-open [start, start + bucket_sec) anchored at `t_from`, so
    the caller controls the day boundary rather than inheriting UTC midnight.
    """
    try:
        con = _read_connect()
        rows = con.execute(
            """
            SELECT CAST((t - ?) / ? AS INTEGER) AS bucket, COUNT(DISTINCT id)
            FROM positions
            WHERE kind = ? AND t >= ? AND t < ?
              AND lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?
            GROUP BY bucket ORDER BY bucket
            """,
            (
                t_from,
                bucket_sec,
                kind,
                t_from,
                t_to,
                bbox[0],
                bbox[2],
                bbox[1],
                bbox[3],
            ),
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return []
    return [(t_from + int(b) * bucket_sec, int(n)) for b, n in rows]


async def distinct_ids_per_bucket(
    kind: str,
    bbox: tuple[float, float, float, float],
    t_from: float,
    t_to: float,
    bucket_sec: float,
) -> list[tuple[float, int]]:
    """Async wrapper for `_distinct_ids_per_bucket_sync`."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _distinct_ids_per_bucket_sync, kind, bbox, t_from, t_to, bucket_sec
    )


def _ids_in_window_sync(
    kind: str | None,
    bbox: tuple[float, float, float, float],
    t_from: float,
    t_to: float,
) -> dict[str, tuple[float, float, float]]:
    """Entity ids present in `bbox` during [t_from, t_to], with their last fix.

    Returns ``{id: (t, lon, lat)}`` for the newest position each id had inside
    the box and window, which is what a diff needs to say where something was
    when it was last seen there.
    """
    try:
        con = _read_connect()
        params: list[Any] = [t_from, t_to, bbox[0], bbox[2], bbox[1], bbox[3]]
        where = "t >= ? AND t <= ? AND lon >= ? AND lon <= ? AND lat >= ? AND lat <= ?"
        if kind:
            where += " AND kind = ?"
            params.append(kind)
        rows = con.execute(
            f"SELECT id, t, lon, lat FROM positions WHERE {where} ORDER BY id, t",
            params,
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return {}
    out: dict[str, tuple[float, float, float]] = {}
    for rid, t, lon, lat in rows:
        out[str(rid)] = (float(t), float(lon), float(lat))  # ORDER BY t → last wins
    return out


async def window_diff(
    kind: str | None,
    bbox: tuple[float, float, float, float],
    a_from: float,
    a_to: float,
    b_from: float,
    b_to: float,
    limit: int = 500,
) -> dict[str, Any]:
    """What changed in this box between two time windows.

    The question a stateless dashboard cannot answer at all, and the reason
    owning history is the defensible thing here rather than another live layer.
    Everything else in this category renders the current instant and has no way
    to tell you that the four vessels anchored off a terminal this morning are a
    different four to the ones there last week.

    Compares the SET OF IDS present in each window:

      arrived   in B, not in A
      departed  in A, not in B
      stayed    in both

    Windows rather than instants because a position is a sample, not a
    continuous truth: asking "who was at 14:00:00" against a store that records
    a fix every few seconds would answer "nobody" most of the time.
    """
    loop = asyncio.get_running_loop()
    a = await loop.run_in_executor(None, _ids_in_window_sync, kind, bbox, a_from, a_to)
    b = await loop.run_in_executor(None, _ids_in_window_sync, kind, bbox, b_from, b_to)

    a_ids, b_ids = set(a), set(b)

    def _rows(ids: set[str], src: dict[str, tuple[float, float, float]]) -> list[dict[str, Any]]:
        # Newest first: the most recently seen contact is the one an operator
        # wants at the top of a change list.
        ordered = sorted(ids, key=lambda i: src[i][0], reverse=True)[:limit]
        return [
            {"id": i, "t": src[i][0], "lon": src[i][1], "lat": src[i][2]} for i in ordered
        ]

    arrived = b_ids - a_ids
    departed = a_ids - b_ids
    stayed = a_ids & b_ids
    return {
        "bbox": list(bbox),
        "kind": kind,
        "window_a": [a_from, a_to],
        "window_b": [b_from, b_to],
        "counts": {
            "a": len(a_ids),
            "b": len(b_ids),
            "arrived": len(arrived),
            "departed": len(departed),
            "stayed": len(stayed),
        },
        "arrived": _rows(arrived, b),
        "departed": _rows(departed, a),
        "stayed": _rows(stayed, b),
        # An empty store and "nothing changed" look identical in the counts, so
        # say which it was. Silent emptiness is the failure mode this whole wave
        # is pushing back on.
        "recorded": bool(a_ids or b_ids),
    }
