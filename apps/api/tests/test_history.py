"""Tests for app.history — no network, uses a tmp SQLite DB."""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import app.history as H
from app import memtier
from app.config import get_settings


@contextlib.contextmanager
def _retention_env(
    monkeypatch: pytest.MonkeyPatch, *, hours: int, max_hours: int
) -> Iterator[None]:
    """Override the retention settings via env + clear the cached singleton.

    Mirrors the test_adsb_feeds.py pattern (setenv + get_settings.cache_clear);
    history.py reads the cached module-level get_settings(), so we must clear it
    so the new values take effect, and clear again on exit to not leak into the
    next test's settings.
    """
    monkeypatch.setenv("HISTORY_RETENTION_HOURS", str(hours))
    monkeypatch.setenv("HISTORY_RETENTION_MAX_HOURS", str(max_hours))
    get_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.delenv("HISTORY_RETENTION_HOURS", raising=False)
        monkeypatch.delenv("HISTORY_RETENTION_MAX_HOURS", raising=False)
        get_settings.cache_clear()


@contextlib.contextmanager
def _archive_env(
    monkeypatch: pytest.MonkeyPatch,
    *,
    archive_mode: bool,
    disk_budget_gb: float | None = None,
    retention_hours: int | None = None,
) -> Iterator[None]:
    """Override the archive-profile settings via env + clear the cached singleton.

    Mirrors _retention_env's pattern above — history.py reads the cached
    module-level get_settings(), so it must be cleared for env changes to take
    effect, and cleared again on exit to not leak into the next test.
    """
    monkeypatch.setenv("ARCHIVE_MODE", "1" if archive_mode else "0")
    if disk_budget_gb is not None:
        monkeypatch.setenv("HISTORY_DISK_BUDGET_GB", str(disk_budget_gb))
    if retention_hours is not None:
        monkeypatch.setenv("HISTORY_RETENTION_HOURS", str(retention_hours))
    get_settings.cache_clear()
    try:
        yield
    finally:
        monkeypatch.delenv("ARCHIVE_MODE", raising=False)
        monkeypatch.delenv("HISTORY_DISK_BUDGET_GB", raising=False)
        monkeypatch.delenv("HISTORY_RETENTION_HOURS", raising=False)
        get_settings.cache_clear()

# ── helpers ────────────────────────────────────────────────────────────────────

def _make_aircraft_feature(
    icao24: str,
    lon: float,
    lat: float,
    track: float = 0.0,
    ts: float | None = None,
) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "icao24": icao24,
            "track_deg": track,
            "callsign": f"CS{icao24.upper()}",
            "baro_alt_m": 10_000.0,
            "timestamp": ts or time.time(),
        },
    }


def _make_vessel_row(
    mmsi: str,
    lon: float,
    lat: float,
    cog: float = 45.0,
    ts: float | None = None,
) -> dict:
    return {
        "id": f"vessel:{mmsi}",
        "lon": lon,
        "lat": lat,
        "cog": cog,
        "name": f"Ship{mmsi}",
        "timestamp": ts or time.time(),
    }


def _reset_module(tmp_db: str) -> None:
    """Reset all module-level state and point at a fresh tmp DB."""
    H._buffer.clear()
    H._last.clear()
    H._rows_written = 0
    H._flush_task = None
    H._coverage_cache = None
    H.override_db_path(tmp_db)


async def _seed_past_cap(db: str) -> int:
    """Reset the module against *db*, write 200 rows spanning ~200 s, flush, and
    return the resulting file size — a baseline other tests use to pick a cap
    small enough to force enforce_size_cap to actually drop rows."""
    _reset_module(db)
    now = time.time()
    for i in range(200):
        H._buffer.append(
            ("aircraft", f"aircraft:v{i}", now - (200 - i), float(i % 90), 50.0, 0.0, "{}")
        )
    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)
    return await loop.run_in_executor(None, os.path.getsize, db)


