"""Sample /api/adsb/global and report per-region update cadence.

A pull with 0 changed positions worldwide is a frozen snapshot (backend), not a
frontend refresh problem. A single zero pull is normal: each tar1090 source
refreshes its store every ~7 s. A run of them is a stall.

Usage: python3 tools/perf/adsb_region_refresh.py [seconds=90]
"""

import json
import statistics
import sys
import time
import urllib.request

REGIONS = {  # lat_min, lat_max, lon_min, lon_max
    "hormuz": (23, 30, 50, 60),
    "europe": (43, 55, -5, 20),
    "conus": (30, 45, -110, -80),
    "india": (10, 30, 70, 88),
}
URL = "http://127.0.0.1:8000/api/adsb/global"


def main() -> None:
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 90
    history: dict[str, list[tuple[float, tuple[float, float]]]] = {}
    pulls: list[tuple[int, int]] = []
    t0 = time.time()
    while time.time() - t0 < duration:
        with urllib.request.urlopen(URL, timeout=30) as r:
            features = json.load(r)["features"]
        now = time.time() - t0
        changed = 0
        for f in features:
            key = f["properties"].get("id") or f.get("id")
            pos = tuple(f["geometry"]["coordinates"][:2])
            h = history.setdefault(key, [])
            if not h or h[-1][1] != pos:
                h.append((now, pos))
                changed += 1
        pulls.append((round(now), changed))
        time.sleep(3)

    run = longest = 0
    for _, c in pulls:
        run = run + 1 if c == 0 else 0
        longest = max(longest, run)
    print("pulls (t, positions changed):", pulls)
    zero = sum(1 for _, c in pulls if c == 0)
    print(f"pulls={len(pulls)} zero-change={zero} longest zero run={longest} pulls")

    for name, (la0, la1, lo0, lo1) in REGIONS.items():
        keys = [k for k, h in history.items() if la0 <= h[-1][1][1] <= la1 and lo0 <= h[-1][1][0] <= lo1]
        if not keys:
            print(f"{name:8} n=0")
            continue
        updates = [len(history[k]) - 1 for k in keys]
        stale = sum(1 for u in updates if u == 0)
        print(
            f"{name:8} n={len(keys):5} updates median={statistics.median(updates)} "
            f"no update in window={stale} ({100 * stale / len(keys):.0f}%)"
        )


if __name__ == "__main__":
    main()
