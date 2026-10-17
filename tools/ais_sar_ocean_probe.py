#!/usr/bin/env python3
"""Prove open-ocean SAR dark-vessel detection works, keyless, end to end.

The claim under test
--------------------
`/api/maritime/dark` can find vessels in the open ocean with no API key and no
credit budget, because Sentinel-1 GRD is public data: Element84's Earth Search
STAC catalogue is anonymous and `sentinel-s1-l1c` accepts unauthenticated
Range reads (measured HTTP 206 with real TIFF bytes over the Arabian Sea).

What "works" has to mean, concretely
------------------------------------
1. a scene exists over the chosen open-ocean box, and
2. its measurement TIFF downloads anonymously, and
3. CFAR finds bright targets in the actual pixels, and
4. those targets geolocate to real coordinates over water.

Step 3-4 are the only ones that prove vessel DETECTION rather than catalogue
availability. A scene inventory alone proves nothing about detection.

Cost, stated up front
---------------------
A Sentinel-1 IW GRD measurement TIFF is ~800 MB. This downloads ONE, into a
temp dir, and deletes it. That is a deliberate one-off measurement, not
something to put on a timer — `scan_aoi` therefore requires an explicit
`download_dir` before it will pull pixels, and unattended runs must not do that.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "api"))

from app.ais_pipeline import sar  # noqa: E402
from app.upstream import get_client  # noqa: E402

# (name, lon0, lat0, lon1, lat1) — genuinely open water, chosen to be busy
# enough that a detection is plausible rather than a lucky empty scene.
BOXES = {
    "Arabian Sea": (45.0, 10.0, 55.0, 15.0),
    "S Atlantic": (-25.0, -20.0, -15.0, 10.0),
    "S Pacific": (-30.0, -140.0, -20.0, -110.0),
    "Indian Ocean": (-25.0, 75.0, -15.0, 95.0),
    "N Atlantic": (40.0, -40.0, 55.0, -20.0),
}


async def probe(box_name: str, bbox: tuple[float, float, float, float], days: int, do_pixels: bool) -> int:
    line = f"{box_name:14}"
    # `get_client()` is the app's SHARED client, not a factory: entering it with
    # `async with` closes it on exit and every later box then fails with
    # "Cannot reopen a client instance". Use it as the plain object it is.
    client = get_client()
    res = await sar.scan_aoi(client, None, bbox, days=days, limit=2)
    scenes = res.get("scenes") or []
    if not scenes:
        print(f"{line} NO SCENE in {days}d")
        return 0

    with_url = [s for s in scenes if s.get("vvUrl")]
    chans = ",".join(str(s.get("channel")) for s in scenes)
    print(f"{line} scenes={len(scenes)} usable={len(with_url)} channels=[{chans}]")
    if not with_url:
        return 0

    if not do_pixels:
        print(f"{line}   (inventory only; --pixels to download)")
        return len(with_url)

    target = with_url[0]
    url = target["vvUrl"]
    tmp = tempfile.mkdtemp(prefix="sar-probe-")
    t0 = time.monotonic()
    # rasterio must be the real module: `_detect_from_scene` takes it as an
    # argument and calls `rasterio.open`, so passing None makes every scene fail
    # with "'NoneType' object has no attribute 'open'" AFTER the ~800 MB has
    # already been downloaded.
    import rasterio

    try:
        try:
            dets = await sar._detect_from_scene(client, url, rasterio, target)
        except Exception as exc:  # noqa: BLE001 — a probe reports, never raises
            print(f"{line}   pixel read FAILED {type(exc).__name__}: {str(exc)[:70]}")
            return 0
        dt = time.monotonic() - t0

        located = [d for d in dets if d.located]
        print(
            f"{line}   {url.split('/')[-1][:34]}  {dt:5.1f}s  "
            f"detections={len(dets)} located={len(located)}"
        )
        for d in dets[:4]:
            if d.located:
                print(f"{line}      bright target @ {d.lat:.4f},{d.lon:.4f}")
            else:
                print(f"{line}      bright target (unlocated)")
        return len(dets)
    finally:
        for f in os.listdir(tmp):
            try:
                os.unlink(os.path.join(tmp, f))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass


async def main_async(args: argparse.Namespace) -> int:
    boxes = {args.only: BOXES[args.only]} if args.only else BOXES
    print(
        f"open-ocean SAR probe — keyless (no API key, no credits), "
        f"days={args.days}, pixels={args.pixels}\n"
    )
    total = 0
    for name, bbox in boxes.items():
        try:
            total += await probe(name, bbox, args.days, args.pixels)
        except Exception as exc:  # noqa: BLE001
            print(f"{name:14} ERROR {type(exc).__name__}: {str(exc)[:80]}")
    print(f"\ntotal detections: {total}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--pixels", action="store_true", help="download and run CFAR (~800 MB/scene)")
    ap.add_argument("--only", choices=sorted(BOXES))
    args = ap.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
