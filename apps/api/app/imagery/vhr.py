"""Keyless VHR optical imagery via Esri Wayback (World Imagery archive).

Esri's Wayback service serves the dated releases of World Imagery as XYZ tiles —
WorldView-3 ~0.3 m in cities/ports, keyless. We fetch a tile grid over an AOI bbox,
stitch it into one mosaic array, and read the real acquisition date per tile from the
release's metadata layer. This is the only keyless sub-metre OPTICAL source that works
from a server (GIBS caps at ~10-30 m; EUSI's data API is dead; Maxar Open Data is
event-gated — handled separately).

HONEST LIMIT: World Imagery is a DATED ORTHO MOSAIC, not a live pass — a tile can be
months old, and the release date is NOT the acquisition date. Always surface `src_date`
(queried from the metadata layer) so a detection is never mistaken for "right now".
ToS note: World Imagery is licensed for use within Esri/ArcGIS apps; bulk scraping is
ToS-gray — fine for one-off OSINT research, not for productionizing.
"""

from __future__ import annotations

import asyncio
import math
from io import BytesIO
from typing import Any

import httpx

_CONFIG_URL = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json"
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126 Safari/537.36"
)
_MAX_TILES = 64  # guard: a stitched mosaic is at most 8x8 tiles (2048px)

_client: httpx.AsyncClient | None = None
_config: dict[str, Any] | None = None
_latest: dict[str, Any] | None = None  # {"num","title","tile_tmpl","meta_url"}


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        # Browser UA + follow redirects (tiles 301) + IPv4 (host IPv6 is broken).
        _client = httpx.AsyncClient(
            headers={"User-Agent": _UA},
            follow_redirects=True,
            timeout=30.0,
            transport=httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=1),
        )
    return _client


def available() -> bool:
    return True  # keyless


def _deg2tile(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def _tile2deg(x: int, y: int, z: int) -> tuple[float, float]:
    """NW corner (lon, lat) of tile x,y at zoom z."""
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


async def _load_latest() -> dict[str, Any] | None:
    """Resolve the newest Wayback release's tile template + metadata layer url."""
    global _config, _latest
    if _latest is not None:
        return _latest
    try:
        r = await _get_client().get(_CONFIG_URL)
        _config = r.json()
    except Exception:  # noqa: BLE001
        return None
    # Config is {releaseNum: {itemTitle, itemURL, metadataLayerUrl, ...}}. Newest =
    # the entry whose title carries the latest date; fall back to the max numeric key.
    best_num = None
    best_title = ""
    for num, v in _config.items():
        if not isinstance(v, dict) or "itemURL" not in v:
            continue
        title = str(v.get("itemTitle", ""))
        if best_num is None or title > best_title:
            best_num, best_title, best_item = num, title, v
    if best_num is None:
        return None
    _latest = {
        "num": best_num,
        "title": best_title,
        "tile_tmpl": best_item["itemURL"],  # …/tile/{level}/{row}/{col}
        "meta_url": best_item.get("metadataLayerUrl"),
    }
    return _latest


async def _src_date(lon: float, lat: float, meta_url: str | None) -> str | None:
    """Real acquisition date (SRC_DATE) at a point from the release metadata layer."""
    if not meta_url:
        return None
    try:
        r = await _get_client().get(
            f"{meta_url}/identify",
            params={
                "geometry": f"{lon},{lat}",
                "geometryType": "esriGeometryPoint",
                "sr": "4326",
                "returnGeometry": "false",
                "tolerance": "1",
                "mapExtent": f"{lon-0.01},{lat-0.01},{lon+0.01},{lat+0.01}",
                "imageDisplay": "100,100,96",
                "f": "json",
            },
        )
        results = r.json().get("results") or []
        if results:
            attrs = results[0].get("attributes", {})
            return attrs.get("SRC_DATE") or attrs.get("SRC_DATE2") or None
    except Exception:  # noqa: BLE001
        pass
    return None


async def fetch_mosaic(
    bbox_lonlat: tuple[float, float, float, float], z: int = 18
) -> dict[str, Any] | None:
    """Fetch + stitch a VHR mosaic over ``(lon0, lat0, lon1, lat1)`` at zoom ``z``.

    Returns ``{png, width, height, bbox, z, src_date, tiles}`` where ``bbox`` is the
    TRUE stitched extent (tile-aligned, ≥ requested) and ``png`` are JPEG/PNG bytes,
    or None if the release can't be resolved. z18 ≈ 0.6 m/px, z19 ≈ 0.3 m/px.
    """
    from PIL import Image  # local import: Pillow is heavy, only needed here

    rel = await _load_latest()
    if rel is None:
        return None
    lon0, lat0, lon1, lat1 = bbox_lonlat
    x0, y1 = _deg2tile(min(lat0, lat1), min(lon0, lon1), z)  # SW → (min lon, min lat)
    x1, y0 = _deg2tile(max(lat0, lat1), max(lon0, lon1), z)  # NE
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    if nx * ny > _MAX_TILES:
        # Too many tiles for this zoom/box — caller should use a smaller box or lower z.
        return {"error": f"box needs {nx*ny} tiles (> {_MAX_TILES}); shrink bbox or lower z"}

    tmpl = rel["tile_tmpl"]

    async def one(tx: int, ty: int) -> tuple[int, int, bytes | None]:
        url = tmpl.replace("{level}", str(z)).replace("{row}", str(ty)).replace("{col}", str(tx))
        try:
            r = await _get_client().get(url)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                return tx, ty, r.content
        except Exception:  # noqa: BLE001
            pass
        return tx, ty, None

    sem = asyncio.Semaphore(8)

    async def guarded(tx: int, ty: int) -> tuple[int, int, bytes | None]:
        async with sem:
            return await one(tx, ty)

    tiles = await asyncio.gather(
        *[guarded(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
    )

    mosaic = Image.new("RGB", (nx * 256, ny * 256))
    got = 0
    for tx, ty, content in tiles:
        if content is None:
            continue
        try:
            im = Image.open(BytesIO(content)).convert("RGB")
        except Exception:  # noqa: BLE001
            continue
        mosaic.paste(im, ((tx - x0) * 256, (ty - y0) * 256))
        got += 1
    if got == 0:
        return None

    nw_lon, nw_lat = _tile2deg(x0, y0, z)
    se_lon, se_lat = _tile2deg(x1 + 1, y1 + 1, z)
    buf = BytesIO()
    mosaic.save(buf, format="JPEG", quality=85)
    cx, cy = (nw_lon + se_lon) / 2, (nw_lat + se_lat) / 2
    return {
        "png": buf.getvalue(),
        "width": nx * 256,
        "height": ny * 256,
        "bbox": (nw_lon, se_lat, se_lon, nw_lat),  # (lon0,lat0,lon1,lat1)
        "z": z,
        "release": rel["title"],
        "src_date": await _src_date(cx, cy, rel["meta_url"]),
        "tiles": got,
    }
