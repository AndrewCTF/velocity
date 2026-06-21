#!/usr/bin/env python3
"""Measure how many aircraft in the live snapshot actually MOVE — the ground
truth for the "planes don't move" report. Run on the box that serves prod (the
droplet) via the api venv, from apps/api:

    cd apps/api && .venv/bin/python ../../tools/measure_snapshot_motion.py

Starts the ADS-B snapshot refresher, waits for it to fill, then samples two
snapshots ~10 s apart and reports: total, per-source split (a readsb-feed plane
has fresh positions and CAN glide; an opensky-only plane is the once/UTC-day
breadth and is static until the next pull), and the count of distinct ICAO24
whose position changed > 25 m between the two samples (= visibly moving). If the
moving count is high the motion pipeline is healthy and any remaining stillness
is the oceanic OpenSky-only tier; if it's near zero in prod, the keyless feeds
(theairtraffic/hpradar) are not landing from that egress — probe them with
tools/probe_adsb_mirrors.py.
"""
from __future__ import annotations

import asyncio
import math


def _moved(a: tuple[float, float], b: tuple[float, float]) -> bool:
    # ~metres between two lon/lat points (equirectangular is plenty at 25 m).
    mlat = (a[1] + b[1]) / 2.0
    dx = (b[0] - a[0]) * 111_320 * math.cos(math.radians(mlat))
    dy = (b[1] - a[1]) * 110_540
    return math.hypot(dx, dy) > 25.0


def _index(fc: dict) -> dict[str, tuple[float, float, str]]:
    out: dict[str, tuple[float, float, str]] = {}
    for f in fc.get("features") or []:
        fid = f.get("id")
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        if not fid or not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        src = (f.get("properties") or {}).get("source") or "?"
        out[str(fid)] = (float(coords[0]), float(coords[1]), str(src))
    return out


async def main() -> None:
    from app.routes import adsb

    await adsb.start_snapshot()
    for _ in range(20):
        await asyncio.sleep(2)
        fc = await adsb.global_snapshot()
        if fc and len(fc.get("features") or []) > 2000:
            break

    a = _index((await adsb.global_snapshot()) or {})
    await asyncio.sleep(10)
    b = _index((await adsb.global_snapshot()) or {})

    by_src: dict[str, int] = {}
    for _, _, s in b.values():
        by_src[s] = by_src.get(s, 0) + 1

    common = a.keys() & b.keys()
    moved = sum(1 for k in common if _moved(a[k][:2], b[k][:2]))
    moved_feed = sum(
        1 for k in common if _moved(a[k][:2], b[k][:2]) and b[k][2] != "opensky"
    )

    print(f"snapshot total={len(b)}  source split={dict(sorted(by_src.items(), key=lambda kv: -kv[1]))}")
    print(f"tracked across 10 s={len(common)}")
    print(f"MOVING (>25 m in 10 s)={moved}  of which non-opensky={moved_feed}")
    await adsb.stop_snapshot()


if __name__ == "__main__":
    asyncio.run(main())
