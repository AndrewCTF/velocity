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
- apple: Apple Maps satellite, keyless via the signed-session protocol in
  `app/apple_maps.py`. NON-COMMERCIAL: the route refuses a commercial tier.
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

from app import apple_maps, memtier
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
    else:
        tc.max_bytes = max_bytes  # keep the cap live as the RAM budget shifts
    return tc


def _tile_budget(settings: Settings) -> int:
    """Disk-cache byte cap sized to available RAM, capped by the config ceiling."""
    return memtier.cache_budget_bytes(
        "tilecache", floor=256 * 1024**2, ceil=int(settings.tile_cache_max_bytes)
    )


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

    data = await _cache_for(settings.tile_cache_dir, _tile_budget(settings)).get(
        source, z, x, y, "png", _TTL_BASEMAP, load
    )
    if data is None:
        raise HTTPException(502, "basemap upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=86400, immutable", "X-Basemap": marker},
    )


# Low-zoom world tiles to pre-fetch at boot so the FIRST browser load hits warm
# disk instead of a cold ~70-tile burst to the CDN (the "map takes a while to
# become clear" report). z0..4 = 341 tiles covers the world view + the first few
# zooms; cached _TTL_BASEMAP (30 d) so a warm run is a disk read, and an upstream
# pull happens at most once per ~month of uptime.
_WARM_MAX_Z = 4


async def warm_basemap() -> None:
    """Pre-fill the basemap tile cache for the low-zoom world view. Fire-and-
    forget from the lifespan; a failed tile just stays cold for the request to
    fill. Reuses the route's get_or_fetch + _FETCH_SEMAPHORE path verbatim."""
    settings = get_settings()
    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))
    # Warm the source this deployment actually serves: commercial base if
    # configured, else Carto dark. ponytail: warms one source; add a free+
    # commercial tier split only if a deployment serves both from cold.
    tmpl = settings.commercial_basemap_url
    source = "commercial-base" if tmpl else "carto"

    async def warm_one(z: int, x: int, y: int) -> None:
        if tmpl:
            url = tmpl.format(z=z, x=x, y=y)
        else:
            host = CARTO_HOSTS[(x + y) % len(CARTO_HOSTS)]
            url = f"{host}/dark_all/{z}/{x}/{y}@2x.png"

        async def load() -> bytes | None:
            return await _fetch_bytes(url)

        try:
            await cache.get(source, z, x, y, "png", _TTL_BASEMAP, load)
        except Exception:  # noqa: BLE001 — a cold tile is non-fatal
            pass

    await asyncio.gather(
        *(
            warm_one(z, x, y)
            for z in range(_WARM_MAX_Z + 1)
            for x in range(2**z)
            for y in range(2**z)
        )
    )


def _sat_url(z: int, x: int, y: int) -> tuple[str, str]:
    """(upstream URL, cache source) for a single non-commercial sat tile."""
    if z <= _SAT_SPLIT_Z:
        return (
            f"https://tiles.maps.eox.at/wmts/1.0.0/{_EOX_LAYER}/default"
            f"/GoogleMapsCompatible/{z}/{y}/{x}.jpg",
            "eox",
        )
    return (
        "https://services.arcgisonline.com/arcgis/rest/services"
        f"/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "esri",
    )


# ponytail: max z where z+1 tiles exist for stitching. Esri caps at z19; beyond
# that we fall back to the unstitched 256px tile.
_SAT_STITCH_MAX_Z = 18


async def _stitch_sat_2x(
    z: int, x: int, y: int, cache: TileCache
) -> bytes | None:
    """Fetch four z+1 children and stitch into one 512×512 JPEG.

    Each child is individually cache-eligible, so a later zoom into the area
    finds them warm. Lazy PIL import keeps cold paths free of the import cost.
    """
    children = [(z + 1, 2 * x + dx, 2 * y + dy) for dy in (0, 1) for dx in (0, 1)]

    async def fetch_child(cz: int, cx: int, cy: int) -> bytes | None:
        url, source = _sat_url(cz, cx, cy)

        async def load() -> bytes | None:
            return await _fetch_bytes(url)

        return await cache.get(source, cz, cx, cy, "jpg", _TTL_SAT, load)

    tiles = await asyncio.gather(*(fetch_child(*c) for c in children))
    if any(t is None for t in tiles):
        return None

    from PIL import Image

    imgs = [Image.open(BytesIO(t)) for t in tiles]
    out = Image.new("RGB", (512, 512))
    # TMS child layout: (dx=0,dy=0)=top-left, (1,0)=top-right, (0,1)=bot-left, (1,1)=bot-right
    out.paste(imgs[0], (0, 0))
    out.paste(imgs[1], (256, 0))
    out.paste(imgs[2], (0, 256))
    out.paste(imgs[3], (256, 256))
    buf = BytesIO()
    out.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


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
    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))
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
    elif z <= _SAT_STITCH_MAX_Z:
        # Retina: stitch four z+1 children → 512×512. Cached under its own key
        # so the individual 256px children remain usable at their native zoom.
        _, source = _sat_url(z, x, y)
        media, ext, cache_key = "image/jpeg", "jpg", f"{source}-2x"

        async def load() -> bytes | None:
            return await _stitch_sat_2x(z, x, y, cache)
    else:
        # z=19: no z+1 children, serve the native 256px tile.
        url, source = _sat_url(z, x, y)
        media, ext, cache_key = "image/jpeg", "jpg", source

        async def load() -> bytes | None:
            return await _fetch_bytes(url)

    data = await cache.get(cache_key, z, x, y, ext, _TTL_SAT, load)
    if data is None:
        raise HTTPException(502, "sat upstream failed")
    return Response(
        content=data,
        media_type=media,
        headers={"Cache-Control": "public, max-age=604800, immutable", "X-Sat-Source": source},
    )


