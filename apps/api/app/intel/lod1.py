"""LOD1 building GeoJSON for the globe — real OSM footprints + heights + S1 SAR
damage flag, served so Cesium can extrude them into an interactive 3D city.

Honest: footprints = OSM (surveyed/detected); heights = OSM tags where present
else an area-typical estimate (flagged per feature via `height_src`); damage =
Sentinel-1 backscatter-drop (real but noisy). No invented geometry.
"""

from __future__ import annotations

import asyncio
import urllib.parse
import urllib.request
from typing import Any

from app.imagery import cdse
from app.intel import sar_damage
from app.upstream import cache

DEFAULT_H = 18.0
MAXB = 9000
# Public Overpass mirrors, tried in order — the primary 429s under load.
_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Largest freeform bbox span (degrees) we'll extrude on demand. A whole-city
# Overpass `way["building"]` query past this melts Overpass and floods the
# globe with >MAXB footprints, so an over-wide request is shrunk to this span
# centred on the request. ~0.09 deg ≈ 8-10 km — a city district, which is the
# scale this 3D view is meant for.
MAX_BBOX_SPAN = 0.09

# aoi -> (sar_pre, sar_post). Reuses sar_damage.AOIS for the bbox. Each date
# pair brackets the documented conflict window for that city; detect_damage
# pulls the ~12-day Sentinel-1 mosaic nearest each date.
DAMAGE_DATES = {
    # Lebanon — Israel–Hezbollah escalation, Sep–Nov 2024.
    "beirut-dahieh": ("2024-08-20", "2024-11-25"),
    "south-lebanon": ("2024-08-20", "2024-11-25"),
    # Gaza — post 7 Oct 2023.
    "gaza-city": ("2023-09-20", "2024-08-01"),
    "khan-younis": ("2023-10-01", "2024-04-15"),
    "rafah": ("2024-02-01", "2024-08-01"),
    # Ukraine.
    "mariupol": ("2022-02-15", "2022-05-25"),
    "bakhmut": ("2022-08-01", "2023-05-25"),
}

# Results are cached (and single-flighted) through the shared upstream TtlCache
# under "lod1:<key>" — concurrent first-hits for the same bbox/AOI collapse into
# one slow Overpass call instead of each launching its own. 12h: Overpass is
# slow and OSM footprints barely move.
_TTL = 12 * 3600.0


def _overpass_query(q: str) -> dict[str, Any]:
    """POST an Overpass QL query, retrying across public mirrors.

    The main instance returns HTTP 429 under load (and times out), which used to
    propagate as a 500 and break the whole war-damage layer. Walk the mirror
    list with a short backoff so a single throttled endpoint doesn't sink the
    request; raise only if EVERY mirror fails.
    """
    import json
    import time as _time

    from app.config import get_settings

    # The public Overpass mirrors forbid commercial/heavy use. On a commercial
    # deployment use the self-hosted OVERPASS_URL; if it is unset, refuse rather
    # than hit the public mirrors (the route degrades to no buildings).
    s = get_settings()
    if s.commercial_mode:
        if not s.overpass_url:
            raise RuntimeError("commercial_mode: OVERPASS_URL (self-host) not configured")
        endpoints = [s.overpass_url]
    else:
        endpoints = [s.overpass_url] if s.overpass_url else _OVERPASS_ENDPOINTS

    data = urllib.parse.urlencode({"data": q}).encode()
    last_err: Exception | None = None
    for i, endpoint in enumerate(endpoints):
        req = urllib.request.Request(
            endpoint, data=data, headers={"User-Agent": "osint-research/1.0"}
        )
        try:
            # 40s per mirror keeps the worst case (all 3 mirrors) within an
            # interactive budget; 180s × 3 was past any usable click-to-result.
            return json.loads(urllib.request.urlopen(req, timeout=40).read())
        except Exception as e:  # 429, timeout, transient DNS — try the next mirror
            last_err = e
            if i < len(endpoints) - 1:
                _time.sleep(1.5)
    raise RuntimeError(f"all Overpass mirrors failed: {last_err}")


