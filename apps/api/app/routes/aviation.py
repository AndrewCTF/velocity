"""GET /api/aviation/states — ADS-B state vectors from OpenSky.

Returns GeoJSON FeatureCollection of aircraft. Anonymous by default; OAuth2
client_credentials used automatically when OPENSKY_CLIENT_ID/SECRET are set.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.ingest.opensky import OpenSkyTokenManager, fetch_states, states_to_geojson
from app.upstream import cache

router = APIRouter(tags=["aviation"])

# Module-level token manager so OAuth2 token is reused across requests.
_TM: OpenSkyTokenManager | None = None


def _token_manager(settings: Settings) -> OpenSkyTokenManager:
    global _TM
    if _TM is None or _TM._cid != settings.opensky_client_id:
        _TM = OpenSkyTokenManager(
            settings.opensky_client_id, settings.opensky_client_secret
        )
    return _TM


@router.get("/api/aviation/states")
async def aviation_states(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    bbox: tuple[float, float, float, float] | None = None
    bbox_args = (lamin, lomin, lamax, lomax)
    if any(b is not None for b in bbox_args):
        if not all(b is not None for b in bbox_args):
            raise HTTPException(
                status_code=400, detail="bbox requires all of lamin,lomin,lamax,lomax"
            )
        bbox = (lamin, lomin, lamax, lomax)  # type: ignore[assignment]

    tm = _token_manager(settings)
    key = f"opensky:{bbox}"

    async def load() -> dict[str, Any]:
        try:
            raw = await fetch_states(tm, bbox)
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"opensky upstream: {e.response.text[:200]}",
            ) from e
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"opensky transport: {e}") from e
        return states_to_geojson(raw)

    # Anonymous gets ~10s resolution per docs; authenticated 5s. Cache 10s.
    return await cache.get_or_fetch(key, 10.0, load)
