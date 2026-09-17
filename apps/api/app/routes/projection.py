"""GET /api/history/project — projected position cone + chokepoint ETA for
ONE tracked contact, computed from its own recorded history.

Sibling of routes/history.py: same identity-scoped id handling (bare id +
kind=, already-prefixed id, or shape-inferred), same auth posture (none here —
the app-level auth middleware gates /api/, this router adds no Depends, same
as routes/history.py). The analytic itself lives in app.intel.project so it
stays unit-testable on synthetic fixes with no DB.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from app import history
from app.intel.project import project
from app.routes.history import _infer_kind, _normalize_id_case

router = APIRouter(tags=["history"])

# query_track_by_id's own default (5000) is ORDER BY t ASC LIMIT N, so on a
# busy contact a wide window would silently truncate the NEWEST fixes and the
# projection's origin would be stale by however much got cut off. This route's
# window is bounded (<=7 days) but a contact can still report every few
# seconds, so ask for enough rows that the truncation floor sits far above any
# real window's fix count.
_TRACK_LIMIT = 20_000


@router.get("/api/history/project")
async def get_projection(
    id: str = Query(
        ...,
        description=(
            "Entity id, e.g. 'vessel:244770688' or bare '244770688' with "
            "kind= (or bare with no kind= at all, if its shape is "
            "unambiguous: a 6-char ICAO24 hex or a 9-digit MMSI)"
        ),
    ),
    kind: str | None = Query(None, description="Prefix for a bare id: 'aircraft' or 'vessel'"),
    horizon_s: int = Query(3600, ge=300, le=86400, description="Seconds ahead to project"),
    window_s: int = Query(
        21600, ge=600, le=604800, description="Look-back window of history to project from"
    ),
) -> dict:
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

    now = time.time()
    result = await history.query_track_by_id(
        entity_id=entity_id,
        t_from=now - window_s,
        t_to=now,
        limit=_TRACK_LIMIT,
    )
    if result.get("degraded"):
        raise HTTPException(503, "history store is degraded; try again shortly")

    points = result["tracks"][0]["points"] if result.get("tracks") else []
    if not points:
        raise HTTPException(404, f"no recorded fixes for {entity_id!r} in the last {window_s}s")

    return project([(lon, lat, t) for lon, lat, t, _track in points], horizon_s)
