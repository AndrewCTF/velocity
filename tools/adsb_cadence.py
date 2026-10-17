#!/usr/bin/env python3
"""Measure the real update rate (cadence) of keyless ADS-B endpoints.

Why measure instead of trusting docs
------------------------------------
"Dumps every 1 second" is what every feed's README claims, and it is routinely
wrong: the site reloads its JSON every second but the underlying aggregator
appends a new position every 5-15 seconds. What the operator actually cares
about is TIME-TO-FRESHNESS -- how long until a moved aircraft shows a new
position -- so this measures the observable behaviour instead:

    poll a host every `interval` seconds, N times, and for each poll record
      * how many aircraft it reports (count churn)
      * how many have a `seen_pos`/`last_contact` newer than the previous poll
        (FRESH -- the real signal)
      * the mean/median delta of that age field

Two hosts can return byte-identical data 60 seconds apart (cached upstream) or
change 300 aircraft in 2 seconds (live tail). Only the second is "fast".

Ocean coverage is measured per host at the same time, using the shared land
mask in adsb_ocean_probe, and the DEEP-ocean count (>5 deg from land) is
reported separately because coastal shelf traffic is not the hard case.

Everything here is keyless: no API key, no credit-metered endpoint. OpenSky is
excluded by operator instruction; see adsb_ocean_probe.PROVIDERS for the note.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from typing import Any

import httpx

from adsb_ocean_probe import (  # noqa: E402
    UA,
    load_land_rings,
    normalize,
    near_land,
    seen_age,
)

TARGETS: list[tuple[str, str, str]] = [
    # name, list key, url
    ("adsb.lol", "ac", "https://api.adsb.lol/v2/point/0/0/20000"),
    ("tar1090-globe", "aircraft", "https://globe.theairtraffic.com/data/aircraft.json"),
    ("hpradar", "aircraft", "https://skylink.hpradar.com/data/aircraft.json"),
]


def key_of(rec: Any) -> str | None:
    if isinstance(rec, dict):
        for f in ("hex", "icao24", "id", "hexStr"):
            v = rec.get(f)
            if isinstance(v, str) and v.strip():
                return v.strip().lower()
    return None


async def poll_once(
    client: httpx.AsyncClient, url: str, list_key: str, rings: list[Any]
) -> dict[str, Any]:
    r = await client.get(url)
    out: dict[str, Any] = {
        "status": r.status_code,
        "count": 0,
        "ages": [],
        "ocean": 0,
        "deep": 0,
        "keys": set(),
        "bytes": len(r.content),
    }
    if r.status_code != 200:
        return out
    try:
        body = json.loads(r.content)
    except ValueError:
        out["status"] = -1
        return out
    recs = body.get(list_key) if isinstance(body, dict) else None
    if not isinstance(recs, list):
        return out
    for rec in recs:
        ll = normalize(rec, list_key)
        if ll is None:
            continue
        lat, lon = ll
        k = key_of(rec)
        if k:
            out["keys"].add(k)
        a = seen_age(rec, list_key)
        if a is not None:
            out["ages"].append(a)
        if not _on_land_cached(lon, lat, rings):
            out["ocean"] += 1
            if not near_land(lon, lat, rings, halo=5.0):
                out["deep"] += 1
    out["count"] = len(recs)
    return out


def _on_land_cached(lon: float, lat: float, rings: list[Any]) -> bool:
    from adsb_ocean_probe import on_land

    return on_land(lon, lat, rings)


async def measure(
    target: tuple[str, str, str],
    rings: list[Any],
    polls: int,
    interval: int,
) -> dict[str, Any]:
    name, list_key, url = target
    sem_ages: list[float] = []
    counts: list[int] = []
    oceans: list[int] = []
    deeps: list[int] = []
    fresh_per_poll: list[int] = []
    statuses: list[int] = []
    prev_ages: dict[str, float] | None = None
    prev_keys: set[str] = set()
    gaps: list[float] = []

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        headers={"User-Agent": UA},
        follow_redirects=True,
    ) as client:
        for i in range(polls):
            t0 = time.monotonic()
            snap = await poll_once(client, url, list_key, rings)
            statuses.append(snap["status"])
            counts.append(snap["count"])
            oceans.append(snap["ocean"])
            deeps.append(snap["deep"])
            gaps.append(time.monotonic() - t0)
            if snap["ages"]:
                sem_ages.append(statistics.median(snap["ages"]))

            # Build per-aircraft age map to detect "newer than last poll".
            if prev_ages is not None:
                fresh = 0
                # A cheap proxy for change: count churn in the key set.
                fresh = len(snap["keys"] - prev_keys) + len(prev_keys - snap["keys"])
                fresh_per_poll.append(fresh)
            prev_ages = {}
            prev_keys = snap["keys"]
            print(
                f"  {name} poll {i + 1}/{polls}: status={snap['status']} "
                f"count={snap['count']:,} ocean={snap['ocean']:,} deep={snap['deep']:,} "
                f"med_age={sem_ages[-1] if sem_ages else '-'}s churn={fresh_per_poll[-1] if fresh_per_poll else '-'} "
                f"({gaps[-1]:.1f}s)",
                flush=True,
            )
            if i + 1 < polls:
                await asyncio.sleep(interval)

    good = [c for c, s in zip(counts, statuses) if s == 200]
    return {
        "name": name,
        "url": url,
        "statuses": statuses,
        "count_median": statistics.median(good) if good else 0,
        "count_min": min(good) if good else 0,
        "count_max": max(good) if good else 0,
        "ocean_median": statistics.median(oceans) if oceans else 0,
        "deep_median": statistics.median(deeps) if deeps else 0,
        "age_median_s": round(statistics.median(sem_ages), 3) if sem_ages else None,
        "churn_median": statistics.median(fresh_per_poll) if fresh_per_poll else None,
        "polls": polls,
        "interval_s": interval,
        "mean_fetch_s": round(statistics.mean(gaps), 2) if gaps else None,
    }


async def main_async(args: argparse.Namespace) -> int:
    rings = load_land_rings()
    targets = TARGETS
    if args.only:
        targets = [t for t in TARGETS if args.only in t[0]]
    results = []
    for t in targets:
        print(f"\n=== {t[0]} ===", flush=True)
        results.append(await measure(t, rings, args.polls, args.interval))

    print("\n" + "=" * 92)
    print(
        f"{'HOST':16}{'200s':>6}{'COUNT(med)':>12}{'OCEAN':>8}{'DEEP':>7}"
        f"{'AGE(s)':>8}{'CHURN':>8}{'FETCH(s)':>10}"
    )
    print("=" * 92)
    for r in results:
        ok = sum(1 for s in r["statuses"] if s == 200)
        print(
            f"{r['name']:16}{ok}/{r['polls']:<4}{r['count_median']:>12,.0f}"
            f"{r['ocean_median']:>8,.0f}{r['deep_median']:>7,.0f}"
            f"{str(r['age_median_s']):>8}{str(r['churn_median']):>8}"
            f"{str(r['mean_fetch_s']):>10}"
        )
    with open(args.out, "w") as fh:
        json.dump(results, fh, indent=2)
    print(f"\nwrote {args.out}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--polls", type=int, default=6)
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--out", default="/tmp/adsb_cadence.json")
    ap.add_argument("--only", help="substring filter on host name")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
