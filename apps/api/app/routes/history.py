"""GET /api/history/* — historical position playback.

These routes expose the SQLite position store (app.history) over HTTP so the
3D globe can scrub through past tracks or replay an event window.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from app import history
from app.routes.search import ICAO24_RE, MMSI_RE

router = APIRouter(tags=["history"])

_DEFAULT_WINDOW_SEC = 3600  # 1 hour look-back when from_ts is omitted


def _infer_kind(raw_id: str) -> str | None:
    """Infer the entity kind from a bare id's shape: exactly 6 hex chars is
    an ICAO24 (aircraft), exactly 9 digits is an MMSI (vessel) — the same
    shapes /api/search mints ids from (ICAO24_RE/MMSI_RE). Returns None when
    the shape matches neither, i.e. genuinely ambiguous."""
    if ICAO24_RE.match(raw_id):
        return "aircraft"
    if MMSI_RE.match(raw_id):
        return "vessel"
    return None


def _normalize_id_case(entity_id: str) -> str:
    """Lowercase the value half of a ``kind:value`` id when that value is
    ICAO24-hex shaped — the position store always writes icao24 hex lowercase
    (app/history.py), so an uppercase/mixed-case hex (the way most spotting
    tools display it, e.g. 'AE085B') otherwise silently matches nothing.
    MMSI is all-digits, so this is a no-op for vessels, and the ``kind``
    prefix itself is left untouched — a future kind might be case-sensitive."""
    prefix, sep, value = entity_id.partition(":")
    if sep and ICAO24_RE.match(value):
        return f"{prefix}:{value.lower()}"
    return entity_id


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


@router.get("/api/history/track")
async def get_track_by_id(
    id: str = Query(
        ...,
        description=(
            "Entity id, e.g. 'aircraft:af351f' or bare 'af351f' with kind= "
            "(or bare with no kind= at all, if its shape is unambiguous: a "
            "6-char ICAO24 hex or a 9-digit MMSI)"
        ),
    ),
    kind: str | None = Query(None, description="Prefix for a bare id: 'aircraft' or 'vessel'"),
    from_ts: float | None = Query(None, description="Unix timestamp (seconds)"),
    to_ts: float | None = Query(None, description="Unix timestamp (seconds)"),
    limit: int = Query(5000, ge=1, le=20000),
    series: bool = Query(
        False,
        description=(
            "Also return the archived altitude/speed series alongside the "
            "positions, for plotting behaviour rather than only path"
        ),
    ),
) -> dict:
    """Identity-scoped history: the positions for ONE tail/MMSI over a time
    window, e.g. "where was this aircraft last Tuesday" — a direct idx_id_t
    lookup rather than the bbox+time scan behind /api/history/tracks."""
    now = time.time()
    t_to = to_ts if to_ts is not None else now
    t_from = from_ts if from_ts is not None else (now - _DEFAULT_WINDOW_SEC)

    if ":" in id:
        entity_id = id
    elif kind:
        entity_id = f"{kind}:{id}"
    else:
        inferred = _infer_kind(id)
        if inferred is None:
            raise HTTPException(
                422,
                f"id {id!r} has no 'kind:' prefix and kind= was not supplied; "
                "its shape isn't a recognizable 6-char ICAO24 hex or 9-digit "
                "MMSI either, so the kind can't be inferred — pass "
                "'<kind>:<id>' or add kind=aircraft|vessel",
            )
        entity_id = f"{inferred}:{id}"

    entity_id = _normalize_id_case(entity_id)

    return await history.query_track_by_id(
        entity_id=entity_id,
        t_from=t_from,
        t_to=t_to,
        limit=limit,
        include_series=series,
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


@router.get("/api/history/diff")
async def get_diff(
    lamin: float = Query(..., ge=-90, le=90),
    lomin: float = Query(..., ge=-180, le=180),
    lamax: float = Query(..., ge=-90, le=90),
    lomax: float = Query(..., ge=-180, le=180),
    at_a: float = Query(..., description="Centre of the earlier window, epoch seconds"),
    at_b: float | None = Query(None, description="Centre of the later window; default now"),
    window_sec: int = Query(600, ge=60, le=86_400, description="Half-width of each window"),
    kind: str | None = Query(None, description="aircraft | vessel; omit for both"),
    limit: int = Query(500, ge=1, le=5000),
) -> dict:
    """What changed inside this box between two moments.

    Arrived, departed, and still-present, by entity id. This is the question
    that needs owned history: a console that only holds the current instant can
    show you four vessels off a terminal but cannot tell you they are a
    different four to last week's.

    `window_sec` widens each moment into a window, because a stored position is
    a sample rather than a continuous truth - asking about a single instant
    against a store that records a fix every few seconds mostly answers
    "nobody".
    """
    b = time.time() if at_b is None else at_b
    return await history.window_diff(
        kind,
        (lomin, lamin, lomax, lamax),
        at_a - window_sec,
        at_a + window_sec,
        b - window_sec,
        b + window_sec,
        limit,
    )
