"""LOD1 building GeoJSON for the globe — real OSM footprints + heights + S1 SAR
damage flag, served so Cesium can extrude them into an interactive 3D city.

Honest: footprints = OSM (surveyed/detected); heights = OSM tags where present
else an area-typical estimate (flagged per feature via `height_src`); damage =
Sentinel-1 backscatter-drop (real but noisy). No invented geometry.
"""

from __future__ import annotations

import asyncio
import time
import urllib.parse
import urllib.request
from typing import Any

from app.imagery import cdse
from app.intel import sar_damage

DEFAULT_H = 18.0
MAXB = 6000
_OVERPASS = "https://overpass-api.de/api/interpreter"

# aoi -> (bbox lon0,lat0,lon1,lat1, sar_pre, sar_post). Reuses sar_damage AOIs.
DAMAGE_DATES = {
    "beirut-dahieh": ("2024-08-20", "2024-11-25"),
    "gaza-city": ("2023-09-20", "2024-08-01"),
}

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_TTL = 12 * 3600.0


def _fetch_footprints(bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    lon0, lat0, lon1, lat1 = bbox
    q = f'[out:json][timeout:120];(way["building"]({lat0},{lon0},{lat1},{lon1}););out geom;'
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(_OVERPASS, data=data, headers={"User-Agent": "osint-research/1.0"})
    import json

    d = json.loads(urllib.request.urlopen(req, timeout=150).read())
    out = []
    for e in d.get("elements", []):
        g = e.get("geometry")
        if e.get("type") != "way" or not g or len(g) < 4:
            continue
        ring = [[p["lon"], p["lat"]] for p in g]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        t = e.get("tags") or {}
        h, src = DEFAULT_H, "estimate"
        if t.get("height"):
            try:
                h = float(str(t["height"]).split()[0])
                src = "osm"
            except Exception:
                pass
        elif t.get("building:levels"):
            try:
                h = float(t["building:levels"]) * 3.2
                src = "osm"
            except Exception:
                pass
        out.append({"ring": ring, "height": h, "height_src": src})
    return out


def _ring_area_m2(ring: list[list[float]], lat0: float) -> float:
    import math

    k = 111320 * math.cos(math.radians(lat0))
    p = [(x * k, y * 110540) for x, y in ring]
    return abs(sum(p[i][0] * p[i + 1][1] - p[i + 1][0] * p[i][1] for i in range(len(p) - 1))) / 2


async def build(aoi: str) -> dict[str, Any]:
    hit = _cache.get(aoi)
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1]
    if aoi not in sar_damage.AOIS:
        raise KeyError(aoi)
    bbox = sar_damage.AOIS[aoi]
    pre, post = DAMAGE_DATES.get(aoi, ("2024-08-20", "2024-11-25"))
    blds = await asyncio.to_thread(_fetch_footprints, bbox)
    blds.sort(key=lambda b: _ring_area_m2(b["ring"], bbox[1]), reverse=True)
    blds = blds[:MAXB]

    dmg = await sar_damage.detect_damage(aoi, pre, post)
    change, cb = dmg.get("_change"), dmg.get("_bbox")
    cw, ch = (dmg.get("_size") or [0, 0])

    def is_dmg(ring: list[list[float]]) -> bool:
        if change is None:
            return False
        clon = sum(p[0] for p in ring) / len(ring)
        clat = sum(p[1] for p in ring) / len(ring)
        x, y = cdse.lonlat_to_3857(clon, clat)
        minx, miny, maxx, maxy = cb
        col = int((x - minx) / (maxx - minx) * cw)
        row = int((maxy - y) / (maxy - miny) * ch)
        if not (0 <= row < change.shape[0] and 0 <= col < change.shape[1]):
            return False
        return bool(change[row, col] < -0.35)

    feats, ndmg = [], 0
    for b in blds:
        d = is_dmg(b["ring"])
        ndmg += int(d)
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [b["ring"]]},
            "properties": {
                "height": round(b["height"], 1),
                "height_src": b["height_src"],
                "damaged": d,
            },
        })
    fc = {
        "type": "FeatureCollection",
        "features": feats,
        "summary": {"aoi": aoi, "buildings": len(feats), "damaged": ndmg,
                    "pre": pre, "post": post,
                    "note": "footprints OSM; heights osm-or-estimate; damage S1 amplitude (noisy)"},
    }
    _cache[aoi] = (time.monotonic(), fc)
    return fc
