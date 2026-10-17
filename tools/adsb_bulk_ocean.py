#!/usr/bin/env python3
"""Measure genuine OCEANIC content in bulk/historical ADS-B archives.

Reuses the validated land mask from tools/adsb_ocean_probe.py (ne_110m_land +
half-open even-odd ray cast, 12/12 control points) so these numbers are
comparable with the live-feed numbers in docs/adsb-keyless-ocean-coverage.md.

Key distinction this tool makes, and why it matters for archive work:
  * "ocean-adjacent"  = water, but within LAND_HALO_DEG of land
                         -> what a terrestrial feeder network produces
  * "deep-ocean"      = water AND farther than the halo from any land
                         -> the only column that can indicate real oceanic reach

Usage:
    python tools/adsb_bulk_ocean.py --flights <flight_sample.csv.gz> [...]
"""
import argparse
import csv
import gzip
import io
import json
import math
import sys
import urllib.request
from collections import Counter

sys.path.insert(0, "tools")
from adsb_ocean_probe import LAND_HALO_DEG, load_land_rings, near_land  # noqa: E402

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125 Safari/537.36"

# Basin boxes placed OFF the great-circle tracks (same rationale as the live
# probe: a transoceanic corridor is the one ocean place a coast-based network
# reliably hears, so a box on a track proves nothing about open-ocean reach).
BASINS = {
    "N-Pacific-mid": (30, 45, -170, -150),
    "Pacific-equat": (-5, 5, -170, -140),
    "S-Pacific": (-40, -25, -140, -110),
    "N-Atlantic-mid": (40, 52, -40, -20),
    "S-Atlantic": (-35, -20, -25, -5),
    "Indian-S": (-40, -25, 60, 85),
    "Southern-Ocean": (-60, -48, 0, 60),
    "Arctic": (82, 88, -60, 60),
}


def fetch(url: str, limit: int | None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read(limit) if limit else r.read()


def parse_track(v: str) -> list[tuple[float, float]]:
    """OpenSky flights/flightsV5 CSV: track is a JSON list of [t,lon,lat,baro]."""
    if not v or v in ("[]", "null", "None"):
        return []
    try:
        arr = json.loads(v)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for p in arr:
        try:
            out.append((float(p[2]), float(p[1])))  # lat, lon
        except Exception:  # noqa: BLE001, PERF203
            continue
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--flights", nargs="*", default=[], help="flight CSV(.gz) URLs")
    ap.add_argument("--states", nargs="*", default=[], help="states CSV(.gz) URLs")
    ap.add_argument("--max-rows", type=int, default=200_000)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    rings = load_land_rings()

    # Validate the mask before believing any number. Expectation = "is land".
    # Hawaii is deliberately absent: the Big Island resolves as land at 110m,
    # so it is a bad ocean control. Use open water instead.
    controls = [
        ("London", 51.5, -0.12, True), ("Sahara", 23.0, 13.0, True),
        ("Tokyo", 35.7, 139.7, True), ("Amazon", -3.0, -60.0, True),
        ("Antarctica", -80.0, 0.0, True), ("mid-Pacific", 0.0, -160.0, False),
        ("mid-Atlantic", 20.0, -40.0, False), ("Singapore", 1.35, 103.8, True),
        ("mid-SIndian", -30.0, 80.0, False), ("open-S-Pacific", -30.0, -130.0, False),
        ("N-Atlantic-corridor", 50.0, -30.0, False), ("Korea", 36.5, 127.9, True),
    ]
    ok = sum(1 for _, la, lo, exp in controls if near_land(lo, la, rings) == exp)
    print(f"land-mask control points: {ok}/12 correct")
    if ok < 12:
        print("REFUSING to report coverage numbers from an unvalidated mask.")
        return 2

    def classify(lat: float, lon: float) -> str:
        return "coast" if near_land(lon, lat, rings) else "ocean"

    report: dict[str, object] = {"mask_controls": f"{ok}/12", "halo_deg": LAND_HALO_DEG}

    for label, urls, kind in (
        ("flights", args.flights, "flights"),
        ("states", args.states, "states"),
    ):
        for url in urls:
            print(f"\n### {label}: {url}")
            raw = fetch(url, None)
            txt = gzip.decompress(raw).decode("utf-8", "replace") if url.endswith(".gz") \
                else raw.decode("utf-8", "replace")
            rdr = csv.DictReader(io.StringIO(txt))
            c: Counter[str] = Counter()
            flights_total = 0
            flights_ocean = 0
            per_flight_ocean_pts: Counter[int] = Counter()
            rows = 0
            for row in rdr:
                rows += 1
                if rows > args.max_rows:
                    break
                if "lat" in row and "lon" in row:
                    try:
                        la, lo = float(row["lat"]), float(row["lon"])
                    except Exception:  # noqa: BLE001
                        continue
                    c[classify(la, lo)] += 1
                    continue
                pts = parse_track(row.get("track", ""))
                if not pts:
                    continue
                flights_total += 1
                n_o = 0
                for la, lo in pts:
                    k = classify(la, lo)
                    c[k] += 1
                    n_o += k == "ocean"
                if n_o:
                    flights_ocean += 1
                    per_flight_ocean_pts[n_o] += 1

            res: dict = {"url": url, "kind": kind, "rows": rows, "points": dict(c)}
            if flights_total:
                tot_pts = c["coast"] + c["ocean"]
                res["flights_with_track"] = flights_total
                res["flights_touching_deep_ocean"] = flights_ocean
                res["pct_flights_deep_ocean"] = round(
                    100 * flights_ocean / flights_total, 3
                )
                res["pct_points_deep_ocean"] = round(
                    100 * c["ocean"] / max(tot_pts, 1), 3
                )
            print(json.dumps(res, indent=2))
            report[url] = res

    print("\n=== summary")
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(report, fh, indent=2)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
