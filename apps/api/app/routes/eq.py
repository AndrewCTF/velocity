"""GET /api/eq?range=hour|day|week|month — USGS earthquake feed.

Public, no auth (research.md §8). We pass through the upstream GeoJSON.
TTL ~60s per plan §cross-cutting (USGS itself updates roughly that often).
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query

from app.upstream import cache, get_client

router = APIRouter(tags=["eq"])

Range = Literal["hour", "day", "week", "month"]

UPSTREAM = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_{range}.geojson"


@router.get("/api/eq")
async def quakes(range: Range = Query("day")) -> dict[str, Any]:
    async def fetch() -> dict[str, Any]:
        url = UPSTREAM.format(range=range)
        r = await get_client().get(url)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
        data = r.json()
        # USGS returns FeatureCollection — pass-through.
        return data  # type: ignore[no-any-return]

    ttl = 60.0 if range in ("hour", "day") else 300.0
    return await cache.get_or_fetch(f"eq:{range}", ttl, fetch)
