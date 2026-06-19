"""Tests for app.history — no network, uses a tmp SQLite DB."""

from __future__ import annotations

import asyncio
import time

import pytest

import app.history as H

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
