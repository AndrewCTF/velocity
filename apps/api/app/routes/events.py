"""GET /api/events/* — situational-awareness event feeds.

- /api/events/eonet  — NASA EONET natural events (wildfires, storms, volcanoes,
  floods, sea ice, dust, etc.). No auth.
- /api/events/gdelt  — GDELT 2.0 GEO 2.0 (geocoded news events). No auth.
  3-month rolling window; we ask for the last 24h.
- /api/events/acled  — ACLED conflict events. Requires ACLED_KEY + email.
  Falls back to an empty FeatureCollection when unconfigured.
- /api/events/all    — aggregate of the three above, filtered to a radius
  around an operator-chosen point. Returns ONE FeatureCollection.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.geo.adminshapes import country_name_to_iso3
from app.intel.geo import feature_lonlat, haversine_km
from app.upstream import cache, get_client

router = APIRouter(tags=["events"])

# ACLED geo_precision codebook value → approximate uncertainty radius in
# metres (1 = exact town, 2 = part of region, 3 = larger region/provincial
# capital). Unknown/missing precision → no radius — never fabricated.
_ACLED_PREC_RADIUS_M: dict[int, float] = {1: 3000.0, 2: 25000.0, 3: 75000.0}


def parse_geo_precision(value: Any) -> int | None:
    """Defensive int parse of ACLED ``geo_precision`` (missing/garbage → None)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def radius_for_geo_precision(value: Any) -> float | None:
    """Uncertainty radius in metres for an ACLED ``geo_precision`` code; None
    when the precision is absent or unmapped."""
    prec = parse_geo_precision(value)
    return _ACLED_PREC_RADIUS_M.get(prec) if prec is not None else None

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


async def _load_eonet(
    status: str = "open", category: str | None = None, limit: int = 150
) -> dict[str, Any]:
    """Internal EONET loader (cached). Called by the /eonet route AND by the
    /all aggregate — never via the route handler in-process, so FastAPI's
    Query(...) defaults can't leak into the call (mirrors the ADS-B snapshot
    discipline in adsb.py)."""
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


@router.get("/api/events/eonet")
async def eonet(
    status: str = Query("open"),
    category: str | None = Query(None),
    limit: int = Query(150, ge=1, le=500),
) -> dict[str, Any]:
    if category and category not in EONET_CATEGORIES:
        raise HTTPException(400, f"unknown category {category}")
    return await _load_eonet(status, category, limit)


async def _load_gdelt(
    query: str = "(protest OR strike OR clash OR military)",
    timespan: str = "24h",
    maxrecords: int = 250,
) -> dict[str, Any]:
    """Internal GDELT loader (cached). GDELT GEO 2.0 caps `maxrecords` at 250
    per call and serves a 3-month rolling window; we request the widest
    timespan the caller asks for, clamped to that ceiling upstream."""
    key = f"gdelt:{query}:{timespan}:{maxrecords}"

    def _degraded(note: str) -> dict[str, Any]:
        # GDELT is frequently dead from datacenter egress (the report saw a
        # 404). Degrade to an empty-but-VALID FeatureCollection flagged
        # `degraded`, instead of a hard 502 — keeps the /gdelt route and the
        # events/all + intel_brief fusion paths alive (they tolerate empty
        # feeds), and the flag tells the operator the layer is offline.
        return {"type": "FeatureCollection", "features": [], "degraded": True, "note": note}

    async def load() -> dict[str, Any]:
        params = {
            "query": query,
            "mode": "PointData",
            "format": "GeoJSON",
            "timespan": timespan,
            "maxrecords": maxrecords,
        }
        try:
            r = await get_client().get(
                "https://api.gdeltproject.org/api/v2/geo/geo", params=params
            )
        except httpx.HTTPError as e:
            return _degraded(f"gdelt transport: {e}")
        if r.status_code != 200:
            return _degraded(f"gdelt upstream {r.status_code}")
        try:
            j = r.json()
        except ValueError:
            return _degraded("gdelt non-json body")
        # GDELT returns proper GeoJSON; tag each feature with kind
        feats = j.get("features") or []
        for f in feats:
            (f.setdefault("properties", {}))["kind"] = "event"
            f["properties"]["source"] = "gdelt"
        return {"type": "FeatureCollection", "features": feats}

    out = await cache.get_or_fetch(key, 900.0, load)
    # Don't pin a degraded result for the full 15-min TTL — retry the dead
    # upstream within 60s (the empty payload IS cached, so without this a
    # transient blip would mask a recovered feed for 15 minutes).
    if out.get("degraded"):
        cache.shorten(key, 60.0)
    return out


