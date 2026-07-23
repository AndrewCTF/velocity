"""GET /api/eq?range=hour|day|week|month — USGS earthquake feed.

Public, no auth (research.md §8). We pass through the upstream GeoJSON,
optionally filtered to a radius around a point (lat/lon/radius_km) so
"quakes near a city" doesn't require the caller to filter client-side.
TTL ~60s per plan §cross-cutting (USGS itself updates roughly that often).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query

from app.intel.geo import feature_lonlat, haversine_km
from app.upstream import cache, get_client

router = APIRouter(tags=["eq"])

Range = Literal["hour", "day", "week", "month"]

UPSTREAM = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_{range}.geojson"


async def _fetch_quakes(range: Range) -> dict[str, Any]:
    url = UPSTREAM.format(range=range)
    r = await get_client().get(url)
    # A non-JSON 200 (CDN error page / rate-limit body) would raise out of the
    # cache.get_or_fetch loader and 500 this sacred keyless layer; treat it
    # like a bad status → 502 so the quakes layer degrades, never crashes.
    if r.status_code != 200 or "json" not in r.headers.get("content-type", "").lower():
        raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
    data = r.json()
    # USGS returns FeatureCollection — pass-through.
    return data  # type: ignore[no-any-return]


async def load_quakes(range: Range = "day") -> dict[str, Any]:
    """Cached USGS quakes fetch — the callable surface for in-process
    consumers (the instability scorer). Never call the route handler
    in-process; call this. No geo filter here: the cache key and the
    in-process contract (instability scorer) both depend on this being
    range-only — do the radius filter on the route side, after the fetch."""
    ttl = 60.0 if range in ("hour", "day") else 300.0
    return await cache.get_or_fetch(f"eq:{range}", ttl, lambda: _fetch_quakes(range))


def filter_by_radius(
    collection: dict[str, Any], lat: float, lon: float, radius_km: float
) -> dict[str, Any]:
    """Return a copy of a GeoJSON FeatureCollection keeping only features
    within radius_km of (lat, lon). Non-dict/non-Point/malformed features
    are dropped rather than raising — this is a best-effort convenience
    filter, not a validator."""
    feats = collection.get("features") or []
    kept: list[dict[str, Any]] = []
    for f in feats:
        lonlat = feature_lonlat(f)
        if lonlat is None:
            continue
        flon, flat = lonlat
        if haversine_km(lon, lat, flon, flat) <= radius_km:
            kept.append(f)
    return {**collection, "features": kept}


@router.get("/api/eq")
async def quakes(
    range: Range = Query("day"),
    lat: float | None = Query(None, ge=-90.0, le=90.0),
    lon: float | None = Query(None, ge=-180.0, le=180.0),
    radius_km: float | None = Query(None, gt=0.0, le=20000.0),
) -> dict[str, Any]:
    data = await load_quakes(range)
    if lat is not None and lon is not None and radius_km is not None:
        data = filter_by_radius(data, lat, lon, radius_km)
    return data
