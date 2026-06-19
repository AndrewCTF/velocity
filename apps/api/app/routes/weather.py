"""GET /api/weather/* — atmospheric + space-weather.

- /api/weather/swpc/kp — NOAA SWPC planetary K-index (1-minute). No auth.
- /api/weather/openmeteo — Open-Meteo point forecast. No auth, CC BY.
- /api/weather/alerts — NOAA NWS US weather alerts (active). No auth.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["weather"])


@router.get("/api/weather/swpc/kp")
async def swpc_kp() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        r = await get_client().get(
            "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json"
        )
        if r.status_code != 200:
            raise HTTPException(502, f"swpc upstream {r.status_code}")
        return {"series": r.json()}

    return await cache.get_or_fetch("swpc:kp", 60.0, load)


@router.get("/api/weather/openmeteo")
async def openmeteo(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
) -> dict[str, Any]:
    # api.open-meteo.com is free for NON-commercial use only (data is CC BY, the
    # hosted endpoint is not). On a commercial deployment, use NWS alerts/SWPC
    # (public domain) or self-host Open-Meteo. See docs/commercial-licensing.md.
    if get_settings().commercial_mode:
        raise HTTPException(
            503, "open-meteo hosted API is non-commercial; self-host or use NWS"
        )
    key = f"openmeteo:{lat:.2f}:{lon:.2f}"

    async def load() -> dict[str, Any]:
        params = {
            "latitude": lat,
            "longitude": lon,
            "current": (
                "temperature_2m,relative_humidity_2m,wind_speed_10m,"
                "wind_direction_10m,cloud_cover,pressure_msl"
            ),
            "hourly": "temperature_2m,precipitation,wind_speed_10m",
            "forecast_days": 3,
        }
        r = await get_client().get(
            "https://api.open-meteo.com/v1/forecast", params=params
        )
        if r.status_code != 200:
            raise HTTPException(502, f"open-meteo upstream {r.status_code}")
        return r.json()  # type: ignore[no-any-return]

    return await cache.get_or_fetch(key, 600.0, load)


@router.get("/api/weather/alerts")
async def nws_alerts() -> dict[str, Any]:
    """Active NOAA NWS alerts as GeoJSON."""
    async def load() -> dict[str, Any]:
        r = await get_client().get(
            "https://api.weather.gov/alerts/active",
            headers={"Accept": "application/geo+json"},
        )
        if r.status_code != 200:
            raise HTTPException(502, f"nws upstream {r.status_code}")
        j = r.json()
        feats: list[dict[str, Any]] = []
        for f in j.get("features", []) or []:
            geom = f.get("geometry")
            props = f.get("properties") or {}
            if not geom:
                continue
            feats.append(
                {
                    "type": "Feature",
                    "id": f"nws:{props.get('id', f.get('id'))}",
                    "geometry": geom,
                    "properties": {
                        "event": props.get("event"),
                        "headline": props.get("headline"),
                        "severity": props.get("severity"),
                        "urgency": props.get("urgency"),
                        "areaDesc": props.get("areaDesc"),
                        "effective": props.get("effective"),
                        "expires": props.get("expires"),
                        "sender": props.get("senderName"),
                        "kind": "event",
                        "source": "nws",
                    },
                }
            )
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch("nws:alerts", 120.0, load)
