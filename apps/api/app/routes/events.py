"""GET /api/events/* — situational-awareness event feeds.

- /api/events/eonet  — NASA EONET natural events (wildfires, storms, volcanoes,
  floods, sea ice, dust, etc.). No auth.
- /api/events/gdelt  — GDELT 2.0 GEO 2.0 (geocoded news events). No auth.
  3-month rolling window; we ask for the last 24h.
- /api/events/acled  — ACLED conflict events. Requires ACLED_KEY + email.
  Falls back to an empty FeatureCollection when unconfigured.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["events"])

EONET_CATEGORIES = {
    "wildfires",
    "volcanoes",
    "storms",
    "floods",
    "drought",
    "dustHaze",
    "manmade",
    "seaLakeIce",
    "severeStorms",
    "snow",
    "temperatureExtremes",
    "waterColor",
}


@router.get("/api/events/eonet")
async def eonet(
    status: str = Query("open"),
    category: str | None = Query(None),
    limit: int = Query(150, ge=1, le=500),
) -> dict[str, Any]:
    if category and category not in EONET_CATEGORIES:
        raise HTTPException(400, f"unknown category {category}")
    key = f"eonet:{status}:{category}:{limit}"

    async def load() -> dict[str, Any]:
        params: dict[str, Any] = {"status": status, "limit": limit}
        if category:
            params["category"] = category
        r = await get_client().get(
            "https://eonet.gsfc.nasa.gov/api/v3/events", params=params
        )
        if r.status_code != 200:
            raise HTTPException(502, f"eonet upstream {r.status_code}")
        j = r.json()
        feats: list[dict[str, Any]] = []
        for ev in j.get("events", []):
            geoms = ev.get("geometry") or []
            last = geoms[-1] if geoms else None
            if not last:
                continue
            coords = last.get("coordinates")
            gtype = last.get("type")
            if gtype != "Point" or not coords:
                continue
            cats = [c.get("title") for c in (ev.get("categories") or [])]
            feats.append(
                {
                    "type": "Feature",
                    "id": f"eonet:{ev.get('id')}",
                    "geometry": {"type": "Point", "coordinates": coords},
                    "properties": {
                        "title": ev.get("title"),
                        "categories": cats,
                        "source": "eonet",
                        "link": ev.get("link"),
                        "date": last.get("date"),
                        "kind": "event",
                    },
                }
            )
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch(key, 600.0, load)


@router.get("/api/events/gdelt")
async def gdelt(
    query: str = Query("(protest OR strike OR clash OR military)"),
    timespan: str = Query("24h"),
    maxrecords: int = Query(250, ge=10, le=250),
) -> dict[str, Any]:
    key = f"gdelt:{query}:{timespan}:{maxrecords}"

    async def load() -> dict[str, Any]:
        params = {
            "query": query,
            "mode": "PointData",
            "format": "GeoJSON",
            "timespan": timespan,
            "maxrecords": maxrecords,
        }
        r = await get_client().get(
            "https://api.gdeltproject.org/api/v2/geo/geo", params=params
        )
        if r.status_code != 200:
            raise HTTPException(502, f"gdelt upstream {r.status_code}")
        try:
            j = r.json()
        except Exception:
            return {"type": "FeatureCollection", "features": []}
        # GDELT returns proper GeoJSON; tag each feature with kind
        feats = j.get("features") or []
        for f in feats:
            (f.setdefault("properties", {}))["kind"] = "event"
            f["properties"]["source"] = "gdelt"
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch(key, 900.0, load)


@router.get("/api/events/acled")
async def acled(
    days: int = Query(7, ge=1, le=90),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    # ACLED needs key + email. Without those, return empty + note.
    key = getattr(settings, "acled_key", "") or ""
    email = getattr(settings, "acled_email", "") or ""
    if not key or not email:
        return {
            "type": "FeatureCollection",
            "features": [],
            "note": "ACLED_KEY / ACLED_EMAIL not configured",
        }
    cache_key = f"acled:{days}"

    async def load() -> dict[str, Any]:
        params = {
            "key": key,
            "email": email,
            "event_date": f"{days}|0",
            "limit": 500,
        }
        r = await get_client().get("https://api.acleddata.com/acled/read", params=params)
        if r.status_code != 200:
            raise HTTPException(502, f"acled upstream {r.status_code}")
        j = r.json()
        rows = j.get("data") or []
        feats: list[dict[str, Any]] = []
        for row in rows:
            try:
                lon = float(row["longitude"])
                lat = float(row["latitude"])
            except (KeyError, ValueError):
                continue
            feats.append(
                {
                    "type": "Feature",
                    "id": f"acled:{row.get('event_id_cnty', row.get('data_id'))}",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "event_type": row.get("event_type"),
                        "sub_event_type": row.get("sub_event_type"),
                        "actor1": row.get("actor1"),
                        "actor2": row.get("actor2"),
                        "country": row.get("country"),
                        "fatalities": row.get("fatalities"),
                        "notes": row.get("notes"),
                        "date": row.get("event_date"),
                        "source": "acled",
                        "kind": "event",
                    },
                }
            )
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch(cache_key, 1800.0, load)
