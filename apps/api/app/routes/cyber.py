"""GET /api/cyber/* — network/cyber situational awareness.

- /api/cyber/ioda/outages — IODA (CAIDA) outage events. No auth.
- /api/cyber/cloudflare/outages — Cloudflare Radar annotations (outages).
  Requires CF_RADAR_TOKEN; returns empty when missing.

Both feed the `cyber_outage_geo` correlation rule (research_updated.md §1.3).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["cyber"])


@router.get("/api/cyber/ioda/outages")
async def ioda_outages(days: int = Query(7, ge=1, le=30)) -> dict[str, Any]:
    key = f"ioda:outages:{days}"

    async def load() -> dict[str, Any]:
        # IODA exposes outage events; we pass through with a stable shape
        r = await get_client().get(
            "https://api.ioda.caida.org/v2/outages/events",
            params={"from": f"-{days}d", "until": "now"},
        )
        # RAISE on failure: get_or_fetch only caches loader RETURNS, so an
        # upstream blip stays uncached and retries next call instead of
        # pinning an "error" payload for the full 30-min TTL.
        if r.status_code != 200:
            raise HTTPException(502, f"ioda upstream {r.status_code}")
        j = r.json()
        return {"items": j.get("data") or j.get("events") or []}

    return await cache.get_or_fetch(key, 1800.0, load)


@router.get("/api/cyber/cloudflare/outages")
async def cloudflare_outages(
    range_days: int = Query(7, ge=1, le=30),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    token = getattr(settings, "cloudflare_token", "") or ""
    if not token:
        return {"items": [], "note": "CLOUDFLARE_TOKEN not configured"}

    key = f"cfradar:outages:{range_days}"

    async def load() -> dict[str, Any]:
        r = await get_client().get(
            "https://api.cloudflare.com/client/v4/radar/annotations/outages",
            params={"dateRange": f"{range_days}d"},
            headers={"Authorization": f"Bearer {token}"},
        )
        if r.status_code != 200:
            raise HTTPException(502, f"cloudflare radar upstream {r.status_code}")
        j = r.json()
        return {"items": (j.get("result") or {}).get("annotations") or []}

    return await cache.get_or_fetch(key, 1800.0, load)
