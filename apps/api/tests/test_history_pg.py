"""app.history on Postgres + TimescaleDB — against a REAL database.

Skipped unless ``HISTORY_PG_TEST_DSN`` points at a TimescaleDB the test user
can create a database on, so the default `pytest` run stays hermetic. CI sets
it from a `timescale` service container; locally:

    bash scripts/dev-timescale.sh
    HISTORY_PG_TEST_DSN=postgresql://velocity@127.0.0.1:5433/velocity \\
      OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api/tests/test_history_pg.py -q

Every test runs against a THROWAWAY database (``velocity_test_<pid>``) created
from that DSN and dropped at the end. The operator's own archive is never
opened: the DSN is used to reach the server, never as the database to write to.
A mock would prove nothing here — the whole point of the backend is what
TimescaleDB does with chunks, compression and a continuous aggregate.

These cases are the ones `test_history.py` pins for SQLite, ported: the round
trip both kinds, duplicate collapse, the bbox filter, by-id + series,
window_diff, timeseries buckets, coverage shape, retention, the byte budget.
The last two differ in KIND, not in contract — whole chunks are dropped instead
of rows deleted — and the tests say so.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from collections.abc import AsyncIterator, Iterator

import pytest

import app.history as H
from app import history_pg
from app.config import get_settings

_ADMIN_DSN = os.environ.get("HISTORY_PG_TEST_DSN", "").strip()

pytestmark = pytest.mark.skipif(
    not _ADMIN_DSN,
    reason="HISTORY_PG_TEST_DSN unset — the Timescale backend needs a real database",
)

_TEST_DB = f"velocity_test_{os.getpid()}"


def _test_dsn() -> str:
    return history_pg.dsn_for_database(_ADMIN_DSN, _TEST_DB)


async def _admin(sql: str) -> None:
    import asyncpg

    con = await asyncpg.connect(_ADMIN_DSN)
    try:
        await con.execute(sql)
    finally:
        await con.close()


@pytest.fixture(scope="module", autouse=True)
def _throwaway_database() -> Iterator[None]:
    """One scratch database per run, dropped afterwards.

    Module-scoped and synchronous: it must not share a loop with the per-test
    pool, and CREATE/DROP DATABASE cannot run inside a transaction.
    """
    if not _ADMIN_DSN:
        yield
        return
    asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{_TEST_DB}" WITH (FORCE)'))
    asyncio.run(_admin(f'CREATE DATABASE "{_TEST_DB}"'))
    try:
        yield
    finally:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{_TEST_DB}" WITH (FORCE)'))


@pytest.fixture(autouse=True)
def _timescale_env(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    """Point `history` at the scratch database for the duration of one test.

    `history.py` reads the cached `get_settings()`, so the cache is cleared on
    both edges. `intel/resolve` is pinned at a temp file too: `ingest_vessels`
    resolves a vessel on first sight, and that store is still SQLite — without
    this it would write the repo's real `data/` (which `test_history.py` has
    always done, and which the autouse history fixture in conftest does not
    cover).
    """
    from app.intel import resolve

    monkeypatch.setenv("HISTORY_BACKEND", "timescale")
    monkeypatch.setenv("HISTORY_PG_DSN", _test_dsn())
    get_settings.cache_clear()
    resolve.override_db_path(str(tmp_path / "resolve.db"))
    H._buffer.clear()
    H._last.clear()
    H._resolved_seen.clear()
    H._coverage_cache = None
    try:
        yield
    finally:
        resolve.override_db_path(None)
        H._buffer.clear()
        H._last.clear()
        H._coverage_cache = None
        monkeypatch.delenv("HISTORY_BACKEND", raising=False)
        monkeypatch.delenv("HISTORY_PG_DSN", raising=False)
        get_settings.cache_clear()


@pytest.fixture(autouse=True)
async def _clean_hypertable(_timescale_env: None) -> AsyncIterator[None]:
    """A pool belongs to the loop that created it and pytest-asyncio gives every
    test its own loop, so the pool is opened and closed per test — and the
    hypertable is emptied on the way in rather than on the way out, so a failing
    test leaves its rows behind to look at.

    It takes `_timescale_env` as an argument rather than relying on autouse
    ordering: pytest orders same-scope autouse fixtures by dependency, and
    without the edge this one can open the pool before the DSN is set.
    """
    pool = await history_pg._ensure_pool()
    await pool.execute("TRUNCATE positions")
    await _refresh_rollup(pool)
    try:
        yield
    finally:
        await history_pg.stop()


# ── helpers ───────────────────────────────────────────────────────────────────


def _aircraft(
    icao24: str,
    lon: float,
    lat: float,
    track: float = 0.0,
    ts: float | None = None,
    alt_m: float = 10_000.0,
) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "icao24": icao24,
            "track_deg": track,
            "callsign": f"CS{icao24.upper()}",
            "baro_alt_m": alt_m,
            "squawk": "7700",
            "category": "A3",
            "timestamp": ts or time.time(),
        },
    }


def _vessel(
    mmsi: str,
    lon: float,
    lat: float,
    cog: float = 45.0,
    ts: float | None = None,
    speed: float = 12.5,
) -> dict:
    return {
        "id": f"vessel:{mmsi}",
        "lon": lon,
        "lat": lat,
        "cog": cog,
        "name": f"Ship{mmsi}",
        "speed": speed,
        "timestamp": ts or time.time(),
    }


async def _refresh_rollup(pool) -> None:
    """Materialise `positions_hourly` now.

    The view is ``materialized_only = false``, so a reader already sees live
    rows without this — refreshing anyway means the tests exercise the
    MATERIALISED path too, which is the one a production read of an old window
    actually takes.
    """
    await pool.execute("CALL refresh_continuous_aggregate('positions_hourly', NULL, NULL)")


async def _flush() -> int:
    """Drain the shared RAM buffer through the Timescale flush, the way
    `_flush_loop` does, and make the rows visible to the hourly rollup."""
    rows = list(H._buffer)
    H._buffer.clear()
    written = await history_pg.flush_rows(rows)
    await _refresh_rollup(await history_pg._ensure_pool())
    return written


@contextlib.asynccontextmanager
async def _seeded(records: list[tuple]) -> AsyncIterator:
    """COPY raw records straight in, for cases that need a timestamp the
    recorder would never produce (days old, or side by side in one chunk)."""
    pool = await history_pg._ensure_pool()
    await pool.copy_records_to_table("positions", records=records, columns=history_pg._COLUMNS)
    yield pool


# ── schema ────────────────────────────────────────────────────────────────────


async def test_schema_applies_twice_without_error() -> None:
    """The backend re-applies the schema file on every boot, so applying it to
    a database that already has it must be a no-op — including the compression
    ALTER, which errors if it is re-issued once chunks are compressed."""
    pool = await history_pg._ensure_pool()
    async with pool.acquire() as con:
        await history_pg.apply_schema(con)
        await history_pg.apply_schema(con)
        assert (
            await con.fetchval(
                "SELECT compression_enabled FROM timescaledb_information.hypertables "
                "WHERE hypertable_name = 'positions'"
            )
            is True
        )


async def test_chunk_interval_and_compression_policy_follow_the_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The SQL file carries the DEFAULTS so psql can apply it by hand; the
    backend reconciles both knobs to the configured values afterwards, or an
    operator who changed a setting would silently keep the old one."""
    monkeypatch.setenv("HISTORY_PG_CHUNK_HOURS", "3")
    monkeypatch.setenv("HISTORY_PG_COMPRESS_AFTER_HOURS", "5")
    get_settings.cache_clear()
    pool = await history_pg._ensure_pool()
    async with pool.acquire() as con:
        await history_pg.apply_schema(con)
        interval = await con.fetchval(
            "SELECT time_interval FROM timescaledb_information.dimensions "
            "WHERE hypertable_name = 'positions'"
        )
        assert interval.total_seconds() == 3 * 3600
        after = await con.fetchval(
            "SELECT (config ->> 'compress_after')::interval "
            "FROM timescaledb_information.jobs "
            "WHERE proc_name = 'policy_compression' AND hypertable_name = 'positions'"
        )
        assert after.total_seconds() == 5 * 3600


