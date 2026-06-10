"""GET /api/cables — submarine cables + landing points.

Per research_updated.md §2.12: TeleGeography's community-discovered endpoints
return GeoJSON for cables and landing points. CC BY-NC-SA 3.0. Pass through
with a 24h cache (cables don't move).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from app.upstream import cache, get_client

router = APIRouter(tags=["cables"])

CABLES_URL = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json"
LANDINGS_URL = "https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json"


@router.get("/api/cables")
async def cables() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        r = await get_client().get(CABLES_URL)
        if r.status_code != 200:
            raise HTTPException(502, f"cables upstream {r.status_code}")
        return r.json()  # type: ignore[no-any-return]

    return await cache.get_or_fetch("cables:lines", 24 * 3600.0, load)


@router.get("/api/cables/landings")
async def cable_landings() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        r = await get_client().get(LANDINGS_URL)
        if r.status_code != 200:
            raise HTTPException(502, f"landings upstream {r.status_code}")
        return r.json()  # type: ignore[no-any-return]

    return await cache.get_or_fetch("cables:landings", 24 * 3600.0, load)