def _fetch_footprints(bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    lon0, lat0, lon1, lat1 = bbox
    q = f'[out:json][timeout:120];(way["building"]({lat0},{lon0},{lat1},{lon1}););out geom;'
    d = _overpass_query(q)
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


def normalize_bbox(
    parts: list[float],
) -> tuple[float, float, float, float]:
    """Order + size-clamp a freeform (lon0,lat0,lon1,lat1) request.

    Guarantees lon0<lon1, lat0<lat1 and that neither span exceeds
    MAX_BBOX_SPAN (shrinking toward the centre if it does). Raises ValueError
    on out-of-range coordinates so the route can answer 400, not 500.
    """
    lon0, lat0, lon1, lat1 = parts
    if lon0 > lon1:
        lon0, lon1 = lon1, lon0
    if lat0 > lat1:
        lat0, lat1 = lat1, lat0
    if not (
        -180 <= lon0 <= 180 and -180 <= lon1 <= 180
        and -90 <= lat0 <= 90 and -90 <= lat1 <= 90
    ):
        raise ValueError("bbox coordinates out of range")
    clon, clat = (lon0 + lon1) / 2, (lat0 + lat1) / 2
    if lon1 - lon0 > MAX_BBOX_SPAN:
        lon0, lon1 = clon - MAX_BBOX_SPAN / 2, clon + MAX_BBOX_SPAN / 2
    if lat1 - lat0 > MAX_BBOX_SPAN:
        lat0, lat1 = clat - MAX_BBOX_SPAN / 2, clat + MAX_BBOX_SPAN / 2
    return (lon0, lat0, lon1, lat1)


async def build_bbox(bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    """Freeform LOD1 for an arbitrary bbox anywhere on Earth.

    Real OSM footprints + OSM-or-estimate heights, extruded — NO SAR damage
    overlay (damage detection needs a curated pre/post date pair per AOI; for
    general locations there is none, so `damaged` is always False rather than
    invented). For the curated war-damage AOIs use build(aoi) instead.
    """
    key = "lod1:bbox:" + ",".join(f"{c:.4f}" for c in bbox)

    async def load() -> dict[str, Any]:
        blds = await asyncio.to_thread(_fetch_footprints, bbox)
        blds.sort(key=lambda b: _ring_area_m2(b["ring"], bbox[1]), reverse=True)
        blds = blds[:MAXB]
        feats = [
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [b["ring"]]},
                "properties": {
                    "height": round(b["height"], 1),
                    "height_src": b["height_src"],
                    "damaged": False,
                },
            }
            for b in blds
        ]
        return {
            "type": "FeatureCollection",
            "features": feats,
            "summary": {
                "bbox": list(bbox),
                "buildings": len(feats),
                "damaged": 0,
                "note": "footprints OSM; heights osm-or-estimate; "
                        "no SAR damage overlay (general AOI)",
            },
        }

    return await cache.get_or_fetch(key, _TTL, load)


async def build(aoi: str) -> dict[str, Any]:
    # Validate up front so an unknown AOI raises KeyError (→ 404) without
    # entering the single-flight loader / touching the cache.
    if aoi not in sar_damage.AOIS:
        raise KeyError(aoi)
    bbox = sar_damage.AOIS[aoi]
    pre, post = DAMAGE_DATES.get(aoi, ("2024-08-20", "2024-11-25"))

    async def load() -> dict[str, Any]:
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
        return {
            "type": "FeatureCollection",
            "features": feats,
            "summary": {"aoi": aoi, "buildings": len(feats), "damaged": ndmg,
                        "pre": pre, "post": post,
                        "note": "footprints OSM; heights osm-or-estimate; "
                                "damage S1 amplitude (noisy)"},
        }

    return await cache.get_or_fetch(f"lod1:{aoi}", _TTL, load)
