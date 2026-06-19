"""Tile proxies — basemap, satellite imagery, terrain.

All routes share one pattern: typed-int z/x/y (no path traversal), disk
TileCache (fetch-once-per-TTL semantics, per-key coalescing), and
stale-on-upstream-failure so a dead provider degrades to frozen tiles, not
a blank globe. The browser only ever sees /tiles/* — providers are
swappable here in one place.

Sources (all keyless):
- basemap: Carto Dark Matter — (c) OpenStreetMap contributors, (c) CARTO.
- sat z<=13: EOX Sentinel-2 cloudless (s2maps.eu) — CC BY-NC-SA 4.0,
  attribution: "Sentinel-2 cloudless by EOX (Contains modified Copernicus
  Sentinel data)". Rendered in the frontend attribution footer.
- sat z>=14: Esri World Imagery legacy tile endpoint — attribution
  "(c) Esri"; high-zoom complement to the 10 m Sentinel mosaic.
- terrain: AWS Open Data Mapzen terrarium elevation tiles (z 0-15),
  transcoded per-tile to Mapbox terrain-RGB encoding because the frontend's
  cesium-martini worker decoder only understands that formula. The
  transcode runs once per tile ever — the disk cache stores the converted
  PNG.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException, Response

from app.config import Settings, get_settings
from app.imagery import cdse
from app.tier import commercial_request
from app.tilecache import TileCache
from app.upstream import get_client

router = APIRouter(tags=["tiles"])


def _recent_date() -> str:
    """A recent UTC date for CDSE Sentinel mosaics (leastCC over the lookback).
    Two days back to allow for processing/ingest latency."""
    return (dt.datetime.now(dt.UTC) - dt.timedelta(days=2)).strftime("%Y-%m-%d")

# Carto's basemap CDN. `dark_all` = dark with English labels everywhere.
CARTO_HOSTS = [
    "https://a.basemaps.cartocdn.com",
    "https://b.basemaps.cartocdn.com",
    "https://c.basemaps.cartocdn.com",
    "https://d.basemaps.cartocdn.com",
]

_EOX_LAYER = "s2cloudless-2024_3857"
# z <= split → EOX Sentinel-2 (10 m cloudless mosaic, broad/low-zoom);
# z > split → Esri World Imagery (sub-meter, sharp). Split lowered 13->10 so the
# sharp source kicks in earlier and city zooms aren't blurry.
_SAT_SPLIT_Z = 10

_TTL_BASEMAP = 30 * 86400.0
_TTL_SAT = 365 * 86400.0
_TTL_TERRAIN = 10 * 365 * 86400.0  # elevation doesn't change

# One TileCache per configured root. Keyed by root (not a singleton) so
# tests overriding tile_cache_dir get their own isolated cache.
_caches: dict[str, TileCache] = {}


def _cache_for(root: str, max_bytes: int = 0) -> TileCache:
    tc = _caches.get(root)
    if tc is None:
        tc = TileCache(root, max_bytes)
        _caches[root] = tc
    return tc


# A cold Cesium boot requests ~70 tiles at once; EOX (and friends) throttle
# that burst and the un-cached tiles 502 until the user pans back. Gate the
# upstream fetches and retry once with a short backoff so a cold start
# warms the cache cleanly instead of spraying failures. 24 (was 8): Esri /
# EOX both serve a CDN that tolerates this, and a fat client link otherwise
# sat idle behind the gate while a freshly-panned region loaded one slow
# batch at a time — the "imagery loads too slow" report. Esri/EOX answer 200
# well past 8 concurrent; only the airplanes.live ADS-B grid needs the strict
# 8 cap (different file, _UPSTREAM_SEMAPHORE).
_FETCH_SEMAPHORE = asyncio.Semaphore(24)


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


@router.get("/tiles/basemap/{z}/{x}/{y}.png")
async def basemap_tile(
    z: int,
    x: int,
    y: int,
    settings: Settings = Depends(get_settings),
    commercial: bool = Depends(commercial_request),
) -> Response:
    if not (0 <= z <= 22):
        raise HTTPException(400, "z out of range")
    # CARTO's hosted basemap tiles are enterprise/non-profit-only — not licensed
    # for our commercial SaaS. Commercial requests use a configurable
    # commercial-OK raster source (OpenFreeMap, a self-hosted OSM/Protomaps
    # renderer, MapTiler, …) via COMMERCIAL_BASEMAP_URL. See
    # docs/commercial-licensing.md.
    if commercial:
        tmpl = settings.commercial_basemap_url
        if not tmpl:
            raise HTTPException(
                503,
                "commercial basemap not configured — set COMMERCIAL_BASEMAP_URL "
                "(OpenFreeMap/self-host) or the client can fall back to satellite",
            )
        url, source, marker = tmpl.format(z=z, x=x, y=y), "commercial-base", "commercial"
    else:
        host = CARTO_HOSTS[(x + y) % len(CARTO_HOSTS)]  # round-robin shard
        url, source, marker = f"{host}/dark_all/{z}/{x}/{y}@2x.png", "carto", "carto-dark-matter"

    async def load() -> bytes | None:
        return await _fetch_bytes(url)

    data = await _cache_for(settings.tile_cache_dir, settings.tile_cache_max_bytes).get(
        source, z, x, y, "png", _TTL_BASEMAP, load
    )
    if data is None:
        raise HTTPException(502, "basemap upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400", "X-Basemap": marker},
    )


@router.get("/tiles/sat/{z}/{x}/{y}.jpg")
async def sat_tile(
    z: int,
    x: int,
    y: int,
    settings: Settings = Depends(get_settings),
    commercial: bool = Depends(commercial_request),
) -> Response:
    if not (0 <= z <= 19):
        raise HTTPException(400, "z out of range")
    # EOX Sentinel-2 cloudless is CC BY-NC-SA and Esri World Imagery forbids
    # commercial reuse, so commercial requests are served from CDSE Sentinel-2
    # (Copernicus open data — commercial-OK). Copernicus is 10 m, so the sharp
    # Esri high-zoom is dropped; the route caps at z14. See
    # docs/commercial-licensing.md.
    if commercial:
        if not cdse.available():
            raise HTTPException(503, "commercial satellite needs CDSE credentials")
        if z > 14:
            raise HTTPException(400, "z out of range (commercial Sentinel caps at 14)")
        date = _recent_date()
        source = "cdse-s2"
        media, ext = "image/jpeg", "jpg"

        async def load() -> bytes | None:
            return await cdse.fetch_tile("S2_L2A_TRUECOLOR", date, z, x, y)

        cache_key = f"cdse-s2/{date}"
    else:
        if z <= _SAT_SPLIT_Z:
            source = "eox"
            url = (
                f"https://tiles.maps.eox.at/wmts/1.0.0/{_EOX_LAYER}/default"
                f"/GoogleMapsCompatible/{z}/{y}/{x}.jpg"
            )
        else:
            source = "esri"
            url = (
                "https://services.arcgisonline.com/arcgis/rest/services"
                f"/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            )
        media, ext, cache_key = "image/jpeg", "jpg", source

        async def load() -> bytes | None:
            return await _fetch_bytes(url)

    data = await _cache_for(settings.tile_cache_dir, settings.tile_cache_max_bytes).get(
        cache_key, z, x, y, ext, _TTL_SAT, load
    )
    if data is None:
        raise HTTPException(502, "sat upstream failed")
    return Response(
        content=data,
        media_type=media,
        headers={"Cache-Control": "public, max-age=604800", "X-Sat-Source": source},
    )


def _terrarium_to_mapbox_rgb(png_bytes: bytes) -> bytes | None:
    """Re-encode a terrarium elevation PNG as Mapbox terrain-RGB.

    terrarium: elev = R*256 + G + B/256 - 32768
    mapbox:    elev = (R*65536 + G*256 + B)/10 - 10000
    Lazy numpy/PIL imports keep cold-start cost off every other route.
    """
    import numpy as np
    from PIL import Image

    try:
        img = Image.open(BytesIO(png_bytes)).convert("RGB")
        a = np.asarray(img, dtype=np.float64)
        elev = a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0
        v = np.clip((elev + 10000.0) * 10.0, 0.0, float(2**24 - 1)).astype(np.uint32)
        out = np.empty(a.shape, dtype=np.uint8)
        out[..., 0] = (v >> 16) & 0xFF
        out[..., 1] = (v >> 8) & 0xFF
        out[..., 2] = v & 0xFF
        buf = BytesIO()
        Image.fromarray(out, "RGB").save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        return None


@router.get("/tiles/terrain/{z}/{x}/{y}.png")
async def terrain_tile(
    z: int, x: int, y: int, settings: Settings = Depends(get_settings)
) -> Response:
    if not (0 <= z <= 15):
        raise HTTPException(400, "z out of range (terrarium max 15)")

    async def load() -> bytes | None:
        raw = await _fetch_bytes(
            f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        )
        if raw is None:
            return None
        return _terrarium_to_mapbox_rgb(raw)

    data = await _cache_for(settings.tile_cache_dir, settings.tile_cache_max_bytes).get(
        "terrain-rgb", z, x, y, "png", _TTL_TERRAIN, load
    )
    if data is None:
        raise HTTPException(502, "terrain upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=2592000"},
    )
