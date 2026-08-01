#!/usr/bin/env python3
"""Measure the real Palantir crops in _ref/ so the mockup is built against
numbers rather than impressions.

Two measurements per crop:
  bands  - horizontal bands of near-constant colour (chrome bars, strips).
           Found by collapsing each row to its median colour and cutting where
           consecutive rows differ by more than THRESH.
  pitch  - dominant vertical repeat, from the autocorrelation of the row-to-row
           difference signal. This is what gives row/tab pitch in list UIs.
"""
import collections
import pathlib
import sys

from PIL import Image

REF = pathlib.Path(__file__).parent / "_ref"
THRESH = 10  # per-channel delta that counts as a new band


def median_rows(im):
    """One representative colour per pixel row."""
    w, h = im.size
    px = im.load()
    out = []
    for y in range(h):
        # sample across the row; median is robust to text and icons
        r = sorted(px[x, y][0] for x in range(0, w, max(1, w // 64)))
        g = sorted(px[x, y][1] for x in range(0, w, max(1, w // 64)))
        b = sorted(px[x, y][2] for x in range(0, w, max(1, w // 64)))
        m = len(r) // 2
        out.append((r[m], g[m], b[m]))
    return out


def bands(rows):
    cuts, start = [], 0
    for y in range(1, len(rows)):
        d = max(abs(a - b) for a, b in zip(rows[y], rows[y - 1]))
        if d > THRESH:
            cuts.append((start, y - 1, rows[(start + y - 1) // 2]))
            start = y
    cuts.append((start, len(rows) - 1, rows[(start + len(rows) - 1) // 2]))
    return [(a, b, c) for a, b, c in cuts if b - a >= 1]


def pitch(im):
    """Dominant vertical repeat via autocorrelation of row-difference energy."""
    w, h = im.size
    px = im.load()
    sig = []
    for y in range(1, h):
        e = sum(
            abs(px[x, y][k] - px[x, y - 1][k])
            for x in range(0, w, max(1, w // 96))
            for k in range(3)
        )
        sig.append(e)
    if len(sig) < 16:
        return None
    mean = sum(sig) / len(sig)
    sig = [s - mean for s in sig]
    best, best_lag = 0, None
    for lag in range(8, min(80, len(sig) // 2)):
        c = sum(sig[i] * sig[i + lag] for i in range(len(sig) - lag))
        if c > best:
            best, best_lag = c, lag
    return best_lag


def hexc(c):
    return "#%02x%02x%02x" % c


names = sys.argv[1:] or sorted(p.name for p in REF.glob("*.png"))
for name in names:
    p = REF / name
    if not p.exists():
        print(f"{name}: MISSING")
        continue
    im = Image.open(p).convert("RGB")
    w, h = im.size
    print(f"\n=== {name}  {w}x{h} ===")

    rows = median_rows(im)
    bs = bands(rows)
    if len(bs) <= 14:
        for a, b, c in bs:
            print(f"  band y={a:>4}-{b:<4} h={b - a + 1:>3}px  {hexc(c)}")
    else:
        print(f"  {len(bs)} bands (too many to list; list UI)")

    pl = pitch(im)
    if pl:
        print(f"  dominant vertical pitch: {pl}px")

    # dominant colours overall
    small = im.resize((min(w, 200), min(h, 200)))
    cnt = collections.Counter(small.getdata())
    tot = sum(cnt.values())
    top = ", ".join(f"{hexc(c)} {100 * n / tot:.0f}%" for c, n in cnt.most_common(4))
    print(f"  dominant: {top}")
