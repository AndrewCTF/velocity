"""SAR dark-vessel detection — Sentinel-1 VV bright-target detection over a
sea AOI, cross-referenced against the AIS observation store.

Baseline (no learned model): a robust global CFAR-style threshold on the SAR
amplitude, block-suppression of large bright regions (land/coast), then
connected-component extraction of small compact bright blobs (vessels). Each
detection is mapped pixel->lon/lat and matched to the nearest AIS contact; a
detection with no AIS match in an AOI that HAS AIS coverage is a dark-vessel
candidate.

Honest limitation: the keyless AIS feeds cover Northern Europe (Kystverket /
Digitraffic), not the Gulf. Over the Strait of Hormuz the store has ~no AIS, so
`ais_coverage` is reported and detections are flagged `darkCandidate: null`
(unknown) rather than falsely asserted dark — a global AIS source (AISStream)
is required to confirm dark vessels there.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Any

import numpy as np

from app.correlate.store import store
from app.imagery import cdse

_R = 6378137.0

# Strait of Hormuz default AOI (lon0, lat0, lon1, lat1).
AOIS: dict[str, tuple[float, float, float, float]] = {
    "hormuz": (55.9, 26.4, 56.9, 27.1),
}


def epsg3857_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon = math.degrees(x / _R)
    lat = math.degrees(2.0 * math.atan(math.exp(y / _R)) - math.pi / 2.0)
    return lon, lat


def _pixel_lonlat(bbox: list[float], w: int, h: int, col: float, row: float) -> tuple[float, float]:
    minx, miny, maxx, maxy = bbox
    x = minx + (col + 0.5) / w * (maxx - minx)
    y = maxy - (row + 0.5) / h * (maxy - miny)  # row 0 = top = maxy
    return epsg3857_to_lonlat(x, y)


def detect_targets(
    arr: np.ndarray,
    k: float = 4.0,
    min_area: int = 2,
    max_area: int = 400,
    land_block: int = 16,
    land_fill: float = 0.5,
) -> list[dict[str, Any]]:
    """Find small bright blobs (vessels) in a 2-D SAR amplitude array.

    Robust threshold = median + k * 1.4826 * MAD. Blocks that are mostly bright
    (land/coast) are suppressed. Remaining bright pixels are grouped by
    8-connectivity (union-find over the sparse set); components with area in
    [min_area, max_area] are returned as detections with pixel centroids.
    """
    a = arr.astype(np.float32)
    med = float(np.median(a))
    mad = float(np.median(np.abs(a - med))) or 1.0
    thr = med + k * 1.4826 * mad
    mask = a > thr

    # Suppress large bright regions (land/coast): zero blocks that are mostly lit.
    h, w = mask.shape
    bh, bw = h // land_block, w // land_block
    if bh and bw:
        crop = mask[: bh * land_block, : bw * land_block]
        blocks = crop.reshape(bh, land_block, bw, land_block)
        fill = blocks.mean(axis=(1, 3))  # fraction lit per block
        land = np.repeat(np.repeat(fill > land_fill, land_block, 0), land_block, 1)
        crop[land] = False

    ys, xs = np.nonzero(mask)
    if len(ys) == 0 or len(ys) > 80_000:  # nothing, or threshold too low
        return []

    # Union-find over the sparse lit pixels (8-neighborhood).
    index = {(int(r), int(c)): i for i, (r, c) in enumerate(zip(ys, xs, strict=True))}
    parent = list(range(len(ys)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i, (r, c) in enumerate(zip(ys, xs, strict=True)):
        for dr, dc in ((0, 1), (1, -1), (1, 0), (1, 1)):
            j = index.get((int(r) + dr, int(c) + dc))
            if j is not None:
                union(i, j)

    comps: dict[int, list[int]] = {}
    for i in range(len(ys)):
        comps.setdefault(find(i), []).append(i)

    out: list[dict[str, Any]] = []
    for members in comps.values():
        area = len(members)
        if area < min_area or area > max_area:
            continue
        rr = ys[members]
        cc = xs[members]
        out.append(
            {
                "row": float(rr.mean()),
                "col": float(cc.mean()),
                "area_px": area,
                "peak": float(a[rr, cc].max()),
            }
        )
    return out


def _ais_match(
    lon: float, lat: float, vessels: list[tuple[float, float]], radius_deg: float
) -> bool:
    for vlon, vlat in vessels:
        if abs(vlon - lon) <= radius_deg and abs(vlat - lat) <= radius_deg:
            return True
    return False


async def detect_dark_vessels(
    aoi: str = "hormuz",
    date: str | None = None,
    width: int = 768,
    height: int = 640,
    k: float = 4.0,
) -> dict[str, Any]:
    """Fetch a Sentinel-1 VV scene for the AOI, detect vessels, cross-ref AIS.

    Returns a GeoJSON FeatureCollection (+ summary). Also returns the raw SAR
    bytes + detections under non-GeoJSON keys for the verification overlay.
    """
    import datetime as dt

    if aoi not in AOIS:
        raise KeyError(aoi)
    if date is None:
        date = dt.datetime.now(dt.UTC).strftime("%Y-%m-%d")
    bbox = cdse.lonlat_bbox_3857(*AOIS[aoi])
    img = await cdse.fetch_image("S1_GRD_VV", bbox, width, height, date)
    if not img:
        return {
            "type": "FeatureCollection",
            "features": [],
            "summary": {"aoi": aoi, "date": date, "error": "no SAR imagery"},
        }
    from PIL import Image

    arr = np.asarray(Image.open(BytesIO(img)).convert("L"))
    targets = detect_targets(arr, k=k)

    # AIS coverage for the AOI from the observation store (keyless feeds).
    lon0, lat0, lon1, lat1 = AOIS[aoi]
    vessels = [
        (o.lon, o.lat)
        for o in store.latest("vessel")
        if lon0 <= o.lon <= lon1 and lat0 <= o.lat <= lat1
    ]
    has_ais = len(vessels) > 0
    radius_deg = 0.02  # ~2 km

    features: list[dict[str, Any]] = []
    dark = 0
    for t in targets:
        lon, lat = _pixel_lonlat(bbox, width, height, t["col"], t["row"])
        matched = _ais_match(lon, lat, vessels, radius_deg)
        # Only assert "dark" when AIS coverage exists; else unknown (null).
        dark_candidate: bool | None = (not matched) if has_ais else None
        if dark_candidate:
            dark += 1
        features.append(
            {
                "type": "Feature",
                "id": f"sar:{aoi}:{t['row']:.0f}:{t['col']:.0f}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "kind": "vessel",
                    "source": "sentinel1-sar",
                    "aisMatch": matched,
                    "darkCandidate": dark_candidate,
                    "areaPx": t["area_px"],
                    "peak": t["peak"],
                },
            }
        )
    return {
        "type": "FeatureCollection",
        "features": features,
        "summary": {
            "aoi": aoi,
            "date": date,
            "detections": len(features),
            "ais_coverage": len(vessels),
            "dark_candidates": dark,
        },
        "_sar_png": img,
        "_targets": targets,
        "_bbox": bbox,
        "_size": [width, height],
    }
