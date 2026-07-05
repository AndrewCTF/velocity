"""Satellite imagery tile proxy + catalog + focused-chip endpoint.

Mirrors tiles.py: typed-int z/x/y, disk TileCache (namespaced by
provider/layer/date so each day caches independently), stale-on-failure.
Keyless GIBS only in Phase 1.

The focused-chip endpoint (``/api/imagery/chip``) renders ONE image for a small
AOI (centre + radius) so a selected entity gets a tight, dated, honestly-labeled
satellite picture instead of the whole-globe overlay. It is KEYLESS by design
(no auth dependency, mirroring ``imagery_tile``) because the browser's
``SingleTileImageryProvider`` fetches the URL directly and cannot carry the
``apiFetch``/``withWsKey`` header.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app import memtier
from app.config import Settings, get_settings
from app.imagery import cdse, gibs, ondemand, tasking
from app.intel.geo import BBox
from app.tier import commercial_request
from app.tilecache import TileCache
from app.upstream import get_client

router = APIRouter(tags=["imagery"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEDIA = {"jpg": "image/jpeg", "png": "image/png"}
_TTL = 6 * 3600.0  # daily layer refreshes slowly; 6h disk cache

_caches: dict[str, TileCache] = {}
_FETCH_SEMAPHORE = asyncio.Semaphore(8)

# ── focused-chip endpoint ────────────────────────────────────────────────────
# Honest ground-sample-distance per source (metres/pixel). Never imply VHR when
# the pixels are actually Sentinel (10 m) or GIBS VIIRS (375 m).
_CHIP_SOURCES = ("auto", "maxar", "sentinel", "gibs")
_GSD_M = {"maxar": 0.5, "sentinel": 10.0, "gibs": 375.0}
_CHIP_MAX_PX = 2048
_CHIP_MIN_PX = 256
# Round the AOI bbox to this many decimal degrees so a moving entity reuses the
# same cached chip until it drifts a grid cell (~1.1 km at 0.01°). Keeps the
# cache key stable across the tiny per-poll position jitter.
_CHIP_GRID_DEG = 0.01
# GIBS VIIRS true-color is the keyless coarse fallback. We mosaic web-mercator
# tiles covering the AOI then crop to the exact bbox.
_GIBS_CHIP_LAYER = "VIIRS_SNPP_CorrectedReflectance_TrueColor"
# Cap the mosaic so a wide AOI can't request a huge tile grid: pick the zoom
# whose covering grid stays within this many tiles per axis.
_GIBS_MAX_TILES_PER_AXIS = 6

# ── multi-temporal change detection (B4) ─────────────────────────────────────
# Change chips are SENTINEL-ONLY: a clean before/after diff needs the Process
# API's two-window evalscript (cdse._S2_CHANGE / _S1_CHANGE). GIBS VIIRS has no
# honest two-date diff at 375 m, so when CDSE creds are absent the change route
# degrades to a 503 with an explicit reason — it never fakes a difference image.
_CHANGE_MODES = {"optical": "S2_CHANGE", "radar": "S1_CHANGE"}
# Sentinel change is gsd-honest at its native 10 m (S2) / ~10 m (S1 GRD).
_CHANGE_GSD_M = 10.0


def _round_bbox(b: BBox, grid: float = _CHIP_GRID_DEG) -> BBox:
    """Snap a bbox out to the enclosing grid cell — stable cache key for a
    drifting entity. Floors the min corner and ceils the max corner so the
    rounded box always CONTAINS the requested AOI (never clips it)."""
    return BBox(
        math.floor(b.min_lon / grid) * grid,
        math.floor(b.min_lat / grid) * grid,
        math.ceil(b.max_lon / grid) * grid,
        math.ceil(b.max_lat / grid) * grid,
    )


def _bbox_key(b: BBox) -> str:
    """Compact, filesystem-safe string for a (already-rounded) bbox."""
    return "_".join(f"{v:.4f}" for v in (b.min_lon, b.min_lat, b.max_lon, b.max_lat))


def chip_cache_key(source: str, bbox: BBox, date: str) -> str:
    """TileCache source-namespace: chip/{source}/{bbox_rounded}/{date}.

    bbox is rounded to the grid so a moving entity reuses chips; date keeps each
    requested day independent (like the tile proxy's provider/layer/date)."""
    return f"chip/{source}/{_bbox_key(_round_bbox(bbox))}/{date}"


def _chip_px(b: BBox) -> tuple[int, int]:
    """Pixel dimensions for an AOI bbox, preserving aspect, bounded to
    [_CHIP_MIN_PX, _CHIP_MAX_PX] on the long edge."""
    span_lon = max(1e-6, b.max_lon - b.min_lon)
    span_lat = max(1e-6, b.max_lat - b.min_lat)
    if span_lon >= span_lat:
        w = _CHIP_MAX_PX
        h = max(_CHIP_MIN_PX, int(_CHIP_MAX_PX * span_lat / span_lon))
    else:
        h = _CHIP_MAX_PX
        w = max(_CHIP_MIN_PX, int(_CHIP_MAX_PX * span_lon / span_lat))
    return w, h


def select_chip_source(source: str, *, maxar_hit: bool, cdse_ok: bool) -> str:
    """Resolve the source ladder to ONE concrete tier.

    auto: Maxar (VHR) where an event acquisition overlaps the AOI/date → else
    Sentinel-2 (10 m, needs CDSE creds) → else GIBS VIIRS (375 m, keyless).
    An explicit source is honoured when usable, else falls through honestly so
    the caller always gets pixels (never a hard fail when GIBS can serve)."""
    if source == "maxar":
        return "maxar" if maxar_hit else ("sentinel" if cdse_ok else "gibs")
    if source == "sentinel":
        return "sentinel" if cdse_ok else "gibs"
    if source == "gibs":
        return "gibs"
    # auto
    if maxar_hit:
        return "maxar"
    if cdse_ok:
        return "sentinel"
    return "gibs"


def _lon_to_tile_x(lon: float, z: int) -> float:
    return (lon + 180.0) / 360.0 * (2**z)


def _lat_to_tile_y(lat: float, z: int) -> float:
    lat = max(-85.05112878, min(85.05112878, lat))
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * (2**z)


def _tile_x_to_lon(x: float, z: int) -> float:
    return x / (2**z) * 360.0 - 180.0


def _tile_y_to_lat(y: float, z: int) -> float:
    n = math.pi - 2 * math.pi * y / (2**z)
    return math.degrees(math.atan(math.sinh(n)))


def _gibs_chip_zoom(b: BBox, max_z: int) -> int:
    """Largest zoom whose covering tile grid stays within
    _GIBS_MAX_TILES_PER_AXIS on each axis (so the mosaic is bounded)."""
    for z in range(max_z, -1, -1):
        x0 = math.floor(_lon_to_tile_x(b.min_lon, z))
        x1 = math.floor(_lon_to_tile_x(b.max_lon, z))
        y0 = math.floor(_lat_to_tile_y(b.max_lat, z))  # north → smaller y
        y1 = math.floor(_lat_to_tile_y(b.min_lat, z))
        if (x1 - x0 + 1) <= _GIBS_MAX_TILES_PER_AXIS and (
            y1 - y0 + 1
        ) <= _GIBS_MAX_TILES_PER_AXIS:
            return z
    return 0


async def _render_gibs_chip(b: BBox, date: str) -> bytes | None:
    """Mosaic GIBS VIIRS true-color web-mercator tiles covering the AOI, then
    crop to the exact bbox. Keyless coarse (375 m) fallback — Pillow stitch."""
    from PIL import Image

    meta = gibs.layer(_GIBS_CHIP_LAYER)
    z = _gibs_chip_zoom(b, meta["max_z"])
    x0 = math.floor(_lon_to_tile_x(b.min_lon, z))
    x1 = math.floor(_lon_to_tile_x(b.max_lon, z))
    y0 = math.floor(_lat_to_tile_y(b.max_lat, z))
    y1 = math.floor(_lat_to_tile_y(b.min_lat, z))
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    if cols <= 0 or rows <= 0:
        return None

    async def _one(tx: int, ty: int) -> tuple[int, int, bytes | None]:
        return tx, ty, await _fetch_bytes(gibs.tile_url(_GIBS_CHIP_LAYER, date, z, tx, ty))

    tiles = await asyncio.gather(
        *[_one(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
    )
    if not any(t[2] for t in tiles):
        return None

    ts = 256
    canvas = Image.new("RGB", (cols * ts, rows * ts), (12, 16, 24))
    for tx, ty, data in tiles:
        if not data:
            continue
        try:
            tile = Image.open(BytesIO(data)).convert("RGB")
        except Exception:  # noqa: BLE001 — skip an undecodable tile, keep the mosaic
            continue
        canvas.paste(tile, ((tx - x0) * ts, (ty - y0) * ts))

    # Crop the mosaic (whole-tile extent) down to the exact AOI bbox.
    mosaic_w_lon = _tile_x_to_lon(x1 + 1, z) - _tile_x_to_lon(x0, z)
    mosaic_h_lat = _tile_y_to_lat(y0, z) - _tile_y_to_lat(y1 + 1, z)
    if mosaic_w_lon <= 0 or mosaic_h_lat <= 0:
        return None
    px_per_lon = canvas.width / mosaic_w_lon
    px_per_lat = canvas.height / mosaic_h_lat
    left = int((b.min_lon - _tile_x_to_lon(x0, z)) * px_per_lon)
    right = int((b.max_lon - _tile_x_to_lon(x0, z)) * px_per_lon)
    top = int((_tile_y_to_lat(y0, z) - b.max_lat) * px_per_lat)
    bottom = int((_tile_y_to_lat(y0, z) - b.min_lat) * px_per_lat)
    left, right = max(0, left), min(canvas.width, max(left + 1, right))
    top, bottom = max(0, top), min(canvas.height, max(top + 1, bottom))
    cropped = canvas.crop((left, top, right, bottom))

    buf = BytesIO()
    cropped.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def _maxar_overlap(b: BBox, date: str) -> dict[str, Any] | None:
    """The nearest-in-time Maxar Open Data acquisition overlapping the AOI for
    the date, or None. Detection only — descending the COG to bbox-clipped
    pixels needs a warping tiler (B2/TiTiler, rasterio), absent here, so the
    chip records VHR availability but renders pixels from Sentinel/GIBS."""
    try:
        acqs = await ondemand.maxar_search(b, date)
    except Exception:  # noqa: BLE001 — Maxar STAC down → treat as no coverage
        return None
    return acqs[0] if acqs else None


async def render_chip(
    aoi: BBox, date: str, source: str, settings: Settings
) -> dict[str, Any] | None:
    """Render one AOI chip + its honest metadata.

    Returns ``{bytes, media_type, ext, meta}`` where ``meta`` carries
    ``provider, layer, datetime, gsd_m, cloud_pct, bbox`` — or None if no source
    could produce pixels. Caches the rendered bytes via TileCache keyed by
    ``chip/{source}/{bbox_rounded}/{date}`` so a drifting entity reuses chips.
    """
    cdse_ok = cdse.available()
    maxar_acq = await _maxar_overlap(aoi, date) if source in ("auto", "maxar") else None
    chosen = select_chip_source(source, maxar_hit=maxar_acq is not None, cdse_ok=cdse_ok)

    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))
    key = chip_cache_key(chosen, aoi, date)
    rb = _round_bbox(aoi)
    bbox_3857 = cdse.lonlat_bbox_3857(rb.min_lon, rb.min_lat, rb.max_lon, rb.max_lat)
    w, h = _chip_px(rb)

    meta: dict[str, Any] = {
        "provider": chosen,
        "bbox": rb.as_dict(),
        "datetime": None,
        "gsd_m": _GSD_M[chosen],
        "cloud_pct": None,
        "layer": None,
        "note": None,
    }

    if chosen == "sentinel":
        layer_id = "S2_L2A_TRUECOLOR"
        meta["layer"] = layer_id
        ext = cdse.layer(layer_id)["ext"]

        async def load_s2() -> bytes | None:
            return await cdse.fetch_image(layer_id, bbox_3857, w, h, date)

        data = await cache.get(key, 0, 0, 0, ext, _TTL, load_s2)
        if data is None:
            # Sentinel returned nothing (clouds/gap) — fall to keyless GIBS.
            chosen = "gibs"
        else:
            return {"bytes": data, "media_type": _MEDIA[ext], "ext": ext, "meta": meta}

    if chosen == "maxar" and maxar_acq is not None:
        # VHR exists but we cannot warp/clip the COG here (no tiler) — surface
        # the acquisition honestly and render the actual pixels from Sentinel
        # (preferred) or GIBS so the operator still gets a chip.
        meta["datetime"] = maxar_acq.get("datetime")
        meta["note"] = (
            "Maxar Open Data VHR acquisition overlaps this AOI but COG rendering "
            "requires the tiler; showing coarser pixels below"
        )
        if cdse_ok:
            layer_id = "S2_L2A_TRUECOLOR"
            ext = cdse.layer(layer_id)["ext"]
            s2_key = chip_cache_key("sentinel", aoi, date)

            async def load_s2m() -> bytes | None:
                return await cdse.fetch_image(layer_id, bbox_3857, w, h, date)

            data = await cache.get(s2_key, 0, 0, 0, ext, _TTL, load_s2m)
            if data is not None:
                meta["provider"] = "sentinel"
                meta["layer"] = layer_id
                meta["gsd_m"] = _GSD_M["sentinel"]
                return {"bytes": data, "media_type": _MEDIA[ext], "ext": ext, "meta": meta}
        chosen = "gibs"
        meta["provider"] = "gibs"
        meta["gsd_m"] = _GSD_M["gibs"]

    if chosen == "gibs":
        meta["provider"] = "gibs"
        meta["layer"] = _GIBS_CHIP_LAYER
        meta["gsd_m"] = _GSD_M["gibs"]
        gibs_key = chip_cache_key("gibs", aoi, date)

        async def load_gibs() -> bytes | None:
            return await _render_gibs_chip(rb, date)

        data = await cache.get(gibs_key, 0, 0, 0, "jpg", _TTL, load_gibs)
        if data is not None:
            return {"bytes": data, "media_type": _MEDIA["jpg"], "ext": "jpg", "meta": meta}

    return None


def change_cache_key(mode: str, bbox: BBox, before: str, after: str) -> str:
    """TileCache source-namespace for a change chip:
    ``change/{mode}/{bbox_rounded}/{before}_{after}``. bbox rounded to the grid
    (drift reuse, like the chip key); both dates namespace the rendered diff."""
    return f"change/{mode}/{_bbox_key(_round_bbox(bbox))}/{before}_{after}"


async def render_change_chip(
    aoi: BBox, before: str, after: str, mode: str, settings: Settings
) -> dict[str, Any] | None:
    """Render one multi-temporal CHANGE chip + honest metadata.

    SENTINEL-ONLY (B4): the before/after diff is the Process-API two-window
    evalscript (``cdse.fetch_change_image``). Returns ``{bytes, media_type,
    ext, meta}`` — ``meta`` carries ``provider='sentinel'`` (or 'sentinel-sar'),
    ``layer, before, after, gsd_m, bbox`` — or None when CDSE has no usable pair
    for the AOI/dates. Never falls back to a fake GIBS difference; the route
    turns a None / no-creds into an explicit 503 so the operator is never shown
    an invented change image. Cached by ``change/{mode}/{bbox}/{before}_{after}``
    so a drifting entity reuses the diff."""
    if not cdse.available():
        return None
    layer_id = _CHANGE_MODES[mode]
    rb = _round_bbox(aoi)
    bbox_3857 = cdse.lonlat_bbox_3857(rb.min_lon, rb.min_lat, rb.max_lon, rb.max_lat)
    w, h = _chip_px(rb)
    ext = cdse.change_layer(layer_id)["ext"]

    cache = _cache_for(settings.tile_cache_dir, _tile_budget(settings))
    key = change_cache_key(mode, aoi, before, after)

    async def load_change() -> bytes | None:
        return await cdse.fetch_change_image(layer_id, bbox_3857, w, h, before, after)

    data = await cache.get(key, 0, 0, 0, ext, _TTL, load_change)
    if data is None:
        return None

    meta: dict[str, Any] = {
        "provider": "sentinel" if mode == "optical" else "sentinel-sar",
        "layer": layer_id,
        "mode": mode,
        "before": before,
        "after": after,
        "gsd_m": _CHANGE_GSD_M,
        "bbox": rb.as_dict(),
        # The diverging palette legend so the client can label it honestly.
        "legend": {"red": "loss / decrease", "green": "gain / increase"},
        "note": (
            "Diverging change vs. the two passes — red = loss/decrease, "
            "green = gain/increase. Not live; each window mosaics nearby passes."
        ),
    }
    return {"bytes": data, "media_type": _MEDIA[ext], "ext": ext, "meta": meta}


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


@router.get("/api/imagery/aoi")
async def imagery_aoi(
    before: str = Query(..., description="before date, YYYY-MM-DD"),
    after: str = Query(..., description="after date, YYYY-MM-DD"),
    lat: float | None = Query(None),
    lon: float | None = Query(None),
    radius_km: float = Query(5.0, ge=0.1, le=100.0),
    min_lon: float | None = Query(None),
    min_lat: float | None = Query(None),
    max_lon: float | None = Query(None),
    max_lat: float | None = Query(None),
    window_days: int = Query(30, ge=1, le=120, description="Maxar ± date window"),
    commercial: bool = Depends(commercial_request),
) -> dict:
    """On-demand building imagery by location + before/after dates.

    Set a location (lat/lon + radius_km, OR an explicit min/max bbox) and two
    dates. Returns what imagery is available per provider — Maxar Open Data VHR
    (event-gated) and Sentinel 10 m (global) — WITHOUT downloading anything.
    Maxar is CC BY-NC, so it is omitted for commercial-tier requests.
    Downloading-to-temp for reconstruction is `app.imagery.ondemand.scratch_aoi`.
    """
    for d in (before, after):
        if not _DATE_RE.match(d):
            raise HTTPException(400, "dates must be YYYY-MM-DD")
    bbox = None
    if None not in (min_lon, min_lat, max_lon, max_lat):
        bbox = (min_lon, min_lat, max_lon, max_lat)
    elif lat is None or lon is None:
        raise HTTPException(400, "provide lat+lon (+radius_km) or a min/max bbox")
    try:
        aoi = ondemand.aoi_bbox(lat=lat, lon=lon, radius_km=radius_km, bbox=bbox)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return await ondemand.search_aoi(aoi, before, after, window_days, commercial=commercial)


@router.get("/api/imagery/chip")
async def imagery_chip(
    lat: float = Query(..., ge=-85.0, le=85.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    radius_km: float = Query(4.0, ge=0.1, le=100.0),
    date: str = Query("", description="YYYY-MM-DD; omit for today (UTC)"),
    source: str = Query("auto"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """One focused satellite chip for a small AOI (centre + radius_km).

    KEYLESS by design (no auth dep, mirrors ``imagery_tile``): the browser's
    ``SingleTileImageryProvider`` fetches this URL itself and cannot attach the
    auth header. Returns a single PNG/JPG for the AOI bbox; the source +
    resolution + acquisition are reported HONESTLY in headers and a JSON sidecar
    (``X-Chip`` JSON header + ``X-Imagery-*`` fields) so the client never implies
    VHR when the pixels are Sentinel (10 m) or GIBS VIIRS (375 m).

    Source ladder (``auto``): Maxar Open Data VHR where an event acquisition
    overlaps the AOI/date → Sentinel-2 true-color (10 m, needs CDSE creds) →
    GIBS VIIRS true-color mosaic (375 m, keyless). Degrades gracefully with no
    CDSE creds (falls to GIBS) — never 500s, never fakes resolution.
    """
    if not date:
        date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    if source not in _CHIP_SOURCES:
        raise HTTPException(400, f"source must be one of {_CHIP_SOURCES}")
    try:
        aoi = ondemand.aoi_bbox(lat=lat, lon=lon, radius_km=radius_km)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    result = await render_chip(aoi, date, source, settings)
    if result is None:
        raise HTTPException(502, "no imagery source could render this AOI")

    meta = result["meta"]
    return Response(
        content=result["bytes"],
        media_type=result["media_type"],
        headers={
            "Cache-Control": "public, max-age=21600",
            "X-Chip": json.dumps(meta, separators=(",", ":")),
            "X-Imagery-Provider": str(meta["provider"]),
            "X-Imagery-Gsd-M": str(meta["gsd_m"]),
            "X-Imagery-Datetime": str(meta.get("datetime") or ""),
            # Expose the sidecar to the browser fetch (CORS-safe custom headers).
            "Access-Control-Expose-Headers": (
                "X-Chip, X-Imagery-Provider, X-Imagery-Gsd-M, X-Imagery-Datetime"
            ),
        },
    )


@router.post("/api/imagery/splat")
async def imagery_splat(
    lat: float = Query(..., ge=-85.0, le=85.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    radius_km: float = Query(2.0, ge=0.1, le=20.0),
    date: str = Query(..., description="YYYY-MM-DD"),
    source: str = Query("auto"),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """AOI satellite chip → 3D Gaussian Splat (MapAnything feed-forward).

    Renders one chip for the AOI from ANY available source (the same ladder as
    ``/api/imagery/chip``: Maxar Open Data VHR → Sentinel-2 10 m → GIBS), then
    launches a single-image MapAnything recon job. Returns ``{job_id, source}``;
    the client reuses the existing ``/api/recon/jobs/{id}/events`` SSE +
    ``result.ply`` + Spark viewer.

    HONEST: a single overhead chip yields a near-2.5D relief splat (a textured
    surface), strongest where the source is fine (VHR) — not true building 3D,
    which needs multi-view (the EOGS path). The source + GSD are reported back.
    """
    from app.routes import recon  # local import avoids a route-module import cycle

    if not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    if source not in _CHIP_SOURCES and source != "eusi":
        raise HTTPException(400, f"source must be one of {_CHIP_SOURCES} or 'eusi'")
    try:
        aoi = ondemand.aoi_bbox(lat=lat, lon=lon, radius_km=radius_km)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    if source == "eusi":
        # Multi-view: ≥2 ≤1 m/px EUSI chips of the SAME point from diverse
        # off-nadir angles → real parallax → real 3D (relief ~38% vs ~1% for a
        # single overhead chip; proven). keyless + server-side, no browser.
        from app import eusi
        half_m = min(radius_km * 1000.0 / 2.0, 128.0)  # ≤128 m box ⇒ ≤1 m/px at 256px
        n_angles = 3
        chips = await eusi.multiview_chips(lat, lon, n_angles=n_angles, half_m=half_m)
        if len(chips) < 2:
            raise HTTPException(
                502,
                f"EUSI returned {len(chips)} views — note the keyless EUSI TARA archive "
                "(apps.euspaceimaging.com/atom/api/tara) now answers ROUTE_NOT_FOUND "
                "(backend moved to authenticated access), and even when it served, its "
                "exportImage tiles carry NO RPC camera model → only a flat 2.5D splat. "
                "For real satellite 3D use POST /api/recon/sat (keyless WV-3 + RPC, IARPA MVS3DM).",
            )
        imgs = [(f"eusi_v{i}_{int(m['off_nadir'])}deg.png", png) for i, (png, m) in enumerate(chips)]
        job_id = recon.register_image_job(imgs, mode="mapany")
        return {
            "job_id": job_id,
            "source": "eusi",
            "mode": "multiview",
            "n_views": len(chips),
            "gsd_m": chips[0][1]["gsd_m"],
            "views": chips[0][1],  # representative; full list in job logs
        }

    result = await render_chip(aoi, date, source, settings)
    if result is None:
        raise HTTPException(502, "no imagery source could render this AOI")
    ext = result["ext"]
    job_id = recon.register_image_job([(f"aoi.{ext}", result["bytes"])], mode="mapany")
    return {"job_id": job_id, "source": result["meta"]["provider"], "meta": result["meta"]}


@router.get("/api/imagery/change")
async def imagery_change(
    lat: float = Query(..., ge=-85.0, le=85.0),
    lon: float = Query(..., ge=-180.0, le=180.0),
    radius_km: float = Query(4.0, ge=0.1, le=100.0),
    before: str = Query(..., description="earlier date, YYYY-MM-DD"),
    after: str = Query(..., description="later date, YYYY-MM-DD"),
    mode: str = Query("optical", description="optical (S2) | radar (S1)"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """One multi-temporal CHANGE chip for an AOI between two dates (B4).

    KEYLESS by design (no auth dep, mirrors ``imagery_chip`` / ``imagery_tile``)
    so the browser's ``SingleTileImageryProvider`` can fetch it directly. Renders
    a Sentinel before/after difference (diverging palette: red = loss, green =
    gain) via the Process-API two-window evalscript.

    SENTINEL-ONLY: a clean diff needs CDSE creds. With none set this returns 503
    with an honest reason — it NEVER fabricates a difference image from the
    coarse GIBS mosaic. Honest metadata in ``X-Chip`` + ``X-Imagery-*`` headers
    (gsd 10 m, both acquisition windows, the palette legend)."""
    for d in (before, after):
        if not _DATE_RE.match(d):
            raise HTTPException(400, "dates must be YYYY-MM-DD")
    if before >= after:
        raise HTTPException(400, "before date must be earlier than after date")
    if mode not in _CHANGE_MODES:
        raise HTTPException(400, f"mode must be one of {tuple(_CHANGE_MODES)}")
    if not cdse.available():
        # Honest, not faked: change detection requires the Sentinel two-window
        # Process API. Same 503 shape the CDSE tile path uses when unconfigured.
        raise HTTPException(503, "change detection requires CDSE credentials")
    try:
        aoi = ondemand.aoi_bbox(lat=lat, lon=lon, radius_km=radius_km)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    result = await render_change_chip(aoi, before, after, mode, settings)
    if result is None:
        raise HTTPException(502, "no Sentinel pair could render change for this AOI/dates")

    meta = result["meta"]
    return Response(
        content=result["bytes"],
        media_type=result["media_type"],
        headers={
            "Cache-Control": "public, max-age=21600",
            "X-Chip": json.dumps(meta, separators=(",", ":")),
            "X-Imagery-Provider": str(meta["provider"]),
            "X-Imagery-Gsd-M": str(meta["gsd_m"]),
            "X-Imagery-Datetime": str(meta.get("after") or ""),
            "Access-Control-Expose-Headers": (
                "X-Chip, X-Imagery-Provider, X-Imagery-Gsd-M, X-Imagery-Datetime"
            ),
        },
    )


@router.get("/api/imagery/detect")
async def imagery_detect(
    min_lon: float = Query(...),
    min_lat: float = Query(...),
    max_lon: float = Query(...),
    max_lat: float = Query(...),
    date: str = Query(...),
    layer: str = Query("S2_L2A_TRUECOLOR", max_length=64),
) -> dict[str, Any]:
    """YOLO object detection over a satellite chip → geo-referenced GeoJSON.

    Degrades honestly: empty features + a note when CDSE imagery or the CUDA YOLO
    sidecar is unavailable, never a fabricated detection.
    """
    if not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    from app.imagery import detect

    return await detect.detect_chip([min_lon, min_lat, max_lon, max_lat], date, layer)


@router.get("/api/imagery/tasking/providers")
async def imagery_tasking_providers(
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Tasking-provider capability map (B5): which on-demand collection
    providers exist and whether each is configured. Never leaks a token — only
    the env-var NAME the operator must set. Reachable so the UI can show the
    capability greyed-out before a paid request."""
    provs = [p.as_dict() for p in tasking.providers(settings)]
    return {"providers": provs, "any_configured": any(p["configured"] for p in provs)}


class TaskRequest(BaseModel):
    """POST body for ``/api/imagery/task`` (B5)."""

    provider: str
    lat: float = Field(..., ge=-90.0, le=90.0)
    lon: float = Field(..., ge=-180.0, le=180.0)
    radius_km: float = Field(4.0, ge=0.1, le=100.0)
    window_hours: int = Field(72, ge=1, le=720)


@router.post("/api/imagery/task")
async def imagery_task(
    req: TaskRequest,
    commercial: bool = Depends(commercial_request),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    """Commission an ON-DEMAND satellite collection over an AOI (B5).

    GATED by the EXISTING ``commercial_request`` dependency: tasking is a paid,
    commercial capability, so only a ``paid``-tier request (or a commercial
    deployment) may reach the adapter; a free/non-commercial request gets 402.

    Body: ``{provider, lat, lon, radius_km?, window_hours?}``. ``provider`` is
    one of ICEYE / Umbra / Planet. With NO paid provider credential set this
    returns an honest ``status='degraded'`` body (HTTP 200) naming the missing
    credential — it never fabricates an order id and never bills. No secrets are
    hardcoded; creds are read from the deployment Settings."""
    if not commercial:
        # The capability is commercial-only. A non-entitled request is refused
        # honestly rather than served a fake/free tasking order.
        raise HTTPException(
            402, "on-demand tasking is a commercial capability (paid tier required)"
        )

    provider_id = req.provider.strip().lower()
    if provider_id not in tasking.PROVIDERS:
        raise HTTPException(400, f"provider must be one of {tasking.PROVIDERS}")
    try:
        aoi = ondemand.aoi_bbox(lat=req.lat, lon=req.lon, radius_km=req.radius_km)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None

    return await tasking.submit_task(
        provider_id, aoi, window_hours=req.window_hours, settings=settings
    )


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

    data = await _cache_for(settings.tile_cache_dir, _tile_budget(settings)).get(
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
