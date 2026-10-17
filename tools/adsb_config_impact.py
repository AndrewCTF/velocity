"""Compare the snapshot composition under the two relevant ADS-B configurations.

The question
------------
`.env` sets ADSB_SIDECAR_ONLY=1, which makes `_feed_urls()` drop every REMOTE
keyless mirror and keep only the localhost sidecar. That is the right call on a
CPU-starved box with a healthy sidecar. But the sidecar on this deployment is
not listening (:8090 refused), so the keyless mirrors that carry the whole
breadth tier are being filtered out while the thing they were deferred to is
absent.

This measures the consequence rather than assuming it: it calls the same
`_readsb_feeds()` / fan-out internals the app uses, under each setting, and
reports aircraft count, per-source composition and ocean share.

Read-only: it mutates no files and calls no endpoint that costs credits or needs
a key. It does hit the three keyless mirrors, which the running app is already
polling.
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from adsb_ocean_probe import load_land_rings, near_land, on_land  # noqa: E402


def ocean_split(records: list[dict]) -> tuple[int, int]:
    rings = _RINGS
    ocean = deep = 0
    for r in records:
        lat, lon = r.get("lat"), r.get("lon")
        if lat is None or lon is None:
            continue
        if not on_land(lon, lat, rings):
            ocean += 1
            if not near_land(lon, lat, rings, halo=5.0):
                deep += 1
    return ocean, deep


async def run(label: str, sidecar_only: bool) -> None:
    os.environ["ADSB_SIDECAR_ONLY"] = "1" if sidecar_only else "0"
    # Force a fresh settings read for this configuration.
    from app.config import get_settings

    get_settings.cache_clear()
    from app.routes import adsb  # imported after env is set

    adsb._FEED_SLICES.clear()
    adsb._FEED_NEXT_PULL.clear()
    adsb._FEED_TASKS.clear()

    urls = adsb._feed_urls()
    print(f"\n{'=' * 78}")
    print(f"{label}  (ADSB_SIDECAR_ONLY={'1' if sidecar_only else '0'})")
    print("=" * 78)
    print("effective feeds:")
    for u in urls:
        print(f"   {u}  -> every {adsb._feed_interval(u)}s")

    t0 = asyncio.get_event_loop().time()
    recs = await adsb._readsb_feeds()
    # Let the background pull tasks land before reading the union.
    await asyncio.sleep(6)
    recs = await adsb._readsb_feeds()
    ocean, deep = ocean_split(recs)
    print(f"\nkeyless feed union : {len(recs):,} aircraft")
    print(f"  ocean            : {ocean:,}")
    print(f"  deep (>5deg land): {deep:,}")
    print(f"  wall             : {asyncio.get_event_loop().time() - t0:.1f}s")

    hosts: dict[str, int] = {}
    for r in recs:
        h = r.get("_host") or "?"
        hosts[h] = hosts.get(h, 0) + 1
    print("  by source host:")
    for h, n in sorted(hosts.items(), key=lambda kv: -kv[1]):
        print(f"     {h:34} {n:,}")


_RINGS: list = []


async def main() -> None:
    global _RINGS
    _RINGS = load_land_rings()
    await run("BASELINE (as configured in .env)", True)
    await run("WITHOUT sidecar-only (mirrors restored)", False)
    print(
        "\nIf the second run shows the mirrors contributing aircraft the first\n"
        "does not, then ADSB_SIDECAR_ONLY=1 is suppressing the keyless breadth\n"
        "tier on this deployment -- and the fix is to turn the flag off (or\n"
        "start the sidecar), not to add a new provider."
    )


if __name__ == "__main__":
    asyncio.run(main())