@router.get("/api/events/gdelt")
async def gdelt(
    query: str = Query("(protest OR strike OR clash OR military)"),
    timespan: str = Query("24h"),
    maxrecords: int = Query(250, ge=10, le=250),
) -> dict[str, Any]:
    return await _load_gdelt(query, timespan, maxrecords)


async def _load_acled(settings: Settings, days: int = 7) -> dict[str, Any]:
    """Internal ACLED loader (cached, key-gated). Degrades to an empty
    FeatureCollection + note when ACLED_KEY / ACLED_EMAIL are unset."""
    # ACLED's licence is non-commercial (commercial needs a paid agreement), so
    # it is disabled on a commercial deployment — GDELT + EONET (open) cover
    # conflict/disaster events there.
    if settings.commercial_mode:
        return {
            "type": "FeatureCollection",
            "features": [],
            "note": "ACLED disabled (non-commercial licence); use GDELT/EONET",
        }
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
            geo_precision = parse_geo_precision(row.get("geo_precision"))
            country = row.get("country")
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
                        "country": country,
                        "fatalities": row.get("fatalities"),
                        "notes": row.get("notes"),
                        "date": row.get("event_date"),
                        "source": "acled",
                        "kind": "event",
                        # Location precision → uncertainty area (metres);
                        # radius_m is None when precision is unknown.
                        "geo_precision": geo_precision,
                        "radius_m": radius_for_geo_precision(geo_precision),
                        # Country + admin level so the frontend can shade the
                        # REAL admin unit. ACLED geo_precision 1=exact,
                        # 2=part of a larger settlement, 3=region/province.
                        "iso3": country_name_to_iso3(country) if country else None,
                        "shape_level": (
                            "adm2" if geo_precision in (1, 2)
                            else "adm1" if geo_precision == 3
                            else None
                        ),
                    },
                }
            )
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch(cache_key, 1800.0, load)


@router.get("/api/events/acled")
async def acled(
    days: int = Query(7, ge=1, le=90),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    return await _load_acled(settings, days)


# Honest upstream ceilings for the aggregate (documented, not "all of Earth"):
#   EONET   — limit caps at 500 open natural events worldwide.
#   GDELT   — GEO 2.0 caps maxrecords at 250 per call; 3-month rolling window.
#   ACLED   — up to 500 rows for the requested day window; key-gated.
# The /all endpoint fans out to all three, dedupes by feature id, and keeps
# only features within radius_km of (lat, lon). It is NOT a claim of complete
# global event coverage — it is the union of these three feeds near a point.
_EONET_MAX = 500
_GDELT_MAX = 250


@router.get("/api/events/all")
async def events_all(
    lat: float = Query(..., ge=-90.0, le=90.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    radius_km: float = Query(500.0, gt=0.0, le=20000.0),
    days: int = Query(7, ge=1, le=90),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Aggregate eonet + gdelt + acled, filtered to within radius_km of the
    given point. Returns ONE FeatureCollection of every matching event.

    Each source is loaded at its widest practical setting (see ceilings above)
    and then spatially filtered here — so a small radius still searches the
    whole feed, it just keeps fewer features. Sources that fail (or ACLED when
    unconfigured) degrade gracefully: their features are simply absent and a
    per-source status is reported in `sources`.
    """
    # GDELT timespan: ask for as long a window as the operator wants, capped to
    # GDELT's documented 3-month (~90 day) rolling window.
    gdelt_timespan = f"{min(days, 90)}d"

    results = await asyncio.gather(
        _load_eonet(status="open", category=None, limit=_EONET_MAX),
        _load_gdelt(timespan=gdelt_timespan, maxrecords=_GDELT_MAX),
        _load_acled(settings, days),
        return_exceptions=True,
    )
    labels = ("eonet", "gdelt", "acled")
    sources: dict[str, Any] = {}
    feats: list[dict[str, Any]] = []
    seen: set[str] = set()

    for label, res in zip(labels, results, strict=True):
        if isinstance(res, BaseException):
            sources[label] = {"ok": False, "error": str(res), "kept": 0}
            continue
        src_feats = (res or {}).get("features") or []
        kept = 0
        for f in src_feats:
            lonlat = feature_lonlat(f)
            if lonlat is None:
                continue
            flon, flat = lonlat
            if haversine_km(lon, lat, flon, flat) > radius_km:
                continue
            fid = f.get("id") or f"{label}:{flon:.5f},{flat:.5f}"
            if fid in seen:
                continue
            seen.add(fid)
            feats.append(f)
            kept += 1
        note = (res or {}).get("note")
        sources[label] = {
            "ok": True,
            "kept": kept,
            "available": len(src_feats),
            **({"note": note} if note else {}),
        }

    return {
        "type": "FeatureCollection",
        "features": feats,
        "center": {"lat": lat, "lon": lon, "radius_km": radius_km},
        "count": len(feats),
        "sources": sources,
    }
