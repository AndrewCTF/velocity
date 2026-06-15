"""SAR dark-vessel detection — Sentinel-1 VV bright-target detection over a
sea AOI, cross-referenced against the AIS observation store.

Baseline (no learned model): a robust global CFAR-style threshold on the SAR
amplitude, block-suppression of large bright regions (land/coast), then
connected-component extraction of small compact bright blobs (vessels). Each
detection is mapped pixel->lon/lat and matched to the nearest AIS contact; a
detection with no AIS match in an AOI that HAS AIS coverage is a dark-vessel
candidate.

Honest limitation: the keyless AIS feeds cover Northern Europe (Kystverket NMEA
firehose, Digitraffic Baltic, Kystdatahuset Norway — see the consolidated
`/api/maritime/keyless` endpoint), not the maritime chokepoints these AOIs sit
on (Strait of Hormuz, Bab-el-Mandeb, Gulf of Aden, Gulf of Suez, Kerch Strait,
Taiwan Strait). Over those boxes the store has ~no AIS, so `ais_coverage` is
reported and detections are flagged `darkCandidate: null` (unknown) rather than
falsely asserted dark — a keyed AIS source (e.g. AISStream) is required to
confirm a detection is non-broadcasting there. A detection only becomes a
`darkCandidate: true` when the AOI actually HAS AIS in the store and no contact
sits within the match radius.
"""

from __future__ import annotations

import math
from io import BytesIO
from typing import Any

import numpy as np

from app.correlate.store import store
from app.imagery import cdse

_R = 6378137.0

# Water-dominant AOIs. Land contamination is the main false-positive source for a
# coastline-mask-free baseline, so the boxes are kept small (~0.3-0.6 deg) and
# open-water so one Sentinel-1 IW GRD scene covers each and CFAR stays tractable.
# A proper coastline/OSM-water mask (Spec A) would let the AOI include the coast.
#
# Each entry: key -> (label, (lon0, lat0, lon1, lat1)). Sentinel-1 GRD coverage
# was probed against the CDSE OData catalogue (products intersecting the box in
# the last 30 days) and the box was confirmed to return a non-blank S1_GRD_VV
# scene with bright-target signal before being added here.
AOIS: dict[str, tuple[str, tuple[float, float, float, float]]] = {
    # Central Strait of Hormuz shipping channel (water).
    "hormuz": ("Strait of Hormuz", (56.35, 26.50, 56.85, 26.78)),
    # Fujairah anchorage at the Gulf-of-Oman approaches to Hormuz — one of the
    # busiest tanker anchorages on earth; clean open-water demo.
    "fujairah": ("Fujairah anchorage", (56.46, 24.98, 56.82, 25.45)),
    # Southern Red Sea funnel between Perim Island and Djibouti — all Suez-bound
    # traffic, heavy AIS-off / dark-fleet behaviour. Probed: 44 GRD products /30d,
    # latest 2026-06-12; full-swath VV scene with bright targets.
    "bab-el-mandeb": ("Bab-el-Mandeb Strait", (43.18, 12.50, 43.52, 12.82)),
    # Eastern approach to Bab-el-Mandeb off Berbera/Bosaso — historic piracy
    # waters, AIS-dark dhows/ship-to-ship transfers. Probed: 18 GRD products /30d,
    # latest 2026-06-14; partial-swath but clear bright-target signal.
    "gulf-of-aden": ("Gulf of Aden approaches", (45.05, 11.85, 45.60, 12.35)),
    # Southern queuing/anchorage approach to the Suez Canal — dense tanker/cargo
    # concentration with known AIS gaps. Probed: 50 GRD products /30d, latest
    # 2026-06-11; full-swath VV scene, strongest signal of the Red Sea set.
    "suez-gulf-approach": ("Gulf of Suez southern approach", (32.48, 29.70, 32.74, 30.02)),
    # Kerch Strait gate to the Sea of Azov — contested Russia/Ukraine choke with
    # shadow-fleet / AIS-off traffic. Probed: 66 GRD products /30d, latest
    # 2026-06-14. Land flanks the channel (pixel mean ~200), so detect_targets'
    # land_block suppression carries more load here; raise k or shrink the box if
    # coastal false positives appear.
    "kerch-strait": ("Kerch Strait", (36.32, 45.08, 36.70, 45.42)),
    # Narrowest part of the Taiwan Strait off Pingtan — gray-zone militia /
    # dredger activity often AIS-dark. Probed: 32 GRD products /30d, latest
    # 2026-06-14; full-swath VV scene, water-dominant box.
    "taiwan-strait": ("Taiwan Strait (off Pingtan)", (119.25, 24.45, 119.80, 24.92)),
}


def aoi_bbox(aoi: str) -> tuple[float, float, float, float]:
    """Lon/lat corners (lon0, lat0, lon1, lat1) for a registered AOI key."""
    return AOIS[aoi][1]


def aoi_label(aoi: str) -> str:
    return AOIS[aoi][0]


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
    width: int = 1000,
    height: int = 760,
    k: float = 5.0,
    max_area: int = 120,
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
    aoi_box = aoi_bbox(aoi)
    bbox = cdse.lonlat_bbox_3857(*aoi_box)
    img = await cdse.fetch_image("S1_GRD_VV", bbox, width, height, date)
    if not img:
        return {
            "type": "FeatureCollection",
            "features": [],
            "summary": {"aoi": aoi, "date": date, "error": "no SAR imagery"},
        }
    from PIL import Image

    arr = np.asarray(Image.open(BytesIO(img)).convert("L"))
    targets = detect_targets(arr, k=k, max_area=max_area)

    # AIS coverage for the AOI from the observation store (keyless feeds).
    lon0, lat0, lon1, lat1 = aoi_box
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
            "label": aoi_label(aoi),
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
