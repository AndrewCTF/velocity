"""European Space Imaging (EUSI) ATOM/TARA archive — KEYLESS connector.

Proven-live 2026-06-26 (no auth, no browser, server-side httpx):
  - POST /atom/api/tara/library/search/ogc?bbox=<minLon,minLat,maxLon,maxLat>&limit=N
        → features: catalogID, sensor, productResolution, stripCloudCoverage,
          areaAverageOffNadir, objectid (== ImageServer lockRasterId), geometry.
  - GET  /atom/api/tara/services/ImageServer/exportImage?BBOX=<3857>&size=256,256
         &mosaicRule={esriMosaicLockRaster,lockRasterIds:[objectid]} ...
        → a 256px PNG tile of that scene. **size is capped at 256**, so ground-
         sample-distance = bbox_width/256: a ≤256 m box ⇒ ≤1 m/px (operator's
         "consistent max 1 m/px" target). KEYLESS — the JWT only gates /user.

The browse quicklook (`browserUrl` .browse.tif, ~11 m/px) is only materialised
for a few cached demo IDs, so the REAL pixel source is exportImage, which serves
the full-resolution mosaic. It is flaky under rapid repeated calls to the same
raster (`UPSTREAM_REQUEST_FAILED`) → all fetches retry with backoff.

MULTI-VIEW = real 3D: a single overhead satellite chip splats flat (relief ~1%,
proven), but feeding ≥2 views of the SAME ground from different off-nadir angles
to MapAnything triangulates real parallax → relief jumps to ~19% (proven). This
module finds diverse-angle covering scenes and fetches their ≤1 m chips.
"""

from __future__ import annotations

import asyncio
import json
import math
import urllib.parse
from io import BytesIO
from typing import Any

from app.intel.geo import BBox
from app.upstream import get_client

_SEARCH = "https://apps.euspaceimaging.com/atom/api/tara/library/search/ogc"
_EXPORT = "https://apps.euspaceimaging.com/atom/api/tara/services/ImageServer/exportImage"
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36"
)
_HDRS = {"User-Agent": _UA, "Accept": "image/png,application/json,*/*"}

# Web Mercator (EPSG:3857) — R_EARTH, NOT the half-circumference. Using the
# latter puts Y off by ~π and every lat/lon probe lands at the wrong latitude
# (the blank-probe bug from the first session).
_R = 6378137.0


def _x(lon: float) -> float:
    return _R * lon * math.pi / 180.0


def _y(lat: float) -> float:
    return _R * math.log(math.tan(math.pi / 4 + lat * math.pi / 360.0))