# ── round trip ────────────────────────────────────────────────────────────────


async def test_ingest_flush_query_round_trip_both_kinds() -> None:
    """The archive's whole job: a fix goes in through the public ingest API and
    comes back out of the public query with its position, course and kind."""
    now = time.time()
    H.ingest_aircraft([_aircraft("abc123", lon=10.0, lat=55.0, track=90.0, ts=now)])
    H.ingest_vessels([_vessel("123456789", lon=25.0, lat=60.0, cog=45.0, ts=now)])
    assert len(H._buffer) == 2
    assert await _flush() == 2

    res = await H.query_tracks(kind="aircraft", bbox=None, t_from=now - 10, t_to=now + 10)
    assert [t["id"] for t in res["tracks"]] == ["aircraft:abc123"]
    lon, lat, t, track = res["tracks"][0]["points"][0]
    assert abs(lon - 10.0) < 1e-6
    assert abs(lat - 55.0) < 1e-6
    assert abs(track - 90.0) < 1e-6
    assert abs(t - now) < 1.0

    res = await H.query_tracks(kind="vessel", bbox=None, t_from=now - 10, t_to=now + 10)
    assert [t["id"] for t in res["tracks"]] == ["vessel:123456789"]
    assert res["tracks"][0]["kind"] == "vessel"


