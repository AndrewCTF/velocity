#!/usr/bin/env python3
"""Establish the capture scale of the PDF-embedded Gotham screenshots.

Blueprint publishes $pt-button-height: 30px (v5, = $pt-grid-size * 3). Gotham is
Blueprint, so finding the accent-filled primary button in a screenshot and
measuring its height gives the scale the screenshot was captured/embedded at.
Everything else measured from that image divides by the same factor.
"""
import pathlib

from PIL import Image

REF = pathlib.Path(__file__).parent / "_ref"

# Blueprint blues across v4/v5 releases; Gotham's accent sampled at #137CBD.
ACCENTS = [(0x13, 0x7C, 0xBD), (0x2D, 0x72, 0xD2), (0x21, 0x5D, 0xB0), (0x10, 0x6B, 0xA3)]
BP_BUTTON_H = 30.0  # $pt-button-height, Blueprint v5


def near(px, targets, tol=26):
    return any(all(abs(px[k] - t[k]) <= tol for k in range(3)) for t in targets)


def blobs(im, targets):
    """Bounding boxes of connected accent regions, biggest first."""
    w, h = im.size
    px = im.load()
    seen = [[False] * w for _ in range(h)]
    out = []
    for y0 in range(h):
        for x0 in range(w):
            if seen[y0][x0] or not near(px[x0, y0], targets):
                continue
            stack, minx, maxx, miny, maxy, n = [(x0, y0)], x0, x0, y0, y0, 0
            seen[y0][x0] = True
            while stack:
                x, y = stack.pop()
                n += 1
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and near(px[nx, ny], targets):
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if n > 150:
                out.append((n, minx, miny, maxx, maxy))
    return sorted(out, reverse=True)


for name in ("oe-full.png", "inbox-full.png"):
    p = REF / name
    if not p.exists():
        continue
    im = Image.open(p).convert("RGB")
    print(f"\n=== {name} {im.size[0]}x{im.size[1]} ===")
    for n, x0, y0, x1, y1 in blobs(im, ACCENTS)[:6]:
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        fill = n / (bw * bh)
        tag = ""
        if fill > 0.75 and 2.0 < bw / bh < 12:
            tag = f"  <- button-like, scale={bh / BP_BUTTON_H:.3f} (h={bh}px vs BP 30px)"
        print(f"  blob {bw:>4}x{bh:<3} at ({x0},{y0}) px={n:<6} fill={fill:.2f}{tag}")
