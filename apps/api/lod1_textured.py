"""Working coarse 3D of a conflict AOI from FREE data — honest, no hallucination.
Geometry: real OSM footprints extruded (LOD1) on a ground plane.
Color: REAL Sentinel-2 true-color (fetched high-res = upscaled) draped on the
ground AND sampled per building as roof colour, so it looks like the actual place.
Damage: Sentinel-1 SAR backscatter-drop buildings flagged red + collapsed.
Upscaling improves texture appearance only; it does NOT add 3D or real detail.
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

S, W, N, E = 33.845, 35.495, 33.865, 35.520
DEFAULT_H = 18.0
MAXB = 1500


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
    print("OSM footprints...", flush=True)
    blds = overpass()
    print("buildings:", len(blds), flush=True)
    print("Sentinel-2 true-color (upscaled fetch)...", flush=True)
    s2bbox = cdse.lonlat_bbox_3857(W, S, E, N)
    s2b = await cdse.fetch_image("S2_L2A_TRUECOLOR", s2bbox, 1024, 1024, "2024-11-25")
    from io import BytesIO

    from PIL import Image
    s2 = np.asarray(Image.open(BytesIO(s2b)).convert("RGB"))  # (H,W,3), row0=top=N
    sh, sw = s2.shape[:2]
    print("S2:", s2.shape, flush=True)
    print("SAR change...", flush=True)
    res = await sar_damage.detect_damage("beirut-dahieh", "2024-08-20", "2024-11-25")
    change, cb, cw, ch = res["_change"], res["_bbox"], *res["_size"]

    lon0, lat0 = (W + E) / 2, (S + N) / 2
    def mx(lon):
        return (lon - lon0) * 111320 * math.cos(math.radians(lat0))
    def my(lat):
        return (lat - lat0) * 110540

    def s2col(lon, lat):
        c = int((lon - W) / (E - W) * (sw - 1))
        r = int((N - lat) / (N - S) * (sh - 1))
        c = min(max(c, 0), sw - 1)
        r = min(max(r, 0), sh - 1)
        return s2[r, c] / 255.0

    def dmg(lon, lat):
        x, y = cdse.lonlat_to_3857(lon, lat)
        minx, miny, maxx, maxy = cb
        col = int((x - minx) / (maxx - minx) * cw)
        row = int((maxy - y) / (maxy - miny) * ch)
        return (
            0 <= row < change.shape[0]
            and 0 <= col < change.shape[1]
            and change[row, col] < -0.35
        )

    def area(ring):
        p = np.array([(mx(a), my(b)) for a, b in ring])
        if len(p) <= 2:
            return 0
        return 0.5 * abs(np.dot(p[:-1, 0], p[1:, 1]) - np.dot(p[1:, 0], p[:-1, 1]))
    blds = sorted(blds, key=lambda r: area(r[0]), reverse=True)[:MAXB]

    fig = plt.figure(figsize=(16, 11))
    ax = fig.add_subplot(111, projection="3d")
    # ground drape: real S2 on z=0
    gn = 220
    gx = np.linspace(mx(W), mx(E), gn)
    gy = np.linspace(my(S), my(N), gn)
    GX, GY = np.meshgrid(gx, gy)
    s2g = np.asarray(Image.fromarray(s2).resize((gn, gn)))[::-1] / 255.0  # flip rows: y up
    ax.plot_surface(
        GX, GY, np.zeros_like(GX), facecolors=s2g, shade=False,
        rstride=1, cstride=1, antialiased=False,
    )

    faces, fcolors = [], []
    ndmg = 0
    for ring, h in blds:
        pts = [(mx(a), my(b)) for a, b in ring]
        clon = sum(a for a, _ in ring) / len(ring)
        clat = sum(b for _, b in ring) / len(ring)
        d = dmg(clon, clat)
        ndmg += int(d)
        base = s2col(clon, clat)
        roof = (0.84, 0.15, 0.13) if d else tuple(np.clip(base * 1.05, 0, 1))
        wall = (0.55, 0.10, 0.09) if d else tuple(np.clip(base * 0.7, 0, 1))
        hh = h * 0.2 if d else h
        faces.append([(x, y, hh) for x, y in pts])
        fcolors.append(roof)
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            faces.append([(x0, y0, 0), (x1, y1, 0), (x1, y1, hh), (x0, y0, hh)])
            fcolors.append(wall)
    ax.add_collection3d(
        Poly3DCollection(
            faces, facecolors=fcolors, edgecolors=(0, 0, 0, 0.12), linewidths=0.08,
        )
    )
    ax.set_xlim(mx(W), mx(E))
    ax.set_ylim(my(S), my(N))
    ax.set_zlim(0, 90)
    ax.set_box_aspect((1, 1, 0.4))
    ax.view_init(elev=28, azim=-60)
    ax.set_axis_off()
    ax.set_title(
        f"Beirut Dahieh — LOD1 + real Sentinel-2 texture | red = SAR collapse ({ndmg})",
        fontsize=12,
    )
    fig.savefig("/tmp/dahieh_textured.png", dpi=140, bbox_inches="tight", facecolor="white")
    print(f"SAVED dahieh_textured.png buildings={len(blds)} damaged={ndmg}", flush=True)

asyncio.run(main())