async def test_duplicate_observations_collapse() -> None:
    """The change-based dedup lives in the shared buffer, so it must still hold
    on this backend: an identical repeat is not a new observation."""
    now = time.time()
    for _ in range(5):
        H.ingest_aircraft([_aircraft("dupe01", lon=20.0, lat=60.0, ts=now)])
    assert len(H._buffer) == 1
    assert await _flush() == 1
    res = await H.query_tracks(kind=None, bbox=None, t_from=now - 10, t_to=now + 10)
    assert len(res["tracks"][0]["points"]) == 1

    # Movement of any size is still recorded.
    H.ingest_aircraft([_aircraft("dupe01", lon=20.05, lat=60.0, ts=now + 1)])
    assert await _flush() == 1
    res = await H.query_tracks(kind=None, bbox=None, t_from=now - 10, t_to=now + 10)
    assert len(res["tracks"][0]["points"]) == 2


async def test_bbox_filter_excludes_outside_and_keeps_the_edge() -> None:
    """Micro-degree rounding must not lose a contact sitting on the boundary:
    the stored value is round(lat * 1e6) and the box floors/ceils to match."""
    now = time.time()
    H.ingest_aircraft([_aircraft("insid1", lon=10.0, lat=52.0, ts=now)])
    H.ingest_aircraft([_aircraft("outsid", lon=-150.0, lat=30.0, ts=now)])
    H.ingest_aircraft([_aircraft("edge01", lon=30.0, lat=65.0, ts=now)])  # exactly the corner
    await _flush()

    res = await H.query_tracks(
        kind=None, bbox=(-10.0, 40.0, 30.0, 65.0), t_from=now - 10, t_to=now + 10
    )
    ids = {t["id"] for t in res["tracks"]}
    assert "aircraft:insid1" in ids
    assert "aircraft:edge01" in ids
    assert "aircraft:outsid" not in ids


