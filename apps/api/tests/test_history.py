"""Tests for app.history — no network, uses a tmp SQLite DB."""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Iterator

import pytest

import app.history as H
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
    H.override_db_path(tmp_db)


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
    import os

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
