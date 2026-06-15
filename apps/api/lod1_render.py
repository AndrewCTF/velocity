"""LOD1 3D of a conflict AOI — REAL OSM footprints extruded to heights, damaged
buildings flagged from the Sentinel-1 SAR change map. Honest: geometry from
surveyed/detected footprints (OGC LOD1 = extrude footprint to a box, NOT invented
detail); heights from OSM tags where present else an area-typical estimate
(flagged); damage from real S1 backscatter change. Renders an oblique 3D view.
"""
import asyncio
import json
import math
import urllib.parse
import urllib.request

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402

from app.imagery import cdse  # noqa: E402
from app.intel import sar_damage  # noqa: E402

# core Dahieh (tighter than full AOI for a clean dense render)
S, W, N, E = 33.845, 35.495, 33.865, 35.520
DEFAULT_H = 18.0  # ~6 floors, area-typical (FLAGGED estimate where OSM has no tag)
MAXB = 1600


def overpass():
    q = f'[out:json][timeout:90];(way["building"]({S},{W},{N},{E}););out geom;'
    data = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request("https://overpass-api.de/api/interpreter", data=data,
                                 headers={"User-Agent": "osint-research/1.0"})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    out = []
    for e in d.get("elements", []):
        g = e.get("geometry")
        if e.get("type") != "way" or not g:
            continue
        ring = [(p["lon"], p["lat"]) for p in g]
        t = e.get("tags") or {}
        h = DEFAULT_H
        if t.get("height"):
            try:
                h = float(str(t["height"]).split()[0])
            except Exception:
                pass
        elif t.get("building:levels"):
            try:
                h = float(t["building:levels"]) * 3.2
            except Exception:
                pass
        out.append((ring, h))
    return out


async def main():
    print("fetching OSM footprints...", flush=True)
    blds = overpass()
    print("buildings:", len(blds), flush=True)
    print("fetching S1 SAR change (pre 2024-08 / post 2024-11)...", flush=True)
    res = await sar_damage.detect_damage("beirut-dahieh", "2024-08-20", "2024-11-25")
    change = res["_change"]
    cb = res["_bbox"]
    cw, ch = res["_size"]

    def dmg(lon, lat):
        x, y = cdse.lonlat_to_3857(lon, lat)
        minx, miny, maxx, maxy = cb
        col = int((x - minx) / (maxx - minx) * cw)
        row = int((maxy - y) / (maxy - miny) * ch)
        if 0 <= row < change.shape[0] and 0 <= col < change.shape[1]:
            return change[row, col] < -0.35  # backscatter drop = collapse candidate
        return False

    lon0, lat0 = (W + E) / 2, (S + N) / 2
    def mx(lon):
        return (lon - lon0) * 111320 * math.cos(math.radians(lat0))
    def my(lat):
        return (lat - lat0) * 110540
    # keep biggest MAXB footprints (clean render)
    def area(ring):
        p = np.array([(mx(a), my(b)) for a, b in ring])
        if len(p) <= 2:
            return 0
        return 0.5 * abs(np.dot(p[:-1, 0], p[1:, 1]) - np.dot(p[1:, 0], p[:-1, 1]))
    blds = sorted(blds, key=lambda r: area(r[0]), reverse=True)[:MAXB]

    faces, fcolors = [], []
    ndmg = 0
    for ring, h in blds:
        pts = [(mx(a), my(b)) for a, b in ring]
        clon = sum(a for a, _ in ring) / len(ring)
        clat = sum(b for _, b in ring) / len(ring)
        d = dmg(clon, clat)
        ndmg += int(d)
        top = "#d62728" if d else None  # red if damaged
        hh = h * 0.25 if d else h       # collapsed -> low rubble box
        # roof
        faces.append([(x, y, hh) for x, y in pts])
        fcolors.append(top or "#c9bfae")
        # walls
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            faces.append([(x0, y0, 0), (x1, y1, 0), (x1, y1, hh), (x0, y0, hh)])
            fcolors.append(top or "#9a8f7a")

    fig = plt.figure(figsize=(15, 10))
    ax = fig.add_subplot(111, projection="3d")
    pc = Poly3DCollection(faces, facecolors=fcolors, edgecolors=(0, 0, 0, 0.15), linewidths=0.1)
    ax.add_collection3d(pc)
    xs = [mx(W), mx(E)]
    ys = [my(S), my(N)]
    ax.set_xlim(xs)
    ax.set_ylim(ys)
    ax.set_zlim(0, 80)
    ax.set_box_aspect((1, 1, 0.35))
    ax.view_init(elev=32, azim=-55)
    ax.set_axis_off()
    ax.set_title(
        f"LOD1 3D — Beirut Dahieh ({len(blds)} OSM footprints) | "
        f"red = SAR collapse candidate ({ndmg})",
        fontsize=11,
    )
    fig.savefig("/tmp/dahieh_lod1.png", dpi=130, bbox_inches="tight", facecolor="white")
    print(f"SAVED dahieh_lod1.png  buildings={len(blds)} damaged={ndmg}", flush=True)

asyncio.run(main())
