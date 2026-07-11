"""GET /api/history/* — historical position playback.

These routes expose the SQLite position store (app.history) over HTTP so the
3D globe can scrub through past tracks or replay an event window.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Query

from app import history

router = APIRouter(tags=["history"])

_DEFAULT_WINDOW_SEC = 3600  # 1 hour look-back when from_ts is omitted


@router.get("/api/history/tracks")
async def get_tracks(
    kind: str | None = Query(None, description="Filter by 'aircraft' or 'vessel'"),
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    from_ts: float | None = Query(None, description="Unix timestamp (seconds)"),
    to_ts: float | None = Query(None, description="Unix timestamp (seconds)"),
    limit_ids: int = Query(500, ge=1, le=5000),
) -> dict:
    now = time.time()
    t_to = to_ts if to_ts is not None else now
    t_from = from_ts if from_ts is not None else (now - _DEFAULT_WINDOW_SEC)

    bbox: tuple[float, float, float, float] | None = None
    if all(v is not None for v in (min_lon, min_lat, max_lon, max_lat)):
        bbox = (
            float(min_lon),  # type: ignore[arg-type]
            float(min_lat),  # type: ignore[arg-type]
            float(max_lon),  # type: ignore[arg-type]
            float(max_lat),  # type: ignore[arg-type]
        )

    return await history.query_tracks(
        kind=kind,
        bbox=bbox,
        t_from=t_from,
        t_to=t_to,
        limit_ids=limit_ids,
    )


@router.get("/api/history/timeseries")
async def get_timeseries(
    window_sec: int = Query(3600, ge=300, le=86400, description="Look-back window"),
    bucket_sec: int = Query(300, ge=60, le=3600, description="Bucket width"),
) -> dict:
    """Metrics-over-time (design §8) — distinct contact counts per time bucket over
    the look-back window, from the observed position store (app.history)."""
    now = time.time()
    return await history.count_timeseries(bucket_sec, now - window_sec, now)


@router.get("/api/history/stats")
def get_stats() -> dict:
    return history.stats()


@router.get("/api/history/coverage")
async def get_coverage(
    window_hours: int = Query(720, ge=1, le=8760, description="Heat-strip look-back, hours"),
    bucket_hours: int = Query(1, ge=1, le=24, description="Bucket width, hours"),
) -> dict:
    return await history.coverage(window_hours, bucket_hours)