async def test_track_by_id_and_series() -> None:
    """`?series=true` is what turns the archive into behaviour rather than a
    path. The keys are the ones the frontend already reads.

    Note the SQLite path's bug, fixed here: it reads ``extra["sog"]`` while
    `ingest_vessels` writes ``extra["speed"]``, so a vessel's speed series is
    null for every row there. Aircraft report ``sog: None`` on BOTH backends
    because `ingest_aircraft` records no speed at all.
    """
    now = time.time()
    for i in range(3):
        H.ingest_vessels([_vessel("987654321", lon=1.0 + i * 0.1, lat=2.0, ts=now + i, speed=12.5)])
        H.ingest_aircraft(
            [_aircraft("ser001", lon=3.0 + i * 0.1, lat=4.0, ts=now + i, alt_m=9500.0)]
        )
    await _flush()

    res = await H.query_track_by_id(
        "vessel:987654321", now - 10, now + 10, limit=100, include_series=True
    )
    assert len(res["tracks"]) == 1
    assert len(res["tracks"][0]["points"]) == 3
    series = res["series"]
    assert len(series) == 3
    assert all(abs(s["sog"] - 12.5) < 0.05 for s in series), series
    assert all(s["callsign"] == "Ship987654321" for s in series)

    res = await H.query_track_by_id(
        "aircraft:ser001", now - 10, now + 10, limit=100, include_series=True
    )
    assert res["series"][0]["alt_m"] == 9500
    assert res["series"][0]["sog"] is None, "no speed is recorded for aircraft — say so"
    assert res["series"][0]["callsign"] == "CSSER001"

    # An unknown id is an empty track, not an error.
    res = await H.query_track_by_id("aircraft:nobody", now - 10, now + 10, limit=100)
    assert res["tracks"][0]["points"] == []


async def test_window_diff_arrived_departed_stayed() -> None:
    """The question a stateless dashboard cannot answer at all."""
    now = time.time()
    bbox = (0.0, 0.0, 10.0, 10.0)
    a_at, b_at = now - 3600, now
    rows = []
    for entity, ts_list in (
        ("vessel:aaa", [a_at]),  # departed
        ("vessel:bbb", [a_at, b_at]),  # stayed
        ("vessel:ccc", [b_at]),  # arrived
    ):
        for ts in ts_list:
            rows.append(
                (
                    history_pg._ts(ts),
                    history_pg.KIND_VESSEL,
                    entity,
                    5_000_000,
                    5_000_000,
                    0,
                    None,
                    None,
                    None,
                    None,
                    None,
                    history_pg.SOURCE_LIVE,
                )
            )
    async with _seeded(rows):
        res = await H.window_diff("vessel", bbox, a_at - 60, a_at + 60, b_at - 60, b_at + 60)
    assert {r["id"] for r in res["arrived"]} == {"vessel:ccc"}
    assert {r["id"] for r in res["departed"]} == {"vessel:aaa"}
    assert {r["id"] for r in res["stayed"]} == {"vessel:bbb"}
    assert res["counts"] == {"a": 2, "b": 2, "arrived": 1, "departed": 1, "stayed": 1}
    assert res["recorded"] is True

    # An empty box says "nothing recorded", not "nothing changed".
    res = await H.window_diff(
        "vessel", (100.0, 60.0, 110.0, 70.0), a_at - 60, a_at + 60, b_at - 60, b_at + 60
    )
    assert res["recorded"] is False