def _f(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _rank(scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Legacy browse ranking: usable quicklooks, low cloud, then finer GSD."""
    ranked = [s for s in scenes if s.get("browserUrl")]
    ranked.sort(
        key=lambda s: (
            (_f(s.get("stripCloudCoverage")) if _f(s.get("stripCloudCoverage")) is not None
             else 100.0),
            _f(s.get("productResolution")) if _f(s.get("productResolution")) is not None else 999.0,
        ),
    )
    return ranked


async def search(aoi: BBox, limit: int = 400) -> list[dict[str, Any]]:
    """Archive features overlapping *aoi* (keyless OGC search). Empty on error."""
    bbox = f"{aoi.min_lon},{aoi.min_lat},{aoi.max_lon},{aoi.max_lat}"
    try:
        r = await get_client().post(
            _SEARCH,
            params={"bbox": bbox, "limit": limit}, headers=_HDRS, timeout=30.0,
        )
        r.raise_for_status()
        data = r.json()
    except Exception:  # noqa: BLE001 — upstream flakiness must not 500 the route
        return []
    if isinstance(data, list):
        return data
    return data.get("features", []) if isinstance(data, dict) else []


def _covering_candidates(
    scenes: list[dict[str, Any]], *, max_cloud: float = 15.0
) -> list[dict[str, Any]]:
    """Scenes with an objectid + low cloud, sorted by off-nadir (most diverse
    angles first when sampled from both ends)."""
    out = [
        s for s in scenes
        if s.get("objectid") and (_f(s.get("stripCloudCoverage")) or 99) < max_cloud
    ]
    out.sort(key=lambda s: _f(s.get("areaAverageOffNadir")) or 99)
    return out


def _diverse_pick(cands: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """Pick *n* scenes spread across the off-nadir range (nadir → oblique)."""
    if not cands:
        return []
    if n >= len(cands):
        return cands
    return [cands[int(i * (len(cands) - 1) / max(n - 1, 1))] for i in range(n)]


async def export_tile(
    oid: int, lon: float, lat: float, half_m: float, *, retries: int = 4
) -> bytes | None:
    """One ≤(2*half_m/256) m/px PNG tile of scene *oid* centred on (lon,lat).
    Returns PNG bytes, or None if the raster doesn't cover the point / upstream
    failed after *retries*. Backs off because EUSI's mosaic 500s under repeats."""
    cx, cy = _x(lon), _y(lat)
    mr = urllib.parse.quote(
        json.dumps({"mosaicMethod": "esriMosaicLockRaster", "lockRasterIds": [oid]})
    )
    url = (
        f"{_EXPORT}?BBOX={cx-half_m},{cy-half_m},{cx+half_m},{cy+half_m}"
        f"&size=256,256&bboxSR=3857&imageSR=102100&format=png8&f=image&pixelType=U8"
        f"&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&mosaicRule={mr}"
    )
    client = get_client()
    for attempt in range(retries):
        try:
            r = await client.get(url, headers=_HDRS, timeout=30.0)
            ctype = r.headers.get("content-type", "")
            if "image" in ctype and len(r.content) > 3000:
                return r.content
        except Exception:  # noqa: BLE001
            pass
        # upstream flake / no coverage — brief backoff before retry/next scene
        await asyncio.sleep(1.0 * (attempt + 1))
    return None


async def multiview_chips(
    lat: float, lon: float, *, n_angles: int = 2, half_m: float = 120.0,
    max_cloud: float = 15.0,
) -> list[tuple[bytes, dict[str, Any]]]:
    """Fetch *n_angles* ≤1 m/px chips of the SAME point from diverse off-nadir
    EUSI scenes → real multi-view 3D. Each chip is (PNG bytes, meta). Fewer than
    n_angles if coverage is thin (degrades gracefully; never raises).

    half_m≤128 keeps GSD ≤1 m/px (operator target). Probes candidates for actual
    on-point coverage (a scene overlapping the search bbox may still miss the
    exact point — its imaged swath is a narrow diagonal strip).
    """
    d = (half_m / 111000.0) * 3.0  # search box a few× the tile so the strip is caught
    aoi = BBox(min_lon=lon - d, min_lat=lat - d, max_lon=lon + d, max_lat=lat + d)
    cands = _covering_candidates(await search(aoi), max_cloud=max_cloud)
    picked = _diverse_pick(cands, max(n_angles * 3, n_angles + 2))  # oversample for coverage misses
    chips: list[tuple[bytes, dict[str, Any]]] = []
    seen_angles: list[float] = []
    for s in picked:
        off = _f(s.get("areaAverageOffNadir")) or 0.0
        # keep angles spread (≥6° apart) so the views add parallax, not redundancy
        if any(abs(off - a) < 6.0 for a in seen_angles):
            continue
        png = await export_tile(int(s["objectid"]), lon, lat, half_m)
        if not png:
            continue
        seen_angles.append(off)
        chips.append((png, {
            "provider": "eusi", "catalogID": s.get("catalogID"), "sensor": s.get("sensor"),
            "gsd_m": round(2 * half_m / 256.0, 2), "off_nadir": round(off, 1),
            "res_m": _f(s.get("productResolution")),
        }))
        if len(chips) >= n_angles:
            break
    return chips


# ── legacy single-image browse path (source="eusi" on /api/imagery/splat) ─────
# Kept for completeness but the browse quicklook is ~11 m/px and rarely
# materialised; the multi-view exportImage path above is the real one.
async def fetch_browse(url: str) -> bytes | None:
    try:
        r = await get_client().get(url, headers=_HDRS, timeout=60.0)
        r.raise_for_status()
    except Exception:  # noqa: BLE001
        return None
    ctype = r.headers.get("content-type", "")
    if "image" not in ctype and "tif" not in ctype:
        return None
    return r.content


async def best_chip(aoi: BBox, max_try: int = 8) -> tuple[bytes, dict[str, Any]] | None:
    """Coarse keyless browse chip (~11 m/px) if one is materialised. Prefer
    `multiview_chips` for real ≤1 m 3D."""
    from PIL import Image  # local import keeps module import cheap

    scenes = _covering_candidates(await search(aoi))
    for s in scenes[:max_try]:
        url = s.get("browserUrl")
        if not url:
            continue
        raw = await fetch_browse(url)
        if not raw:
            continue
        try:
            buf = BytesIO()
            Image.open(BytesIO(raw)).convert("RGB").save(buf, format="PNG")
        except Exception:  # noqa: BLE001
            continue
        return buf.getvalue(), {
            "provider": "eusi", "catalogID": s.get("catalogID"), "sensor": s.get("sensor"),
            "gsd_m": _f(s.get("productResolution")),
            "cloud_pct": _f(s.get("stripCloudCoverage")),
            "tier": "browse-quicklook (~11 m/px); use multiview for ≤1 m 3D",
        }
    return None
