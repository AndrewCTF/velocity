"""GET /api/intel/* — deep, agent-facing intelligence API.

This is the HTTP surface the MCP server (``app.mcp_server``) drives, and a
power-user can hit it directly. Everything returns compact JSON
(``app.intel.analytics``); nothing dumps raw feature collections.

Geography is accepted two ways on the query endpoints:
- explicit bbox: ``min_lon,min_lat,max_lon,max_lat``
- centre + radius: ``lat,lon,radius_nm`` (radius defaults to 200 nm)

The ``/area`` endpoint is the headline tool: it loads the requested region
PRIMARY (dedicated fresh fetch + ongoing priority refresh) and returns a full
intel bundle for it in a single round trip.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app import llm
from app.config import get_settings
from app.intel import analytics, aoi, incidents
from app.intel.geo import BBox, bbox_from_radius

router = APIRouter(tags=["intel"])


def _resolve_bbox(
    min_lon: float | None,
    min_lat: float | None,
    max_lon: float | None,
    max_lat: float | None,
    lat: float | None,
    lon: float | None,
    radius_nm: float,
) -> BBox | None:
    corners = (min_lon, min_lat, max_lon, max_lat)
    if all(v is not None for v in corners):
        if min_lon >= max_lon or min_lat >= max_lat:  # type: ignore[operator]
            raise HTTPException(422, "bbox requires min < max for both axes")
        return BBox(min_lon, min_lat, max_lon, max_lat)  # type: ignore[arg-type]
    if lat is not None and lon is not None:
        return bbox_from_radius(lat, lon, radius_nm)
    return None


@router.get("/api/intel/situation")
async def intel_situation() -> dict[str, Any]:
    """Global orienting summary — the cheap first call for an agent."""
    return await analytics.situation()


@router.get("/api/intel/area")
async def intel_area(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_nm: float = Query(200.0, ge=1, le=250),
    label: str | None = Query(None, max_length=80),
    primary: bool = Query(True),
    cell_deg: float = Query(1.0, ge=0.1, le=10.0),
) -> dict[str, Any]:
    """Load a region PRIMARY and return its full intel bundle in one shot."""
    return await analytics.area_intel(
        lat=lat,
        lon=lon,
        radius_nm=radius_nm,
        label=label,
        set_primary=primary,
        cell_deg=cell_deg,
    )


@router.get("/api/intel/density")
async def intel_density(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(200.0, ge=1, le=2000),
    cell_deg: float = Query(1.0, ge=0.1, le=10.0),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.density(bbox, cell_deg)


@router.get("/api/intel/jamming")
async def intel_jamming(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.jamming(bbox)


@router.get("/api/intel/aircraft")
async def intel_aircraft(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(200.0, ge=1, le=2000),
    category: str | None = Query(None),
    squawk: str | None = Query(None),
    callsign_contains: str | None = Query(None),
    min_alt_m: float | None = Query(None),
    max_alt_m: float | None = Query(None),
    emergency: bool | None = Query(None),
    gnss_degraded: bool | None = Query(None),
    on_ground: bool | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.query_aircraft(
        bbox=bbox,
        category=category,
        squawk=squawk,
        callsign_contains=callsign_contains,
        min_alt_m=min_alt_m,
        max_alt_m=max_alt_m,
        emergency=emergency,
        gnss_degraded=gnss_degraded,
        on_ground=on_ground,
        limit=limit,
    )


@router.get("/api/intel/aircraft/{ident}")
async def intel_aircraft_lookup(ident: str) -> dict[str, Any]:
    return await analytics.lookup_aircraft(ident)


@router.get("/api/intel/vessels")
async def intel_vessels(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    dark_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.query_vessels(bbox, dark_only=dark_only, limit=limit)


@router.get("/api/intel/anomalies")
async def intel_anomalies(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
) -> dict[str, Any]:
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await analytics.anomalies(bbox)


@router.get("/api/intel/brief")
async def intel_brief(
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_nm: float = Query(500.0, ge=1, le=5000),
    link_km: float = Query(50.0, ge=1, le=500),
    window_hours: float = Query(6.0, ge=0.25, le=72.0),
) -> dict[str, Any]:
    """Cross-domain incident brief: signals fused into ranked, cited incidents.

    Omit coordinates for a global brief; pass a centre+radius or a bbox to scope
    it. ``link_km`` is the convergence distance; ``window_hours`` bounds recency.
    """
    bbox = _resolve_bbox(min_lon, min_lat, max_lon, max_lat, lat, lon, radius_nm)
    return await incidents.brief(bbox, link_km=link_km, window_s=window_hours * 3600.0)


@router.get("/api/intel/aois")
async def intel_aois() -> dict[str, Any]:
    """List the priority areas currently loaded PRIMARY."""
    return {"aois": aoi.list_aois(), "max": aoi._MAX_AOIS}


@router.get("/api/intel/sources")
async def intel_sources() -> dict[str, Any]:
    """Data-source health + which feeds are key-gated vs always-on."""
    from app import ais_firehose, ais_keyless  # noqa: PLC0415

    s = get_settings()
    return {
        "always_on": [
            "adsb (adsb.lol + airplanes.live grid — keyless aircraft firehose)",
            "opensky /states/all (anonymous — the ~13k global breadth tier; "
            "OAuth creds only raise the daily credit budget)",
            "ais (digitraffic Finland/Baltic)",
            "ais firehose (Kystverket NMEA + Kystdatahuset REST [Norway] + "
            "Digitraffic MQTT [Baltic] — keyless, Northern Europe only; "
            "global vessels still need AISStream)",
            "jamming (derived from ADS-B NACp/NIC)",
            "usgs quakes",
        ],
        "key_gated": {
            "aisstream": bool(s.aisstream_key),
            "firms_fires": bool(s.firms_map_key),
            "opensky_authed": bool(s.opensky_client_id and s.opensky_client_secret),
            "gfw_dark_vessels": bool(s.gfw_token),
        },
        "ais_firehose": ais_firehose.stats(),
        "ais_keyless": ais_keyless.stats(),
        "ollama": {"host": s.ollama_host, "model": s.ollama_model or "(auto-detect)"},
        "llm": llm.status(),
    }