# ── tests ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ingest_flush_query_returns_track(tmp_path: pytest.TempPathFactory) -> None:
    """Ingest an aircraft fix, flush it, query it back — should yield one track."""
    db = str(tmp_path / "hist.db")
    _reset_module(db)

    now = time.time()
    feat = _make_aircraft_feature("abc123", lon=10.0, lat=55.0, track=90.0, ts=now)
    H.ingest_aircraft([feat])

    assert len(H._buffer) == 1, "fix must land in the buffer"

    # Flush synchronously (bypass the async background task)
    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    written = await loop.run_in_executor(None, H._flush_sync, rows)
    H._rows_written += written

    result = await H.query_tracks(
        kind="aircraft",
        bbox=None,
        t_from=now - 10,
        t_to=now + 10,
    )
    tracks = result["tracks"]
    assert len(tracks) == 1
    assert tracks[0]["id"] == "aircraft:abc123"
    assert tracks[0]["kind"] == "aircraft"
    pts = tracks[0]["points"]
    assert len(pts) == 1
    lon, lat, t, track = pts[0]
    assert abs(lon - 10.0) < 1e-6
    assert abs(lat - 55.0) < 1e-6
    assert abs(track - 90.0) < 1e-6


@pytest.mark.asyncio
async def test_rate_limit_collapses_rapid_duplicates(tmp_path: pytest.TempPathFactory) -> None:
    """Rapid duplicate fixes (same id, within 5 s, < 0.01 deg) collapse to one."""
    db = str(tmp_path / "hist2.db")
    _reset_module(db)

    now = time.time()
    # Send 5 fixes within the rate-limit window for the same id and same position
    for _ in range(5):
        feat = _make_aircraft_feature("dupe01", lon=20.0, lat=60.0, ts=now)
        H.ingest_aircraft([feat])

    # Only the first should be in the buffer
    assert len(H._buffer) == 1, "rate-limit must collapse rapid dupes to a single sample"


@pytest.mark.asyncio
async def test_rate_limit_allows_movement(tmp_path: pytest.TempPathFactory) -> None:
    """A fix that moves > 0.01 deg is written even if within the 5 s window."""
    db = str(tmp_path / "hist3.db")
    _reset_module(db)

    now = time.time()
    H.ingest_aircraft([_make_aircraft_feature("mover", lon=0.0, lat=0.0, ts=now)])
    # Move 0.05 deg (>> threshold) within the rate-limit window
    H.ingest_aircraft([_make_aircraft_feature("mover", lon=0.05, lat=0.0, ts=now + 1)])

    assert len(H._buffer) == 2, "movement > threshold must bypass rate-limit"


@pytest.mark.asyncio
async def test_prune_removes_old_rows(tmp_path: pytest.TempPathFactory) -> None:
    """prune() deletes rows older than the retention window."""
    db = str(tmp_path / "hist4.db")
    _reset_module(db)

    old_ts = time.time() - 200 * 3600  # 200 hours ago — well past any retention
    H._buffer.append(("aircraft", "aircraft:old001", old_ts, 5.0, 50.0, 0.0, "{}"))
    # Also add a fresh row
    now = time.time()
    H._buffer.append(("aircraft", "aircraft:new001", now, 5.1, 50.1, 0.0, "{}"))

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    deleted = await loop.run_in_executor(None, H.prune, 48)
    assert deleted >= 1, "old row must be pruned"

    # The fresh row should still be queryable
    result = await H.query_tracks(kind="aircraft", bbox=None, t_from=now - 10, t_to=now + 10)
    ids = {t["id"] for t in result["tracks"]}
    assert "aircraft:new001" in ids
    assert "aircraft:old001" not in ids