async def test_timeseries_counts_distinct_ids_per_bucket() -> None:
    """Rows are not transits: a contact seen three times in a bucket is one
    contact. That is the whole reason the count is DISTINCT."""
    now = time.time()
    bucket = 300
    rows = [
        (
            history_pg._ts(now),
            history_pg.KIND_AIRCRAFT,
            "aircraft:a1",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now + 1),
            history_pg.KIND_AIRCRAFT,
            "aircraft:a1",
            50_000_001,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now),
            history_pg.KIND_AIRCRAFT,
            "aircraft:a2",
            51_000_000,
            6_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now - 400),
            history_pg.KIND_VESSEL,
            "vessel:v1",
            52_000_000,
            7_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
    ]
    async with _seeded(rows):
        res = await H.count_timeseries(bucket, now - 700, now + 10)
    assert res["bucket_sec"] == bucket
    cur = int(now // bucket) * bucket
    cur_b = next(b for b in res["buckets"] if b["t"] == cur)
    assert cur_b["aircraft"] == 2, "the repeated id collapses"
    assert sum(b["vessel"] for b in res["buckets"]) == 1


async def test_timeseries_hourly_bucket_reads_the_rollup() -> None:
    """A 1-hour bucket is served by the continuous aggregate, where `ids` is an
    exact per-bucket distinct count. Any other width goes to the raw table,
    because distinct counts do not sum across buckets."""
    now = time.time()
    rows = []
    for i in range(4):
        rows.append(
            (
                history_pg._ts(now - 60 - i),
                history_pg.KIND_AIRCRAFT,
                f"aircraft:h{i % 2}",
                50_000_000,
                5_000_000,
                0,
                None,
                None,
                None,
                None,
                None,
                0,
            )
        )
    async with _seeded(rows) as pool:
        await _refresh_rollup(pool)
        res = await H.count_timeseries(3600, now - 7200, now + 10)
    assert sum(b["aircraft"] for b in res["buckets"]) == 2, res["buckets"]


async def test_coverage_shape_and_totals() -> None:
    """Same contract as SQLite's coverage(): the documented keys, and bucket
    counts that sum to the row count for a window covering every row."""
    now = time.time()
    rows = [
        (
            history_pg._ts(now - 3600),
            history_pg.KIND_AIRCRAFT,
            "aircraft:cov1",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now - 7200),
            history_pg.KIND_AIRCRAFT,
            "aircraft:cov2",
            51_000_000,
            6_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now - 1800),
            history_pg.KIND_VESSEL,
            "vessel:cov1",
            52_000_000,
            7_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
    ]
    async with _seeded(rows) as pool:
        await _refresh_rollup(pool)
        res = await H.coverage(window_hours=24, bucket_hours=1)
    assert set(res) >= {"recording_since", "oldest_ts", "total_bytes", "row_count", "buckets"}
    assert res["row_count"] == 3
    assert res["oldest_ts"] == res["recording_since"]
    assert abs(res["oldest_ts"] - (now - 7200)) < 1.0
    assert res["total_bytes"] > 0, "hypertable_size must report the archive's real size"
    assert sum(b["count"] for b in res["buckets"]) == res["row_count"]


async def test_distinct_ids_per_bucket_in_a_box() -> None:
    """The chokepoint primitive: separate vessels crossing a box, not fixes."""
    now = time.time()
    rows = []
    for i in range(3):
        rows.append(
            (
                history_pg._ts(now + i),
                history_pg.KIND_VESSEL,
                f"vessel:c{i % 2}",
                5_000_000,
                5_000_000,
                0,
                None,
                None,
                None,
                None,
                None,
                0,
            )
        )
    async with _seeded(rows):
        out = await H.distinct_ids_per_bucket(
            "vessel", (0.0, 0.0, 10.0, 10.0), now - 10, now + 60, 600.0
        )
    assert out and out[0][1] == 2, out


# ── retention and budget ──────────────────────────────────────────────────────


async def _chunk_count() -> int:
    pool = await history_pg._ensure_pool()
    return int(
        await pool.fetchval(
            "SELECT count(*) FROM timescaledb_information.chunks "
            "WHERE hypertable_name = 'positions'"
        )
    )


async def test_prune_drops_old_chunks_and_keeps_recent_rows() -> None:
    """Retention here is `drop_chunks`, not DELETE + VACUUM — that machinery
    exists in the SQLite path to work around SQLite. Whole chunks go, so the
    archive keeps up to one chunk interval past the nominal window; the test
    puts the old rows days back so the boundary is not what it measures."""
    now = time.time()
    old = now - 10 * 86400
    rows = [
        (
            history_pg._ts(old),
            history_pg.KIND_AIRCRAFT,
            "aircraft:old001",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now),
            history_pg.KIND_AIRCRAFT,
            "aircraft:new001",
            50_100_000,
            5_100_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
    ]
    async with _seeded(rows):
        before = await _chunk_count()
        assert before >= 2, "the two rows must land in different chunks"
        dropped = await history_pg.prune(48)
        assert dropped >= 1

    res = await H.query_tracks(
        kind="aircraft", bbox=None, t_from=old - 10, t_to=now + 10, limit_ids=100
    )
    ids = {t["id"] for t in res["tracks"]}
    assert "aircraft:new001" in ids
    assert "aircraft:old001" not in ids


