"""GET /api/places/{airports,ports}?bbox=… — reference-data map overlays.

Keyless, like /api/geocode: airports + seaports are public reference data.
Each endpoint returns a GeoJSON FeatureCollection of the points inside the
requested bbox so the frontend can drape them as a layer. The heavy lifting
(load-once + bbox filter + type-priority cap) lives in ``app.places``.

bbox is ``minLon,minLat,maxLon,maxLat``. A missing/malformed bbox yields an
empty FeatureCollection (same graceful-degrade convention as the export route's
``_parse_bbox``) rather than dumping the whole 5k-row dataset.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Response

from app import places

router = APIRouter(tags=["places"])

_EMPTY_FC: dict[str, Any] = {"type": "FeatureCollection", "features": []}


def _parse_bbox(raw: str | None) -> tuple[float, float, float, float] | None:
    if not raw:
        return None
    try:
        parts = [float(x) for x in raw.split(",")]
    except ValueError:
        return None
    if len(parts) != 4:
        return None
    min_lon, min_lat, max_lon, max_lat = parts
    if min_lat >= max_lat:
        return None
    return (min_lon, min_lat, max_lon, max_lat)


@router.get("/api/places/airports")
async def places_airports(
    response: Response,
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat"),
    limit: int = Query(2000, ge=1, le=20000),
    large_only: bool = Query(False),
) -> dict[str, Any]:
    """Airports inside the bbox as GeoJSON (large kept before medium on overflow)."""
    box = _parse_bbox(bbox)
    if box is None:
        return _EMPTY_FC
    # Reference data is static — let the browser cache it like /tiles do.
    response.headers["Cache-Control"] = "public, max-age=86400"
    return places.bbox_features("airport", *box, limit=limit, large_only=large_only)


@router.get("/api/places/ports")
async def places_ports(
    response: Response,
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat"),
    limit: int = Query(2000, ge=1, le=20000),
) -> dict[str, Any]:
    """Seaports inside the bbox as GeoJSON."""
    box = _parse_bbox(bbox)
    if box is None:
        return _EMPTY_FC
    response.headers["Cache-Control"] = "public, max-age=86400"
    return places.bbox_features("port", *box, limit=limit)