@pytest.mark.asyncio
async def test_bbox_filter(tmp_path: pytest.TempPathFactory) -> None:
    """query_tracks bbox filter excludes points outside the bounding box."""
    db = str(tmp_path / "hist5.db")
    _reset_module(db)

    now = time.time()
    # Inside bbox (Europe)
    H._buffer.append(("aircraft", "aircraft:inside", now, 10.0, 52.0, 0.0, "{}"))
    # Outside bbox (Pacific)
    H._buffer.append(("aircraft", "aircraft:outside", now, -150.0, 30.0, 0.0, "{}"))

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    # Europe bbox
    result = await H.query_tracks(
        kind=None,
        bbox=(-10.0, 40.0, 30.0, 65.0),
        t_from=now - 10,
        t_to=now + 10,
    )
    ids = {t["id"] for t in result["tracks"]}
    assert "aircraft:inside" in ids
    assert "aircraft:outside" not in ids


@pytest.mark.asyncio
async def test_size_cap_drops_oldest_keeps_newest(tmp_path: pytest.TempPathFactory) -> None:
    """enforce_size_cap drops the OLDEST rows when the file exceeds the cap;
    0 disables it and a cap above the file size is a no-op."""
    db = str(tmp_path / "cap.db")
    _reset_module(db)

    now = time.time()
    # 200 rows with strictly increasing timestamps (a0 oldest ... a199 newest).
    for i in range(200):
        H._buffer.append(
            ("aircraft", f"aircraft:a{i}", now - (200 - i), float(i % 90), 50.0, 0.0, "{}")
        )
    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    size = await loop.run_in_executor(None, os.path.getsize, db)
    assert H.enforce_size_cap(0) == 0, "cap=0 disables the byte cap"
    assert H.enforce_size_cap(size * 2) == 0, "cap above file size is a no-op"

    deleted = H.enforce_size_cap(size // 2)
    assert deleted > 0, "a cap below file size must drop the oldest rows"
    H._vacuum()  # must not raise; DB stays queryable

    res = await H.query_tracks(
        kind="aircraft", bbox=None, t_from=now - 500, t_to=now + 10, limit_ids=1000
    )
    ids = {t["id"] for t in res["tracks"]}
    assert "aircraft:a199" in ids, "newest row must survive"
    assert "aircraft:a0" not in ids, "oldest row must be dropped"


@pytest.mark.asyncio
async def test_timeseries_distinct_counts_and_buckets(tmp_path: pytest.TempPathFactory) -> None:
    """count_timeseries buckets by time and counts DISTINCT ids per kind — the
    metrics-over-time (§8) source. A duplicate id in the same bucket collapses to 1."""
    db = str(tmp_path / "ts.db")
    _reset_module(db)

    now = time.time()
    bucket = 300  # 5-min buckets
    # Bucket A (current): two distinct aircraft, one repeated → distinct == 2.
    H._buffer.append(("aircraft", "aircraft:a1", now, 5.0, 50.0, 0.0, "{}"))
    H._buffer.append(("aircraft", "aircraft:a2", now, 6.0, 51.0, 0.0, "{}"))
    H._buffer.append(("aircraft", "aircraft:a1", now + 1, 5.1, 50.0, 0.0, "{}"))
    # Earlier bucket: one vessel.
    H._buffer.append(("vessel", "vessel:v1", now - 400, 7.0, 52.0, 0.0, "{}"))

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    res = await H.count_timeseries(bucket, now - 700, now + 10)
    buckets = res["buckets"]
    assert res["bucket_sec"] == bucket
    cur = int(now // bucket) * bucket
    cur_b = next(b for b in buckets if b["t"] == cur)
    assert cur_b["aircraft"] == 2, "distinct aircraft in current bucket (dup id collapses)"
    assert sum(b["vessel"] for b in buckets) == 1, "one vessel across the window"


@pytest.mark.asyncio
async def test_vessel_ingest(tmp_path: pytest.TempPathFactory) -> None:
    """Vessel rows are buffered and queryable."""
    db = str(tmp_path / "hist6.db")
    _reset_module(db)

    now = time.time()
    H.ingest_vessels([_make_vessel_row("123456789", lon=25.0, lat=60.0, ts=now)])

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    result = await H.query_tracks(kind="vessel", bbox=None, t_from=now - 10, t_to=now + 10)
    tracks = result["tracks"]
    assert len(tracks) == 1
    assert tracks[0]["id"] == "vessel:123456789"
    assert tracks[0]["kind"] == "vessel"


# ── retention bound (D4: multi-day replay, still self-capped) ────────────────


def test_retention_default_is_multiday() -> None:
    """The default retention window must exceed the old ~24 h live window so the
    operator can scrub multi-day, while staying within the configured ceiling."""
    get_settings.cache_clear()
    try:
        hours = H._clamped_retention_hours()
    finally:
        get_settings.cache_clear()
    assert hours > 24, "default retention must lift past the ~24h live window"
    assert hours <= get_settings().history_retention_max_hours
    get_settings.cache_clear()


def test_retention_clamped_to_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fat-fingered huge retention is clamped down to history_retention_max_hours
    so the time bound can never grow unboundedly large."""
    with _retention_env(monkeypatch, hours=1_000_000, max_hours=720):
        assert H._clamped_retention_hours() == 720


def test_retention_floored_at_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """A zero/negative retention floors at 1 h so the prune cutoff is never in
    the future / non-positive (which would delete everything or nothing sanely)."""
    with _retention_env(monkeypatch, hours=0, max_hours=720):
        assert H._clamped_retention_hours() == 1
    with _retention_env(monkeypatch, hours=-5, max_hours=720):
        assert H._clamped_retention_hours() == 1


def test_retention_ceiling_zero_disables_upper_bound(monkeypatch: pytest.MonkeyPatch) -> None:
    """A ceiling of 0 disables the upper clamp (byte cap is then the only limit),
    but the floor of 1 still holds."""
    with _retention_env(monkeypatch, hours=5_000, max_hours=0):
        assert H._clamped_retention_hours() == 5_000
    with _retention_env(monkeypatch, hours=0, max_hours=0):
        assert H._clamped_retention_hours() == 1


def test_retention_within_range_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    """A normal multi-day value inside the range is used verbatim."""
    with _retention_env(monkeypatch, hours=168, max_hours=720):
        assert H._clamped_retention_hours() == 168


@pytest.mark.asyncio
async def test_prune_honours_clamped_retention(
    monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory
) -> None:
    """End-to-end: with a multi-day window, a fix from 3 days ago is KEPT (the old
    48 h window would have pruned it); a fix past the window is still dropped.

    This is the operator-visible win — replay reaches back multiple days — proven
    against the same prune() the background maintenance loop calls.
    """
    db = str(tmp_path / "retain.db")
    _reset_module(db)

    now = time.time()
    three_days_ago = now - 3 * 24 * 3600  # inside a 7-day window, outside 48h
    ten_days_ago = now - 10 * 24 * 3600  # outside a 7-day window
    H._buffer.append(("aircraft", "aircraft:d3", three_days_ago, 5.0, 50.0, 0.0, "{}"))
    H._buffer.append(("aircraft", "aircraft:d10", ten_days_ago, 6.0, 51.0, 0.0, "{}"))

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    with _retention_env(monkeypatch, hours=168, max_hours=720):  # 7 days
        await loop.run_in_executor(None, H.prune, H._clamped_retention_hours())

    res = await H.query_tracks(
        kind="aircraft", bbox=None, t_from=ten_days_ago - 10, t_to=now + 10, limit_ids=1000
    )
    ids = {t["id"] for t in res["tracks"]}
    assert "aircraft:d3" in ids, "a 3-day-old fix must survive a 7-day window"
    assert "aircraft:d10" not in ids, "a 10-day-old fix is past the window → pruned"


def test_stats_reports_effective_retention(monkeypatch: pytest.MonkeyPatch) -> None:
    """stats() exposes the *clamped* retention so the frontend date-picker can
    bound itself to what's actually retained, not the raw setting."""
    with _retention_env(monkeypatch, hours=1_000_000, max_hours=720):
        st = H.stats()
        assert st["retention_hours"] == 720, "stats must report the clamped value"
        assert st["retention_max_hours"] == 720
        assert "max_bytes" in st


# ── archive profile (W1 §1) ───────────────────────────────────────────────────


def test_archive_mode_lifts_time_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    """ARCHIVE_MODE=1 uncaps the retention ceiling even though
    HISTORY_RETENTION_MAX_HOURS is left at its normal (non-zero) default —
    proving the archive_mode override itself, not just the pre-existing
    ceiling=0 path (test_retention_ceiling_zero_disables_upper_bound stays
    green, unchanged, and covers that path)."""
    with _archive_env(monkeypatch, archive_mode=True, retention_hours=5_000):
        assert get_settings().history_retention_max_hours > 0, (
            "ceiling config value itself must stay non-zero — archive_mode "
            "overrides its effect, not the setting"
        )
        assert H._clamped_retention_hours() == 5_000


def test_archive_mode_uses_disk_budget_not_ram_scaled(monkeypatch: pytest.MonkeyPatch) -> None:
    """archive_mode sources the size cap from the fixed disk budget, not RAM —
    a tiny available_bytes must not shrink it; the same tiny value DOES shrink
    the cap outside archive mode (proves the branch, not just one arm)."""
    monkeypatch.setattr(memtier, "available_bytes", lambda: 1024)  # tiny RAM

    with _archive_env(monkeypatch, archive_mode=True, disk_budget_gb=50.0):
        cap = H._size_cap_bytes(get_settings())
        assert cap == int(50.0 * 1024**3)

    with _archive_env(monkeypatch, archive_mode=False):
        cap = H._size_cap_bytes(get_settings())
        assert cap < get_settings().history_max_bytes, (
            "tiny available RAM must still shrink the non-archive cap"
        )


def test_archive_mode_falls_back_to_history_max_bytes_when_budget_unset(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """ARCHIVE_MODE=1 with HISTORY_DISK_BUDGET_GB=0 (unset) falls back to
    history_max_bytes rather than silently no-op'ing — with a logged warning."""
    with _archive_env(monkeypatch, archive_mode=True, disk_budget_gb=0.0):
        settings = get_settings()
        with caplog.at_level("WARNING", logger="app.history"):
            cap = H._size_cap_bytes(settings)
        assert cap == int(settings.history_max_bytes)
        assert any("history_disk_budget_gb=0" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_archive_mode_skips_vacuum(
    monkeypatch: pytest.MonkeyPatch, tmp_path: pytest.TempPathFactory
) -> None:
    """§1.4: a seeded-past-cap archive-mode pass still deletes down to the cap
    (byte cap enforced promptly) but does NOT call _vacuum(); the same scenario
    outside archive mode DOES call _vacuum() (proves the branch, not one arm)."""
    vacuum_calls: list[bool] = []
    monkeypatch.setattr(H, "_vacuum", lambda: vacuum_calls.append(True))
    monkeypatch.setattr(H, "_clamped_retention_hours", lambda: 10_000)  # no time-prune

    db_archive = str(tmp_path / "vacuum_archive.db")
    size = await _seed_past_cap(db_archive)
    monkeypatch.setattr(H, "_size_cap_bytes", lambda settings: size // 2)

    with _archive_env(monkeypatch, archive_mode=True):
        await H._maintenance_pass()
    assert vacuum_calls == [], "archive mode must skip the full VACUUM"
    res = await H.query_tracks(
        kind="aircraft", bbox=None, t_from=0, t_to=time.time() + 10, limit_ids=1000
    )
    ids = {t["id"] for t in res["tracks"]}
    assert "aircraft:v0" not in ids, "byte cap must still be enforced promptly in archive mode"

    db_default = str(tmp_path / "vacuum_default.db")
    size2 = await _seed_past_cap(db_default)
    monkeypatch.setattr(H, "_size_cap_bytes", lambda settings: size2 // 2)

    with _archive_env(monkeypatch, archive_mode=False):
        await H._maintenance_pass()
    assert vacuum_calls == [True], "non-archive mode must still VACUUM after a cap-triggered delete"


# ── coverage endpoint (W1 §2) ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_coverage_shape_and_totals(tmp_path: pytest.TempPathFactory) -> None:
    """history.coverage() returns the documented shape and bucket counts sum to
    the total row count for a window covering all seeded rows."""
    db = str(tmp_path / "coverage.db")
    _reset_module(db)

    now = time.time()
    H._buffer.append(("aircraft", "aircraft:cov1", now - 3600, 5.0, 50.0, 0.0, "{}"))
    H._buffer.append(("aircraft", "aircraft:cov2", now - 7200, 6.0, 51.0, 0.0, "{}"))
    H._buffer.append(("vessel", "vessel:cov1", now - 1800, 7.0, 52.0, 0.0, "{}"))

    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    result = await H.coverage(window_hours=24, bucket_hours=1)
    assert result["recording_since"] is not None
    assert result["total_bytes"] > 0
    assert result["row_count"] == 3
    assert sum(b["count"] for b in result["buckets"]) == result["row_count"]


@pytest.mark.asyncio
async def test_coverage_scan_is_cached_and_never_concurrent(
    tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The archive scan runs at most once per TTL, and never twice at once.

    Regression: coverage() scanned on every call. The scan takes far longer
    than the replay bar's 5 s poll (73 s over 83 M rows, measured), so a read
    transaction was always open — and a WAL cannot checkpoint past its oldest
    reader. The dev box ended up with a 49.6 GB WAL on a 15.2 GB archive, 98 %
    of it reclaimable. Aborting the HTTP request does not cancel the executor
    thread, so bursts piled up concurrently too. Both bounds are load-bearing.
    """
    db = str(tmp_path / "coverage_cache.db")
    _reset_module(db)

    now = time.time()
    H._buffer.append(("aircraft", "aircraft:cache1", now - 60, 5.0, 50.0, 0.0, "{}"))
    rows, H._buffer = H._buffer, []
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    calls = 0
    real = H._coverage_sync
    in_flight = 0
    max_in_flight = 0

    def counting(window_hours: int, bucket_hours: int) -> dict:
        nonlocal calls, in_flight, max_in_flight
        calls += 1
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        try:
            time.sleep(0.05)  # stand in for the real multi-second scan
            return real(window_hours, bucket_hours)
        finally:
            in_flight -= 1

    monkeypatch.setattr(H, "_coverage_sync", counting)

    # A burst of concurrent callers, as the replay bar produced.
    results = await asyncio.gather(*(H.coverage(24, 1) for _ in range(8)))
    assert calls == 1, f"expected one scan for a concurrent burst, got {calls}"
    assert max_in_flight == 1, "scans must never overlap: an overlapping read pins the WAL"
    assert all(r["row_count"] == 1 for r in results)

    # Inside the TTL: still no new scan.
    await H.coverage(24, 1)
    assert calls == 1

    # Past the TTL: the data is allowed to refresh.
    monkeypatch.setattr(H, "_COVERAGE_TTL_S", 0.0)
    await H.coverage(24, 1)
    assert calls == 2


def test_connect_bounds_the_wal_file(tmp_path: pytest.TempPathFactory) -> None:
    """Every connection caps the WAL, so no read pattern can grow it unbounded."""
    db = str(tmp_path / "wal_limit.db")
    _reset_module(db)
    try:
        con = H._connect()
        limit = con.execute("PRAGMA journal_size_limit").fetchone()[0]
        con.close()
        assert limit == H._WAL_SIZE_LIMIT_BYTES
        assert 0 < limit <= 1024**3, "an unbounded/huge WAL limit defeats the point"
    finally:
        H.override_db_path(None)


def test_coverage_route_returns_expected_keys(
    client: TestClient, tmp_path: pytest.TempPathFactory
) -> None:
    """GET /api/history/coverage — route-level smoke test."""
    db = str(tmp_path / "coverage_route.db")
    _reset_module(db)
    try:
        r = client.get("/api/history/coverage")
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) >= {"recording_since", "total_bytes", "row_count", "buckets"}
    finally:
        H.override_db_path(None)
