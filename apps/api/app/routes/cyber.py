"""GET /api/cyber/* — network/cyber situational awareness.

- /api/cyber/ioda/outages — IODA (CAIDA) outage events. No auth.
- /api/cyber/cloudflare/outages — Cloudflare Radar annotations (outages).
  Requires CF_RADAR_TOKEN; returns empty when missing.

Both feed the `cyber_outage_geo` correlation rule (research_updated.md §1.3).
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["cyber"])


_IODA_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
_IODA_ERROR_TTL = 60.0  # cache unavailable results briefly so a dead upstream doesn't flood CAIDA


@router.get("/api/cyber/ioda/outages")
async def ioda_outages(days: int = Query(7, ge=1, le=30)) -> dict[str, Any]:
    key = f"ioda:outages:{days}"

    async def load() -> dict[str, Any]:
        # IODA exposes outage events; we pass through with a stable shape.
        # Use a tight per-request timeout so a slow/down CAIDA API fails fast
        # (~8s) rather than blocking for the shared client's 15s timeout.
        # On ANY failure, return a typed unavailable payload (NOT raise) so
        # the handler can short-TTL-cache it and the caller degrades gracefully.
        try:
            r = await get_client().get(
                "https://api.ioda.caida.org/v2/outages/events",
                params={"from": f"-{days}d", "until": "now"},
                timeout=_IODA_TIMEOUT,
            )
        except httpx.TimeoutException as e:
            return {"items": [], "unavailable": True, "note": f"ioda timeout: {e}"}
        except httpx.HTTPError as e:
            return {"items": [], "unavailable": True, "note": f"ioda transport: {e}"}
        if r.status_code != 200:
            return {"items": [], "unavailable": True, "note": f"ioda upstream {r.status_code}"}
        try:
            j = r.json()
        except ValueError:
            return {"items": [], "unavailable": True, "note": "ioda non-json body"}
        return {"items": j.get("data") or j.get("events") or []}

    result = await cache.get_or_fetch(key, 1800.0, load)
    # Short-circuit error results to a brief TTL so a transient outage doesn't
    # pin an unavailable response for the full 30 min.
    if result.get("unavailable"):
        cache.shorten(key, _IODA_ERROR_TTL)
    return result


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
