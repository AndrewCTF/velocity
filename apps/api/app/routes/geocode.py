"""GET /api/geocode?q=<city> — forward geocode a place name to coordinates.

Uses OSM Nominatim (keyless). Mirrors the reverse-geocode client/cache pattern
in app/routes/entity.py (_nominatim_reverse): one shared httpx client with a
contactable User-Agent ('osint-console/0.1'), results cached so we respect
Nominatim's usage policy (no more than one query/second sustained, cache
results, identify yourself). Returns a small list of candidate matches the
operator can pick from: [{name, lat, lon, type}].
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["geocode"])


@router.get("/api/geocode")
async def geocode(
    q: str = Query(..., min_length=1, max_length=200, description="place / city name"),
    limit: int = Query(8, ge=1, le=20),
) -> dict[str, Any]:
    """Forward-geocode a free-text place name into candidate coordinates.

    Cached 24h per (query, limit): a city's coordinates don't move, and caching
    keeps us well within Nominatim's usage policy even if the operator retypes
    the same search. Returns {"results": [{name, lat, lon, type}, ...]}.
    """
    norm = q.strip().lower()
    if not norm:
        raise HTTPException(400, "empty query")
    # Public Nominatim forbids commercial/heavy use; commercial deployments must
    # set NOMINATIM_URL (self-host). OSM data itself is ODbL (commercial-OK).
    s = get_settings()
    base = s.nominatim_url or ("" if s.commercial_mode else "https://nominatim.openstreetmap.org")
    if not base:
        raise HTTPException(503, "geocode disabled: set NOMINATIM_URL for commercial use")
    cache_key = f"nominatim:fwd:{norm}:{limit}"

    async def load() -> dict[str, Any]:
        try:
            r = await get_client().get(
                f"{base.rstrip('/')}/search",
                params={
                    "q": q.strip(),
                    "format": "jsonv2",
                    "limit": limit,
                    "addressdetails": "0",
                },
                headers={"User-Agent": "osint-console/0.1"},
            )
        except Exception as exc:  # noqa: BLE001 — surface as a clean 502
            raise HTTPException(502, "geocode upstream unreachable") from exc
        if r.status_code != 200:
            raise HTTPException(502, f"geocode upstream {r.status_code}")
        try:
            rows = r.json()
        except Exception:
            return {"results": []}
        results: list[dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            try:
                lat = float(row["lat"])
                lon = float(row["lon"])
            except (KeyError, TypeError, ValueError):
                continue
            results.append(
                {
                    "name": row.get("display_name") or row.get("name") or q.strip(),
                    "lat": lat,
                    "lon": lon,
                    # Nominatim 'type' (e.g. city, town, administrative) plus
                    # the broader 'class' help the operator disambiguate.
                    "type": row.get("type") or row.get("class") or "place",
                }
            )
        return {"results": results}

    return await cache.get_or_fetch(cache_key, 24 * 3600.0, load)
