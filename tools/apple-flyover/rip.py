#!/usr/bin/env python3
"""Apple Flyover mesh ripper — fetch 3D tiles and export as OBJ.

Usage:
    python rip.py <lat> <lon> <zoom> <tryXY> <tryH> [--parallel]
    python rip.py --test-auth

Example (Tokyo):
    python rip.py 35.6762 139.6503 20 3 40
"""

import asyncio
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from apple3d.manifest import bootstrap, C3M_STYLE, C3MM_STYLE
from apple3d.c3m import parse as parse_c3m
from apple3d.export_obj import OBJExporter


def lat_lon_to_tms(zoom: int, lat: float, lon: float) -> tuple[int, int]:
    n = 2 ** zoom
    x = int(n * ((lon + 180) / 360))
    lat_rad = lat / 180 * math.pi
    y = int((math.log(math.tan(lat_rad * 0.5 + math.pi / 4)) / (2 * math.pi) + 0.5) * n)
    return x, y


async def test_auth():
    config = json.loads(Path("config.json").read_text())
    ctx = await bootstrap(config["resourceManifestURL"], config["tokenP1"])
    print(f"Manifest: {len(ctx.manifest.style_configs)} styles, {len(ctx.triggers)} regions")
    print(f"C3M prefix: {ctx.c3m_prefix}")
    print(f"C3MM prefix: {ctx.c3mm_prefix}")
    region = ctx.find_region(35.6762, 139.6503)
    print(f"Tokyo: {region.name} region={region.region} v={region.version}")


async def rip(lat: float, lon: float, zoom: int, try_xy: int, try_h: int, parallel: bool):
    config = json.loads(Path("config.json").read_text())
    ctx = await bootstrap(config["resourceManifestURL"], config["tokenP1"])
    region = ctx.find_region(lat, lon)
    print(f"Region: {region.name} (id={region.region}, v={region.version})")

    x, y = lat_lon_to_tms(zoom, lat, lon)
    n = 2 ** zoom
    print(f"TMS: x={x}, y={y}, z={zoom}")

    out_dir = f"./output/{lat:.4f}_{lon:.4f}_z{zoom}"
    sem = asyncio.Semaphore(16 if parallel else 4)
    exported = 0

    import httpx
    async with httpx.AsyncClient(timeout=30) as client:

        async def fetch_tile(dx, dy, h):
            nonlocal exported
            xn, yn_tms = x + dx, y + dy
            yn = n - 1 - yn_tms  # invert for Apple
            url = (
                f"{ctx.c3m_prefix}?style={C3M_STYLE}&v={region.version}"
                f"&region={region.region}&x={xn}&y={yn}&z={zoom}&h={h}"
            )
            signed = ctx.auth_url(url)
            async with sem:
                r = await client.get(signed)
            if r.status_code != 200 or len(r.content) == 0:
                return None
            ct = r.headers.get("content-type", "")
            if ct == "image/jpeg" or r.content[:3] != b"C3M":
                return None
            return r.content

        # collect work
        tasks = []
        for dx in range(-try_xy, try_xy + 1):
            for dy in range(-try_xy, try_xy + 1):
                for h in range(try_h):
                    tasks.append((dx, dy, h))

        print(f"Scanning {len(tasks)} tile coordinates...")
        results = await asyncio.gather(*(fetch_tile(*t) for t in tasks))

        with OBJExporter(out_dir) as exp:
            for i, data in enumerate(results):
                if data is None:
                    continue
                try:
                    c3m = parse_c3m(data)
                    exp.add_tile(c3m)
                    exported += 1
                    dx, dy, h = tasks[i]
                    print(f"  tile dx={dx} dy={dy} h={h}: "
                          f"{len(c3m.meshes)} meshes, "
                          f"{sum(len(m.vertices) for m in c3m.meshes)} vtx")
                except Exception as e:
                    dx, dy, h = tasks[i]
                    print(f"  tile dx={dx} dy={dy} h={h}: FAILED ({e})")

    print(f"\n{exported} tiles exported to {out_dir}/")


def main():
    if "--test-auth" in sys.argv:
        asyncio.run(test_auth())
        return

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 5:
        print(__doc__)
        sys.exit(1)

    lat, lon = float(args[0]), float(args[1])
    zoom, try_xy, try_h = int(args[2]), int(args[3]), int(args[4])
    parallel = "--parallel" in sys.argv
    asyncio.run(rip(lat, lon, zoom, try_xy, try_h, parallel))


if __name__ == "__main__":
    main()
