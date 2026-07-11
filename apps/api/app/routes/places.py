"""GET /api/places/{airports,ports,bases}?bbox=… — reference-data map overlays,
plus GET /api/places/{airport,port}/{ident} detail lookups.

Keyless, like /api/geocode: airports + seaports + bases are public reference
data. Each bbox endpoint returns a GeoJSON FeatureCollection of the points
inside the requested bbox so the frontend can drape them as a layer. The heavy
lifting (load-once + bbox filter + type-priority cap) lives in ``app.places``.

bbox is ``minLon,minLat,maxLon,maxLat``. A missing/malformed bbox yields an
empty FeatureCollection (same graceful-degrade convention as the export route's
``_parse_bbox``) rather than dumping the whole 5k-row dataset.

The detail routes are the primary consumer of ``airports_detail.json`` /
``ports_detail.json`` — separate from the bbox routes so a map pan never loads
the (larger) detail payloads. ``/api/entity/{id}`` calls the same
``app.places`` lookups directly (no HTTP hop) for the EntityPanel enrichment
fetch; these routes exist for any caller that wants the raw place record.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response

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


@router.get("/api/places/bases")
async def places_bases(
    response: Response,
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat"),
    limit: int = Query(2000, ge=1, le=20000),
) -> dict[str, Any]:
    """Military bases (air/naval/army) inside the bbox as GeoJSON."""
    box = _parse_bbox(bbox)
    if box is None:
        return _EMPTY_FC
    response.headers["Cache-Control"] = "public, max-age=86400"
    return places.bbox_features("base", *box, limit=limit)


@router.get("/api/places/airport/{ident}")
async def places_airport_detail(ident: str) -> dict[str, Any]:
    """Base row + runway/frequency detail for one airport, by IATA or ICAO."""
    row = places.airport_by_code(ident)
    if row is None:
        raise HTTPException(404, f"unknown airport code {ident!r}")
    icao = str(row.get("icao") or "")
    detail = places.airport_detail(icao) or {}
    return {**row, **detail}


@router.get("/api/places/port/{wpi}")
async def places_port_detail(wpi: str) -> dict[str, Any]:
    """Base row + harbor/repair/depth detail for one port, by WPI number."""
    row = places.port_by_wpi(wpi)
    if row is None:
        raise HTTPException(404, f"unknown port wpi {wpi!r}")
    detail = places.port_detail(wpi) or {}
    return {**row, **detail}
