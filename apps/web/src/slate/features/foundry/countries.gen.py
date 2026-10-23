#!/usr/bin/env python3
"""Writes countries.json: Natural Earth 1:50m admin-0 polygons (public domain), the
same file the copy page's builder reads (gotham/_refs/geo/ne_50m_admin_0.geojson),
rounded to 0.2 degrees (Douglas-Peucker 0.12 degrees, rings under 0.6 degrees across dropped) for the D194 map (1135x620 px at web-mercator zoom 2.1, where
0.2 degrees is under 2 px). Each entry keeps the name fields the builder matches
against OpenFlights country names. Run: python3 -I countries.gen.py <path-to-geojson>"""
import json, os, sys

KEYS = ("NAME", "NAME_LONG", "ADMIN", "NAME_EN", "SOVEREIGNT", "FORMAL_EN", "BRK_NAME", "GEOUNIT")
def dp(pts, tol=0.12):
    """Douglas-Peucker in degrees (0.12 degrees is about 1 px at the D194 zoom)"""
    if len(pts) < 3: return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]; dx, dy = x2 - x1, y2 - y1; L = (dx * dx + dy * dy) ** .5 or 1e-9
    i, dm = 0, -1.0
    for k in range(1, len(pts) - 1):
        d = abs(dy * (pts[k][0] - x1) - dx * (pts[k][1] - y1)) / L
        if d > dm: i, dm = k, d
    if dm <= tol: return [pts[0], pts[-1]]
    return dp(pts[: i + 1], tol)[:-1] + dp(pts[i:], tol)


sys.setrecursionlimit(20000)
geo = json.load(open(sys.argv[1]))
out = []
for f in geo["features"]:
    pr = f["properties"]; g = f["geometry"]
    names = sorted({pr[k] for k in KEYS if pr.get(k)})
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    rings, small = [], []
    for poly in polys:
        for ring in poly:
            r = []
            for lo, la in ring:
                p = [round(lo * 5) / 5, round(la * 5) / 5]
                if not r or r[-1] != p: r.append(p)
            r = dp(r[:-1]) + [r[-1]] if len(r) > 4 else r
            xs = [q[0] for q in r]; ys = [q[1] for q in r]
            # rings under ~4 px across at zoom 2.1 (0.6 degrees) are dropped
            ext = max(max(xs) - min(xs), max(ys) - min(ys))
            if len(r) >= 4 and ext >= 0.6: rings.append(r)
            elif len(r) >= 3: small.append((ext, r))
    # a country made only of small rings keeps its largest one, so it is still drawn (and counted)
    if not rings and small: rings = [max(small, key=lambda t: t[0])[1]]
    if rings: out.append({"n": names, "r": rings})
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "countries.json")
json.dump(out, open(dst, "w"), separators=(",", ":"))
print(dst, len(out), os.path.getsize(dst))
