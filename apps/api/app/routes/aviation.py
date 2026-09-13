"""GET /api/aviation/states — ADS-B state vectors from OpenSky.

Returns GeoJSON FeatureCollection of aircraft. Anonymous by default; OAuth2
client_credentials used automatically when OPENSKY_CLIENT_ID/SECRET are set.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.ingest.opensky import OpenSkyTokenManager, fetch_states, states_to_geojson
from app.upstream import cache

router = APIRouter(tags=["aviation"])
log = logging.getLogger("app.aviation")

# Module-level token manager so OAuth2 token is reused across requests.
_TM: OpenSkyTokenManager | None = None


def _token_manager(settings: Settings) -> OpenSkyTokenManager:
    global _TM
    if _TM is None or _TM._cid != settings.opensky_client_id:
        _TM = OpenSkyTokenManager(
            settings.opensky_client_id, settings.opensky_client_secret
        )
    return _TM


def _upstream_error(exc: httpx.HTTPError) -> HTTPException:
    """A generic answer for the caller; the specifics go to the server log only
    (ASVS V16.5.1). OpenSky's body and the transport error text can name hosts,
    ports or account state, so neither is echoed. The status code is kept: a
    429 or 503 tells the client when to retry."""
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        log.warning("opensky upstream status=%s", status)
        return HTTPException(status_code=status, detail="opensky upstream unavailable")
    log.warning("opensky transport error=%s", type(exc).__name__)
    return HTTPException(status_code=502, detail="opensky upstream unavailable")


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
            # Authed creds dead (OAuth "Invalid client" 401) or rate-limited:
            # don't surface a raw crash. If we WERE authed, degrade to the
            # anonymous endpoint (still ~400 credits/day, same surface) so the
            # route keeps serving aircraft instead of 401'ing — mirrors the
            # authed→anon fallback the global snapshot uses. If anonymous also
            # fails, surface a clear upstream error (not an unhandled 500).
            if tm.enabled:
                anon = OpenSkyTokenManager("", "")
                try:
                    raw = await fetch_states(anon, bbox)
                    return states_to_geojson(raw)
                except httpx.HTTPStatusError as e2:
                    raise _upstream_error(e2) from e2
                except httpx.HTTPError as e2:
                    raise _upstream_error(e2) from e2
            raise _upstream_error(e) from e
        except httpx.HTTPError as e:
            raise _upstream_error(e) from e
        return states_to_geojson(raw)

    # Anonymous gets ~10s resolution per docs; authenticated 5s. Cache 10s.
    return await cache.get_or_fetch(key, 10.0, load)
