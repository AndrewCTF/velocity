"""GET /api/space/* — orbital catalogues.

CelesTrak GP (free, no auth, 2h refresh ceiling) returns TLE/3LE/JSON groups
of satellites. We expose 'active', 'starlink', 'visual', 'iss', 'noaa', etc.

We don't propagate orbits server-side — propagation belongs on the client
via satellite.js per the plan. So this route just hands TLE+name out and
the frontend computes positions.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.upstream import cache, get_client

router = APIRouter(tags=["space"])

ALLOWED_GROUPS = {
    "active",
    "starlink",
    "visual",
    "stations",
    "iridium-NEXT",
    "globalstar",
    "oneweb",
    "noaa",
    "goes",
    "weather",
    "gps-ops",
    "glo-ops",
    "galileo",
    "beidou",
    "military",
    "geo",
    "intelsat",
    "ses",
    "planet",
    "spire",
}


@router.get("/api/space/gp")
async def gp(group: str = Query("active")) -> dict[str, Any]:
    if group not in ALLOWED_GROUPS:
        raise HTTPException(400, f"unknown group {group}")
    key = f"celestrak:{group}"

    async def load() -> dict[str, Any]:
        url = "https://celestrak.org/NORAD/elements/gp.php"
        r = await get_client().get(url, params={"GROUP": group, "FORMAT": "json"})
        if r.status_code != 200:
            raise HTTPException(502, f"celestrak upstream {r.status_code}")
        # CelesTrak returns a JSON array of OMM-format records — pass through
        return {"group": group, "items": r.json()}

    # CelesTrak update ceiling is 2h; respect it.
    return await cache.get_or_fetch(key, 2 * 3600.0, load)
