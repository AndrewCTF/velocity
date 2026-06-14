"""Satellite imagery tile proxy + catalog.

Mirrors tiles.py: typed-int z/x/y, disk TileCache (namespaced by
provider/layer/date so each day caches independently), stale-on-failure.
Keyless GIBS only in Phase 1.
"""

from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.config import Settings, get_settings
from app.imagery import cdse, gibs
from app.tilecache import TileCache
from app.upstream import get_client

router = APIRouter(tags=["imagery"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEDIA = {"jpg": "image/jpeg", "png": "image/png"}
_TTL = 6 * 3600.0  # daily layer refreshes slowly; 6h disk cache

_caches: dict[str, TileCache] = {}
_FETCH_SEMAPHORE = asyncio.Semaphore(8)


def _cache_for(root: str) -> TileCache:
    tc = _caches.get(root)
    if tc is None:
        tc = TileCache(root)
        _caches[root] = tc
    return tc


async def _fetch_bytes(url: str) -> bytes | None:
    async with _FETCH_SEMAPHORE:
        for attempt in (0, 1):
            try:
                r = await get_client().get(url)
            except Exception:
                r = None
            if r is not None and r.status_code == 200:
                return r.content
            if attempt == 0:
                await asyncio.sleep(0.5)
    return None


@router.get("/api/imagery/catalog")
async def imagery_catalog() -> dict:
    layers = [{"provider": "gibs", **layer} for layer in gibs.catalog()]
    layers += [{"provider": "cdse", **layer} for layer in cdse.catalog()]
    return {"layers": layers}


@router.get("/api/imagery/{provider}/{layer}/{z}/{x}/{y}")
async def imagery_tile(
    provider: str,
    layer: str,
    z: int,
    x: int,
    y: int,
    date: str = Query(..., description="YYYY-MM-DD"),
    settings: Settings = Depends(get_settings),
) -> Response:
    if provider not in ("gibs", "cdse"):
        raise HTTPException(404, "unknown provider")
    if not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    try:
        if provider == "gibs":
            meta = gibs.layer(layer)
            url = gibs.tile_url(layer, date, z, x, y)

            async def load() -> bytes | None:
                return await _fetch_bytes(url)
        else:
            if not cdse.available():
                raise HTTPException(503, "cdse credentials not configured")
            meta = cdse.layer(layer)

            async def load() -> bytes | None:
                return await cdse.fetch_tile(layer, date, z, x, y)
    except KeyError:
        raise HTTPException(404, "unknown layer") from None
    if not (0 <= z <= meta["max_z"]):
        raise HTTPException(400, "z out of range")

    data = await _cache_for(settings.tile_cache_dir).get(
        f"{provider}/{layer}/{date}", z, x, y, meta["ext"], _TTL, load
    )
    if data is None:
        raise HTTPException(502, "imagery upstream failed")
    return Response(
        content=data,
        media_type=_MEDIA[meta["ext"]],
        headers={
            "Cache-Control": "public, max-age=21600",
            "X-Imagery": f"gibs/{layer}",
        },
    )