async def test_prune_zero_hours_is_a_no_op() -> None:
    now = time.time()
    rows = [
        (
            history_pg._ts(now),
            history_pg.KIND_AIRCRAFT,
            "aircraft:keep",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        )
    ]
    async with _seeded(rows):
        assert await history_pg.prune(0) == 0
        assert await _chunk_count() == 1


async def test_enforce_budget_drops_the_oldest_chunk_never_the_newest() -> None:
    """A byte cap below the archive drops whole oldest chunks until it fits,
    and stops at the last one rather than leaving the operator with nothing —
    the recorder is writing into it."""
    now = time.time()
    rows = []
    for day in range(4):
        ts = now - (4 - day) * 86400
        for i in range(200):
            rows.append(
                (
                    history_pg._ts(ts + i),
                    history_pg.KIND_AIRCRAFT,
                    f"aircraft:b{day}_{i}",
                    50_000_000 + i,
                    5_000_000 + i,
                    0,
                    10_000,
                    None,
                    "CS",
                    None,
                    None,
                    0,
                )
            )
    async with _seeded(rows):
        chunks_before = await _chunk_count()
        assert chunks_before >= 4
        size = await history_pg.hypertable_bytes()
        assert await history_pg.enforce_budget(0) == 0, "0 disables the cap"
        assert await history_pg.enforce_budget(size * 2) == 0, "a cap above size is a no-op"
        assert await history_pg.enforce_budget(size // 2) > 0

        assert await _chunk_count() < chunks_before
        newest = await H.query_tracks(
            kind="aircraft", bbox=None, t_from=now - 86400, t_to=now + 3600, limit_ids=500
        )
        assert newest["tracks"], "the newest chunk must survive the budget sweep"

        # A cap of one byte cannot empty the archive: it stops at the last chunk.
        await history_pg.enforce_budget(1)
        assert await _chunk_count() >= 1


async def test_maintenance_runs_both_halves_without_vacuum() -> None:
    """`history._maintenance_pass` calls this on the Timescale backend, and
    there is no VACUUM anywhere on the path."""
    now = time.time()
    rows = [
        (
            history_pg._ts(now - 10 * 86400),
            history_pg.KIND_AIRCRAFT,
            "aircraft:m1",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
        (
            history_pg._ts(now),
            history_pg.KIND_AIRCRAFT,
            "aircraft:m2",
            50_000_000,
            5_000_000,
            0,
            None,
            None,
            None,
            None,
            None,
            0,
        ),
    ]
    async with _seeded(rows):
        dropped = await history_pg.maintenance(48, 0)
        assert dropped >= 1


# ── stats ─────────────────────────────────────────────────────────────────────


async def test_stats_reports_the_timescale_backend() -> None:
    """`/api/history/stats` is a synchronous handler, so the numbers come from
    a snapshot the flush loop refreshes. It names the backend and reports the
    archive in hypertable bytes."""
    now = time.time()
    H.ingest_aircraft([_aircraft("stat01", lon=1.0, lat=2.0, ts=now)])
    await _flush()
    await history_pg.refresh_stats()

    st = H.stats()
    assert st["backend"] == "timescale"
    assert st["pg"].endswith(f"/{_TEST_DB}")
    assert st["row_count"] >= 1
    assert st["archive_bytes"] > 0
    assert st["chunks"] >= 1
    assert st["oldest_ts"] is not None and abs(st["oldest_ts"] - now) < 60
    assert st["stats_age_s"] is not None and st["stats_age_s"] < 30
    assert st["sharded"] is False
    assert _ADMIN_DSN not in repr(st)


async def test_a_dead_database_degrades_rather_than_raising(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The `degraded` flag is the difference between "the store failed" and "no
    data in this window" (issue #16). Point the backend at a port nothing is
    listening on and the reads must still answer."""
    await history_pg.stop()
    monkeypatch.setenv("HISTORY_PG_DSN", "postgresql://velocity@127.0.0.1:1/velocity")
    get_settings.cache_clear()
    now = time.time()
    res = await H.query_tracks(kind=None, bbox=None, t_from=now - 10, t_to=now + 10)
    assert res["tracks"] == []
    assert res["degraded"] is True
    cov = await H.coverage(window_hours=1, bucket_hours=1)
    assert cov["degraded"] is True
    # A flush against a dead database loses that batch and says so, but does
    # not raise into the recorder's event loop.
    H.ingest_aircraft([_aircraft("dead01", lon=1.0, lat=2.0, ts=now)])
    rows = list(H._buffer)
    H._buffer.clear()
    assert await history_pg.flush_rows(rows) == 0
    await history_pg.stop()


# ── flush resilience (W1-2) and pool lifecycle (W1-1) ───────────────────────


async def test_one_malformed_fix_skips_itself_not_the_batch(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """W1-2: one garbage upstream fix used to sink the whole 3 s COPY batch —
    asyncpg rejects the batch when a value overflows its column, and a field
    that cannot even convert escaped the executor entirely. Now the bad fixes
    skip themselves (counted, one log line per batch) and the good ones land."""
    now = time.time()
    extra = H._encode_extra({"callsign": "CSMAL1", "baro_alt_m": 10_000})
    # entity ids are namespaced the way `history.ingest_aircraft` buffers them.
    good = ("aircraft", "aircraft:mal001", now, 10.0, 52.0, 90.0, extra)
    wild_lat = ("aircraft", "aircraft:mal002", now, 10.0, 1e9, 90.0, extra)  # lat_e6 overflows int4
    broken_t = ("aircraft", "aircraft:mal003", "garbage", 10.0, 52.0, 90.0, extra)

    with caplog.at_level(logging.INFO, logger="app.history_pg"):
        written = await history_pg.flush_rows([good, wild_lat, broken_t])
    assert written == 1, "the good fix must survive its two malformed neighbours"

    pool = await history_pg._ensure_pool()
    assert (
        int(await pool.fetchval("SELECT count(*) FROM positions WHERE id = 'aircraft:mal001'")) == 1
    )
    assert (
        int(
            await pool.fetchval(
                "SELECT count(*) FROM positions WHERE id IN ('aircraft:mal002', 'aircraft:mal003')"
            )
        )
        == 0
    ), "the malformed fixes never reached the table"

    skips = [r.getMessage() for r in caplog.records if "flush skipped" in r.getMessage()]
    assert skips == ["history_pg: flush skipped 2/3 malformed fix(es)"]


async def test_failed_schema_apply_releases_its_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """W1-1: a schema apply that raises (a role that can connect but not own
    the hypertable) used to leak the pool it opened — the module global is
    installed only after a clean apply, so every retry of _ensure_pool
    opened a fresh connection set until Postgres masked the original error
    with 'too many clients'. Each failure must close what it opened."""
    import asyncpg

    await history_pg._ensure_pool()  # bring it up (schema applied), then tear down
    await history_pg.stop()

    async def _failing_apply(con):
        raise asyncpg.InsufficientPrivilegeError(
            "current user cannot execute add_compression_policy", "42501"
        )

    monkeypatch.setattr(history_pg, "apply_schema", _failing_apply)
    try:
        for attempt in range(1, 4):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await history_pg._ensure_pool()
            assert history_pg._pool is None, f"failed attempt {attempt} installed a pool"
        admin = await asyncpg.connect(_ADMIN_DSN)
        try:
            live = int(
                await admin.fetchval(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE application_name = 'velocity-history'"
                )
            )
        finally:
            await admin.close()
        assert live == 0, f"{live} velocity-history connection(s) leaked by failed applies"
    finally:
        monkeypatch.undo()