@router.get("/tiles/apple/{z}/{x}/{y}.jpg")
async def apple_tile(
    z: int,
    x: int,
    y: int,
    settings: Settings = Depends(get_settings),
    commercial: bool = Depends(commercial_request),
) -> Response:
    """Apple Maps satellite, keyless (`app/apple_maps.py` holds the protocol).

    Sharper than the Esri/Sentinel stack over most cities and it is the only
    basemap here whose high zoom comes from Apple's own capture. Non-commercial
    only: Apple's ToS is not a redistribution licence, so a commercial-tier
    request is refused rather than quietly served.
    """
    if not (0 <= z <= 19):
        raise HTTPException(400, "z out of range")
    if commercial:
        raise HTTPException(451, "Apple Maps tiles are not licensed for commercial reuse")

    async def load() -> bytes | None:
        return await apple_maps.fetch_tile(z, x, y)

    data = await _cache_for(settings.tile_cache_dir, _tile_budget(settings)).get(
        "apple-sat-2x", z, x, y, "jpg", _TTL_SAT, load
    )
    if data is None:
        raise HTTPException(502, "Apple tile upstream failed")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=604800, immutable", "X-Sat-Source": "apple"},
    )


_APPLE_WARM_MAX_Z = 6


async def warm_apple() -> None:
    """Pre-fill the Apple tile cache for z0-6 (5461 tiles).

    Same fire-and-forget spirit as warm_basemap(). The signing session must be
    alive first (bootstrapped in the lifespan), so this is called AFTER the
    session task. With the 24-slot semaphore in apple_maps this takes ~4 min
    on a cold cache; subsequent boots skip already-cached tiles instantly.
    """
    settings = get_settings()
    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))

    async def warm_one(z: int, x: int, y: int) -> None:
        async def load() -> bytes | None:
            return await apple_maps.fetch_tile(z, x, y)

        try:
            await cache.get("apple-sat-2x", z, x, y, "jpg", _TTL_SAT, load)
        except Exception:  # noqa: BLE001
            pass

    await asyncio.gather(
        *(
            warm_one(z, x, y)
            for z in range(_APPLE_WARM_MAX_Z + 1)
            for x in range(2**z)
            for y in range(2**z)
        )
    )


@router.post("/tiles/apple/prefetch")
async def apple_prefetch(
    z: int,
    x_min: int,
    y_min: int,
    x_max: int,
    y_max: int,
    settings: Settings = Depends(get_settings),
) -> Response:
    """Pre-fetch a viewport's worth of Apple tiles into the disk cache.

    Called by the frontend when the camera stops moving — the next zoom level's
    tiles are fetched in the background so zooming in hits warm cache.
    """
    if not (0 <= z <= 19):
        raise HTTPException(400, "z out of range")
    # Cap the prefetch area to avoid abuse (max 64 tiles per call).
    nx = min(x_max - x_min + 1, 8)
    ny = min(y_max - y_min + 1, 8)
    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))

    async def warm_one(x: int, y: int) -> None:
        async def load() -> bytes | None:
            return await apple_maps.fetch_tile(z, x, y)
        try:
            await cache.get("apple-sat-2x", z, x, y, "jpg", _TTL_SAT, load)
        except Exception:  # noqa: BLE001
            pass

    asyncio.ensure_future(asyncio.gather(
        *(warm_one(x_min + dx, y_min + dy) for dx in range(nx) for dy in range(ny))
    ))
    return Response(status_code=202)


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

    data = await _cache_for(settings.tile_cache_dir, _tile_budget(settings)).get(
        "terrain-rgb", z, x, y, "png", _TTL_TERRAIN, load
    )
    if data is None:
        raise HTTPException(502, "terrain upstream failed")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=2592000, immutable"},
    )
