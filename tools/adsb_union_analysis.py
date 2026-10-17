#!/usr/bin/env python3
"""Union + marginal-contribution analysis across the keyless ADS-B providers.

The question that decides the pipeline
--------------------------------------
Three keyless hosts answer 200 from this egress. The naive read is "take the
biggest one". That is wrong if the hosts are mirrors of the same aggregator,
because then the union is no larger than the best single tier and the extra
requests buy nothing but load on someone else's free service.

So this measures what actually matters:

  * union size after dedup by ICAO24 hex,
  * MARGINAL contribution -- how many aircraft each provider adds that NO other
    provider has. A provider with a big count and zero marginal count is a
    mirror and belongs behind a fallback, not in front of the primary,
  * the same three numbers restricted to OCEAN aircraft, which is the coverage
    the operator actually asked about,
  * freshness (median fix age) per provider, because a stale tier that wins the
    union on old positions is worse than a smaller fresh one.

Dedup key
---------
ICAO24 hex, lowercased. Fall back to a composite of callsign+position when a
record has no hex (some mirrors emit `hex`, some `icao24`, some `id`), so a
missing field cannot inflate the union by counting one aircraft twice.
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

from adsb_ocean_probe import (  # noqa: E402  (sibling tool module)
    UA,
    load_land_rings,
    normalize,
    on_land,
    seen_age,
)

# The three hosts measured 200 keyless from this egress on 2026-10-03.
# OpenSky is absent by operator instruction (credit-metered, keyless-but-bounded).
LIVE_KEYLESS: list[tuple[str, str, str]] = [
    ("adsb.lol", "ac", "https://api.adsb.lol/v2/point/0/0/20000"),
    ("tar1090-globe", "aircraft", "https://globe.theairtraffic.com/data/aircraft.json"),
    ("hpradar", "aircraft", "https://skylink.hpradar.com/data/aircraft.json"),
]


def dedup_key(rec: Any, list_key: str) -> str | None:
    if isinstance(rec, dict):
        for f in ("hex", "icao24", "id", "hexStr"):
            v = rec.get(f)
            if isinstance(v, str) and v.strip():
                return f"h:{v.strip().lower()}"
        for f in ("flight", "r", "reg", "registration"):
            v = rec.get(f)
            if isinstance(v, str) and v.strip():
                la, lo = rec.get("lat"), rec.get("lon")
                return f"c:{v.strip().lower()}@{la},{lo}"
    if list_key == "states" and isinstance(rec, list) and rec:
        return f"h:{str(rec[0]).lower()}"
    return None


async def fetch(
    client: httpx.AsyncClient, url: str, list_key: str, rings: list[Any]
) -> tuple[dict[str, dict[str, Any]], list[float], int]:
    """Return ({dedup_key: record}, [ages], http_status)."""
    ages: list[float] = []
    r = await client.get(url)
    if r.status_code != 200:
        return {}, [], r.status_code
    body = json.loads(r.content)
    recs = body.get(list_key) if isinstance(body, dict) else None
    if not isinstance(recs, list):
        return {}, [], r.status_code
    out: dict[str, dict[str, Any]] = {}
    for rec in recs:
        ll = normalize(rec, list_key)
        if ll is None:
            continue
        lat, lon = ll
        k = dedup_key(rec, list_key)
        if not k:
            continue
        out[k] = {"lat": lat, "lon": lon, "ocean": not on_land(lon, lat, rings)}
        a = seen_age(rec, list_key)
        if a is not None:
            ages.append(a)
    return out, ages, r.status_code


def analyse(
    per_provider: dict[str, dict[str, dict[str, Any]]],
    per_age: dict[str, list[float]],
    per_status: dict[str, int],
) -> dict[str, Any]:
    names = [n for n, _, _ in LIVE_KEYLESS]
    keysets = {n: set(per_provider.get(n, {})) for n in names}

    # Union + marginal contribution.
    union: set[str] = set()
    for n in names:
        union |= keysets[n]
    ocean_union: set[str] = set()
    for n in names:
        for k in keysets[n]:
            if per_provider[n][k]["ocean"]:
                ocean_union.add(k)

    marginal: dict[str, int] = {}
    for n in names:
        others: set[str] = set()
        for m in names:
            if m != n:
                others |= keysets[m]
        marginal[n] = len(keysets[n] - others)

    # Ocean marginal -- who is the ONLY source for a given over-water contact.
    ocean_marginal: dict[str, int] = {}
    for n in names:
        others_ocean: set[str] = set()
        for m in names:
            if m != n:
                others_ocean |= {
                    k for k in keysets[m] if per_provider[m][k]["ocean"]
                }
        mine_ocean = {k for k in keysets[n] if per_provider[n][k]["ocean"]}
        ocean_marginal[n] = len(mine_ocean - others_ocean)

    return {
        "per_provider_total": {n: len(keysets[n]) for n in names},
        "per_provider_ocean": {
            n: sum(1 for k in keysets[n] if per_provider[n][k]["ocean"])
            for n in names
        },
        "per_provider_status": per_status,
        "per_provider_age_median_s": {
            n: (round(statistics.median(per_age[n]), 2) if per_age[n] else None)
            for n in names
        },
        "marginal_total": marginal,
        "marginal_ocean": ocean_marginal,
        "union_total": len(union),
        "union_ocean": len(ocean_union),
        "best_single": max(names, key=lambda n: len(keysets[n])) if names else None,
        "best_marginal": max(names, key=lambda n: marginal[n]) if names else None,
    }


def print_report(a: dict[str, Any]) -> None:
    names = [n for n, _, _ in LIVE_KEYLESS]
    print("\n" + "=" * 88)
    print(f"{'PROVIDER':16}{'HTTP':>6}{'TOTAL':>9}{'OCEAN':>8}{'AGE(s)':>8}"
          f"{'MARGINAL':>10}{'OCEAN-MARG':>12}")
    print("=" * 88)
    for n in names:
        print(
            f"{n:16}{str(a['per_provider_status'].get(n, '-')):>6}"
            f"{a['per_provider_total'].get(n, 0):>9,}"
            f"{a['per_provider_ocean'].get(n, 0):>8,}"
            f"{str(a['per_provider_age_median_s'].get(n)):>8}"
            f"{a['marginal_total'].get(n, 0):>10,}"
            f"{a['marginal_ocean'].get(n, 0):>12,}"
        )
    print("-" * 88)
    print(f"{'UNION':16}{'':6}{a['union_total']:>9,}{a['union_ocean']:>8,}")
    print(f"\nbest single by count : {a['best_single']}")
    print(f"best by marginal    : {a['best_marginal']}  "
          f"(adds {a['marginal_total'].get(a['best_marginal'], 0):,} aircraft "
          f"no other host had)")
    best_single_n = a["per_provider_total"].get(a["best_single"], 0)
    gain = a["union_total"] - best_single_n
    print(f"union vs best single: {best_single_n:,} -> {a['union_total']:,} "
          f"({gain:+,}, {100.0 * gain / max(1, best_single_n):+.1f}%)")


async def sample_once(rings: list[Any]) -> dict[str, Any]:
    sem = asyncio.Semaphore(3)
    per_provider: dict[str, dict[str, dict[str, Any]]] = {}
    per_age: dict[str, list[float]] = {}
    per_status: dict[str, int] = {}

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(30.0, connect=10.0),
        headers={"User-Agent": UA},
        follow_redirects=True,
    ) as client:

        async def one(name: str, key: str, url: str) -> None:
            async with sem:
                try:
                    recs, ages, status = await fetch(client, url, key, rings)
                except Exception as exc:  # noqa: BLE001
                    per_provider[name], per_age[name], per_status[name] = {}, [], -1
                    print(f"  {name}: {type(exc).__name__}: {exc}", file=sys.stderr)
                    return
                per_provider[name] = recs
                per_age[name] = ages
                per_status[name] = status

        await asyncio.gather(*(one(n, k, u) for n, k, u in LIVE_KEYLESS))
    return analyse(per_provider, per_age, per_status)


async def soak(samples: int, interval: int, out_path: str) -> None:
    rings = load_land_rings()
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    print(f"soak: {samples} samples, {interval}s apart, -> {out_path}")
    rows: list[dict[str, Any]] = []
    for i in range(samples):
        t0 = time.monotonic()
        a = await sample_once(rings)
        a["sample"] = i
        a["wall_s"] = round(time.monotonic() - t0, 1)
        rows.append(a)
        with open(out_path, "w") as fh:
            json.dump(rows, fh, indent=1)
        print(
            f"[{i + 1}/{samples}] union={a['union_total']:,} "
            f"ocean={a['union_ocean']:,} "
            + " ".join(f"{n}={a['per_provider_total'].get(n, 0):,}" for n, _, _ in LIVE_KEYLESS)
            + f"  ({a['wall_s']}s)",
            flush=True,
        )
        if i + 1 < samples:
            await asyncio.sleep(interval)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--interval", type=int, default=60)
    ap.add_argument("--out", default="/tmp/adsb_union_soak.json")
    args = ap.parse_args()

    if args.repeat > 1:
        asyncio.run(soak(args.repeat, args.interval, args.out))
        return 0

    rings = load_land_rings()
    a = asyncio.run(sample_once(rings))
    print_report(a)
    with open("/tmp/adsb_union_now.json", "w") as fh:
        json.dump(a, fh, indent=2)
    print("\nwrote /tmp/adsb_union_now.json")
    return 0


if __name__ == "__main__":
    import os  # noqa: E402  (used by soak)

    raise SystemExit(main())
