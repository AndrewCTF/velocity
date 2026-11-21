"""Density map of every aircraft position in a bbox from an adsb.lol globe_history day.

usage: python density.py <day_dir_with_traces> <out.png> <lon0> <lat0> <lon1> <lat1> [width_px] [borders.geojson ...]
Data: https://github.com/adsblol/globe_history_2026 (ODbL-1.0).
"""
import gzip
import json
import math
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from matplotlib import colormaps
from PIL import Image

day, out = Path(sys.argv[1]), sys.argv[2]
lon0, lat0, lon1, lat1 = map(float, sys.argv[3:7])
W = int(sys.argv[7]) if len(sys.argv) > 7 else 3000
# equirectangular, x stretched by cos(mid-lat) so shapes look right
H = int(W * (lat1 - lat0) / ((lon1 - lon0) * math.cos(math.radians((lat0 + lat1) / 2))))


def load(path):
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    try:
        tr = json.loads(raw).get("trace") or []
    except ValueError:
        return None
    if not tr:
        return None
    a = np.array([(p[1], p[2]) for p in tr if p[1] is not None], dtype=np.float64)
    if a.size == 0:
        return None
    m = (a[:, 1] >= lon0) & (a[:, 1] <= lon1) & (a[:, 0] >= lat0) & (a[:, 0] <= lat1)
    a = a[m]
    if not len(a):
        return None
    x = ((a[:, 1] - lon0) / (lon1 - lon0) * (W - 1)).astype(np.int32)
    y = ((lat1 - a[:, 0]) / (lat1 - lat0) * (H - 1)).astype(np.int32)
    return np.bincount(y * W + x, minlength=W * H).astype(np.uint32)


if __name__ == "__main__":
    files = [p for p in (day / "traces").rglob("*") if p.is_file()]
    grid = np.zeros(W * H, dtype=np.uint64)
    n_ac = 0
    with Pool() as pool:
        for g in pool.imap_unordered(load, files, chunksize=64):
            if g is not None:
                grid += g
                n_ac += 1
    total = int(grid.sum())
    img = np.log1p(grid.reshape(H, W).astype(np.float64))
    img /= np.percentile(img[img > 0], 99.0) if total else 1
    rgb = (colormaps["inferno"](np.clip(img, 0, 1) ** 0.75)[:, :, :3] * 255).astype(np.uint8)
    rgb[grid.reshape(H, W) == 0] = (0, 0, 0)
    im = Image.fromarray(rgb)
    if len(sys.argv) > 8:  # optional GeoJSON files of borders/coasts, drawn faint so the density stays the subject
        from PIL import ImageDraw
        draw = ImageDraw.Draw(im)
        px = lambda lo, la: ((lo - lon0) / (lon1 - lon0) * (W - 1), (lat1 - la) / (lat1 - lat0) * (H - 1))
        for f in [f for path in sys.argv[8:] for f in json.load(open(path))["features"]]:
            g = f.get("geometry") or {}
            t, c = g.get("type"), g.get("coordinates")
            rings = (c if t in ("Polygon", "MultiLineString") else [r for p in c for r in p] if t == "MultiPolygon"
                     else [c] if t == "LineString" else [])
            for ring in rings:
                draw.line([px(lo, la) for lo, la, *_ in ring], fill=(150, 160, 175), width=max(1, W // 900))
    im.save(out)
    print(f"{out}: {W}x{H}, {total:,} positions from {n_ac:,} aircraft ({len(files):,} trace files)")
