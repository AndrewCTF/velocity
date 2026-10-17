#!/usr/bin/env python3
"""Measure a candidate list of keyless ADS-B endpoints and rank them for ocean
coverage and update rate.

This is the tool that answers "which host should the pipeline use". It takes a
newline-delimited list of candidate URLs (from research, from a README, from a
gist), probes each ONCE with no credentials, and scores it on what actually
matters for an ocean-coverage pipeline:

    total      how many aircraft it reports
    ocean      how many are over water (Natural Earth land mask, 110m)
    deep       how many are >5 deg from ANY land -- the genuinely-oceanic
               contacts that a coast-based receiver network cannot produce.
               This is the only column that distinguishes real oceanic reach
               from "traffic happens to be near a coast".
    age        median age of the reported fix in seconds. A high age means the
               feed is publishing stale positions, which is worse than a
               smaller feed because it poisons the map with ghosts.
    fresh      a second sample a few seconds later; the fraction of aircraft
               whose fix is NEWER than the first sample. Near zero means the
               host is serving a cached page regardless of what it claims.

Constraint, enforced below
--------------------------
Keyless and unmetered only. A candidate is rejected if it 401/402/403s or if it
answers with a body that looks like an HTML login/paywall page. OpenSky and
every other credit-metered endpoint must not be put in this list: probing one
spends a shared budget the running app depends on.

Politeness
----------
One request per candidate per pass, concurrency capped, a browser UA (some hosts
451 a non-browser UA), no retry on 429/403, and a hard per-request timeout. A
candidate list is untrusted input from research, so the timeout and the
concurrency cap are what keep a bad list from wedging this machine.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
from typing import Any

import httpx

from adsb_ocean_probe import (  # noqa: E402
    UA,
    load_land_rings,
    near_land,
    normalize,
    on_land,
    seen_age,
)

CONCURRENCY = 6
TIMEOUT_S = 30.0

# Hosts that must NEVER be probed: they spend a metered credit budget, which is
# exactly what this tool exists to avoid. Matched on hostname, checked BEFORE
# any request, so a candidate list pasted from the web cannot quietly burn the
# operator's daily allowance — or the pool the running app shares.
#
# OpenSky is the important one. `/states/all` answers a bare 200 with a valid
# `{"states": [...]}` envelope, so a naive probe records "reachable, N aircraft"
# and looks like a WINNER while having silently spent credits. Measured
# 2026-10-04: it returned HTTP 200 and 0 parseable aircraft here, which is even
# worse — a score of 0.0 with no rejection reason, i.e. a silent pass.
_CREDIT_METERED_HOSTS = (
    "opensky-network.org",
    "opensky-network.org.uk",
    "flightradar24.com",
    "fr24.com",
    "flightaware.com",
    "airnavradar.com",
    "airnav.com",
    "radarbox.com",
    "adsbex.io",
    "adsbexchange.com",
    "airto.io",
    "spire.com",
)


def credit_metered(url: str) -> str | None:
    """Return the offending host if ``url`` is a credit-metered provider."""
    host = url.split("//", 1)[-1].split("/", 1)[0].lower()
    for bad in _CREDIT_METERED_HOSTS:
        if host == bad or host.endswith("." + bad):
            return bad
    return None


# Bodies that mean "you need an account / pay / this is a browser page", not
# "here is aircraft". Checked before JSON parsing so a login page is reported as
# a rejection rather than a parse error.
_BLOCKED_MARKERS = re.compile(
    r"(sign in|log ?in|subscribe|api key|apikey|unauthorized|forbidden|"
    r"rate limit|too many requests|cloudflare|captcha|just a moment|"
    r"<!doctype html|<html)",
    re.I,
)


def looks_blocked(status: int, body: bytes, ctype: str) -> str | None:
    if status in (401, 402, 403):
        return f"auth/credit gated (HTTP {status})"
    if status == 429:
        return "rate limited (HTTP 429)"
    if status == 451:
        return "legal block (HTTP 451)"
    if status >= 400:
        return f"HTTP {status}"
    if "json" not in ctype.lower() and _BLOCKED_MARKERS.search(
        body[:400].decode("utf-8", "replace")
    ):
        return "non-JSON page (login/HTML)"
    return None


def key_of(rec: Any) -> str | None:
    if isinstance(rec, dict):
        for f in ("hex", "icao24", "id", "hexStr"):
            v = rec.get(f)
            if isinstance(v, str) and v.strip():
                return v.strip().lower().lstrip("~")
    return None


async def probe(
    client: httpx.AsyncClient,
    url: str,
    rings: list[Any],
    list_keys: tuple[str, ...] = ("ac", "aircraft", "flights", "states"),
) -> dict[str, Any]:
    t0 = time.monotonic()
    out: dict[str, Any] = {
        "url": url,
        "status": None,
        "count": 0,
        "ocean": 0,
        "deep": 0,
        "age_median_s": None,
        "bytes": 0,
        "elapsed_s": 0.0,
        "reject": None,
        "keys": set(),
        "ages": {},
    }
    # Refuse BEFORE any network call: a credit-metered host costs the operator
    # budget (and may share a pool with the running app) just by being asked.
    metered = credit_metered(url)
    if metered:
        out["reject"] = f"credit-metered host, not probed ({metered})"
        out["elapsed_s"] = 0.0
        return out
    try:
        r = await client.get(url)
    except Exception as exc:  # noqa: BLE001
        out["reject"] = f"{type(exc).__name__}"
        out["elapsed_s"] = round(time.monotonic() - t0, 2)
        return out

    out["status"] = r.status_code
    out["bytes"] = len(r.content)
    body = r.content
    rej = looks_blocked(r.status_code, body, r.headers.get("content-type", ""))
    if rej:
        out["reject"] = rej
        out["elapsed_s"] = round(time.monotonic() - t0, 2)
        return out

    try:
        parsed = json.loads(body)
    except ValueError:
        out["reject"] = "not JSON"
        out["elapsed_s"] = round(time.monotonic() - t0, 2)
        return out

    recs = None
    if isinstance(parsed, dict):
        for k in list_keys:
            if isinstance(parsed.get(k), list):
                recs = parsed[k]
                break
        if recs is None and all(isinstance(v, list) for v in parsed.values()) and parsed:
            # A bare list-of-lists (OpenSky `states` shape, or a top-level array).
            recs = next(iter(parsed.values()))
    elif isinstance(parsed, list):
        recs = parsed
    if recs is None:
        out["reject"] = f"no list key (top keys={list(parsed)[:6] if isinstance(parsed, dict) else 'array'})"
        out["elapsed_s"] = round(time.monotonic() - t0, 2)
        return out

    ages: list[float] = []
    for rec in recs:
        ll = normalize(rec, "aircraft")
        if ll is None:
            continue
        lat, lon = ll
        out["count"] += 1
        k = key_of(rec)
        a = seen_age(rec, "aircraft")
        if k:
            out["keys"].add(k)
        if a is not None:
            ages.append(a)
            if k:
                out["ages"][k] = a
        if not on_land(lon, lat, rings):
            out["ocean"] += 1
            if not near_land(lon, lat, rings, halo=5.0):
                out["deep"] += 1
    if ages:
        out["age_median_s"] = round(statistics.median(ages), 3)
    out["elapsed_s"] = round(time.monotonic() - t0, 2)
    return out


def score(p: dict[str, Any]) -> float:
    """Rank keyless feeds for an ocean-coverage pipeline.

    Weighted toward DEEP ocean and freshness, because a large coastal dataset is
    already covered by the incumbent tiers -- what is missing is genuine
    open-ocean reach and a live update rate.
    """
    if p.get("reject"):
        return -1.0
    deep = float(p.get("deep") or 0)
    ocean = float(p.get("ocean") or 0)
    total = float(p.get("count") or 0)
    age = p.get("age_median_s")
    fresh = 1.0
    if age is not None:
        # Age is a multiplier: 0.3s -> ~1.0, 30s -> ~0.1.
        fresh = 1.0 / (1.0 + age / 2.0)
    return (deep * 10.0 + ocean * 1.0 + total * 0.05) * fresh


async def main_async(args: argparse.Namespace) -> int:
    with open(args.candidates) as fh:
        urls = [
            line.strip()
            for line in fh
            if line.strip() and not line.strip().startswith("#")
        ]
    # de-dup, preserve order
    seen: set[str] = set()
    uniq = [u for u in urls if not (u in seen or seen.add(u))]
    print(f"probing {len(uniq)} candidate(s) (keyless, no credits, 1 req each)")
    rings = load_land_rings()
    sem = asyncio.Semaphore(CONCURRENCY)
    results: list[dict[str, Any]] = []

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(TIMEOUT_S, connect=10.0),
        headers={"User-Agent": UA},
        follow_redirects=True,
    ) as client:

        async def one(u: str) -> dict[str, Any]:
            async with sem:
                return await probe(client, u, rings)

        results = list(await asyncio.gather(*(one(u) for u in uniq)))

    # Freshness pass: re-probe the survivors and see how many fixes advanced.
    if args.freshness and results:
        survivors = [r for r in results if not r.get("reject")]
        if survivors:
            print(f"freshness pass on {len(survivors)} survivor(s)...")
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(TIMEOUT_S, connect=10.0),
                headers={"User-Agent": UA},
                follow_redirects=True,
            ) as client:
                await asyncio.sleep(args.freshness_delay)
                second = list(
                    await asyncio.gather(
                        *(probe(client, r["url"], rings) for r in survivors)
                    )
                )
            by_url = {s["url"]: s for s in second}
            for r in survivors:
                s = by_url.get(r["url"])
                if not s:
                    continue
                r["fresh_fraction"] = _fresh_fraction(r, s)
                r["second_count"] = s.get("count")

    results.sort(key=score, reverse=True)

    def fresh_cell(r: dict[str, Any]) -> str:
        ff = r.get("fresh_fraction")
        return f"{ff:.0%}" if ff is not None else "-"

    print("\n" + "=" * 104)
    print(
        f"{'URL':52}{'HTTP':>5}{'TOTAL':>9}{'OCEAN':>8}{'DEEP':>6}"
        f"{'AGE(s)':>8}{'FRESH':>7}{'MB':>7}{'s':>6}  NOTE"
    )
    print("=" * 104)
    for r in results:
        note = r.get("reject") or ""
        if r.get("fresh_fraction") is not None:
            note = f"fresh={r['fresh_fraction']:.1%}"
        print(
            f"{r['url'][:52]:52}{str(r.get('status') or '-'):>5}{r['count']:>9,}"
            f"{r['ocean']:>8,}{r['deep']:>6,}"
            f"{str(r.get('age_median_s')):>8}{fresh_cell(r):>7}"
            f"{r['bytes'] / 1e6:>7.2f}{r['elapsed_s']:>6.1f}  {note}"
        )
    print("\nSCORE (deep-weighted x freshness):")
    for r in results[:10]:
        print(f"  {score(r):>10.1f}  {r['url']}")
    with open(args.out, "w") as fh:
        json.dump(
            [
                {k: v for k, v in r.items() if k not in ("keys", "ages")}
                for r in results
            ],
            fh,
            indent=2,
        )
    print(f"\nwrote {args.out}")
    return 0


def _fresh_fraction(first: dict[str, Any], second: dict[str, Any]) -> float:
    """Fraction of shared aircraft whose reported age got YOUNGER."""
    a1, a2 = first.get("ages") or {}, second.get("ages") or {}
    shared = set(a1) & set(a2)
    if not shared:
        return 0.0
    newer = sum(1 for k in shared if a2[k] < a1[k] - 0.05)
    return newer / len(shared)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--candidates", required=True, help="file of candidate URLs")
    ap.add_argument("--out", default="/tmp/adsb_candidates.json")
    ap.add_argument("--freshness", action="store_true", default=True)
    ap.add_argument("--no-freshness", dest="freshness", action="store_false")
    ap.add_argument("--freshness-delay", type=float, default=20.0)
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
