#!/usr/bin/env python3
"""Measure which keyless ADS-B provider actually covers ocean, and by how much.

Why this exists
---------------
"Full coverage across oceans" is a RECEIVER question, not a scraping question.
ADS-B is line-of-sight: a Mode-S transponder is only seen by receivers within
roughly 160-250 NM. There are almost no receivers in the middle of the South
Pacific. No scraper can invent a fix nobody uplinked, so this script exists to
separate two very different outcomes that are easy to confuse:

  1. A provider whose *network* covers the oceans (community feeders at sea,
     air-to-air relays, satellite ADSBX) -- measurable, and worth buying into.
  2. A provider that reports many aircraft over water that it could not
     physically have heard -- stale extrapolated "ghost" positions.

A high total count is therefore NOT evidence of ocean coverage. The only honest
metric is: how many aircraft does this provider report in ocean basins, and how
fresh is that data (age in seconds). A fix that is 20 minutes old is not coverage.

Usage
-----
    python tools/adsb_ocean_probe.py                # probe every provider
    python tools/adsb_ocean_probe.py --repeat 3     # sample 3x over ~60s
    python tools/adsb_ocean_probe.py --json out.json

Cost discipline (this repo's rule, see docs/decisions.md)
--------------------------------------------------------
Every upstream is an unbudgeted free service that can ban a datacenter egress.
The probe therefore:
  * sends ONE request per provider per run (except the firehose, which is the
    whole point and is also the one the app already pulls),
  * never retries a 429/403 -- it records the status and moves on,
  * sends a real browser User-Agent (adsb.lol 451s a non-browser UA),
  * stays under a hard concurrency of 4 and a 25 s per-request timeout.

Read the output as: which basin rows are non-empty, and what the age column
says. Anything with age > 300 s over ocean is a ghost, not coverage.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# ── Ocean basins ──────────────────────────────────────────────────────────
# Coarse boxes (lat_min, lat_max, lon_min, lon_max) chosen to sit in genuinely
# empty regions -- deliberately NOT on the great-circle tracks, because a
# transoceanic corridor is the one ocean place a coast-based receiver network
# reliably hears. If a provider only covers corridors, that is what these boxes
# will show.
BASINS: dict[str, tuple[float, float, float, float]] = {
    "N Atlantic (mid)": (40.0, 55.0, -50.0, -20.0),
    "S Atlantic": (-30.0, -5.0, -25.0, 5.0),
    "N Pacific (mid)": (30.0, 45.0, -170.0, -140.0),
    "Mid Pacific (equat)": (-10.0, 10.0, -160.0, -120.0),
    "S Pacific (empty)": (-40.0, -20.0, -130.0, -100.0),
    "Indian Ocean (S)": (-35.0, -10.0, 60.0, 90.0),
    "Southern Ocean": (-60.0, -45.0, 20.0, 80.0),
    "Arctic Ocean": (82.0, 89.0, -60.0, 60.0),
}

# A generous "any land nearby" halo, so a basin point counts as OCEAN only if
# there is no land within ~2.5 degrees (~150 NM, the edge of receiver reach).
LAND_HALO_DEG = 2.5


# ── Land mask ─────────────────────────────────────────────────────────────
# Natural Earth 110m land, cached on disk. Parsed with a plain scanline over the
# GeoJSON rings -- no shapely/geopandas in this venv, and adding one to a repo
# whose API image is already large is not worth it for a probe. 110m is plenty:
# we only need to know "is this point ocean", and 110m resolves coastlines to
# ~100 km, far below the 150 NM receiver horizon we are testing against.
_LAND_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_110m_land.geojson"
)
_LAND_CACHE = "/tmp/ne_110m_land.geojson"


def load_land_rings() -> list[list[list[float]]]:
    """Return land polygon rings as [[(lon, lat), ...], ...]."""
    import urllib.request

    try:
        with open(_LAND_CACHE, "rb") as fh:
            raw = fh.read()
    except FileNotFoundError:
        req = urllib.request.Request(_LAND_URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
        with open(_LAND_CACHE, "wb") as fh:
            fh.write(raw)
    gj = json.loads(raw)

    rings: list[list[list[float]]] = []

    def walk(geom: dict[str, Any]) -> None:
        t = geom.get("type")
        if t == "Polygon":
            for ring in geom["coordinates"]:
                rings.append([[float(x), float(y)] for x, y in ring])
        elif t == "MultiPolygon":
            for poly in geom["coordinates"]:
                for ring in poly:
                    rings.append([[float(x), float(y)] for x, y in ring])

    for feat in gj.get("features", []):
        walk(feat["geometry"])
    return rings


def point_in_ring(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """Standard even-odd ray cast: shoot +lon, count edge crossings.

    Edges are treated as the half-open segment [y1, y2) so that a vertex sitting
    exactly on the scanline is counted once rather than twice.
    """
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 <= lat < y2) or (y2 <= lat < y1):
            # Parameter along the edge where it crosses this latitude.
            x_at = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < x_at:
                inside = not inside
    return inside


def on_land(lon: float, lat: float, rings: list[list[list[float]]]) -> bool:
    for ring in rings:
        if point_in_ring(lon, lat, ring):
            return True
    return False


def near_land(
    lon: float, lat: float, rings: list[list[list[float]]], halo: float = LAND_HALO_DEG
) -> bool:
    """True if land or water within `halo` degrees -- i.e. a coastal receiver
    could plausibly hear this point. Ocean coverage only counts where False."""
    if on_land(lon, lat, rings):
        return True
    for d in (halo, -halo):
        for step in range(-6, 7):
            slat = lat + d
            if abs(slat) > 89.5:
                continue
            slon = (lon + step * halo / 6.0 + 180.0) % 360.0 - 180.0
            if on_land(slon, slat, rings):
                return True
    return False


def ocean_points_in_box(
    box: tuple[float, float, float, float], rings: list[list[list[float]]]
) -> list[tuple[float, float]]:
    """Sample a lat/lon box on a 2-degree mesh, keep only true-ocean points."""
    lat0, lat1, lon0, lon1 = box
    out: list[tuple[float, float]] = []
    lat = lat0
    while lat <= lat1:
        lon = lon0
        while lon <= lon1:
            if not near_land(lon, lat, rings):
                out.append((lat, lon))
            lon += 2.0
        lat += 2.0
    return out


# ── Providers ─────────────────────────────────────────────────────────────
@dataclass
class Provider:
    name: str
    url: str
    # How many aircraft the response contains, and where.
    count: int | None = None
    status: int | None = None
    error: str | None = None
    bytes_seen: int = 0
    ocean_count: int = 0
    land_count: int = 0
    # median age of the reported fixes, in seconds
    age_median_s: float | None = None
    lat: list[float] = field(default_factory=list)
    lon: list[float] = field(default_factory=list)
    seen: list[float] = field(default_factory=list)
    elapsed_s: float = 0.0


PROVIDERS: list[Provider] = [
    # ── Keyless, no credit meter, no API key. This is the whole list. ──
    #
    # OpenSky is deliberately ABSENT. /states/all spends a 400-credit/day
    # anonymous per-IP pool, and the operator's standing instruction is that no
    # provider may cost credits or need a key. Probing it here would burn the
    # budget the running app's own OpenSky tier depends on, so this script never
    # touches it. For that baseline read the app's already-built snapshot
    # (`/api/adsb/global`) instead -- zero upstream cost.
    Provider(
        "adsb.lol firehose (/v2/point/0/0/20000)",
        "https://api.adsb.lol/v2/point/0/0/20000",
    ),
    Provider("adsb.fi snapshot", "https://opendata.adsb.fi/api/v2/snapshot"),
    Provider("adsb.lol /v2/mil", "https://api.adsb.lol/v2/mil"),
    Provider(
        "airplanes.live /v2/point/0/0/20000",
        "https://api.airplanes.live/v2/point/0/0/20000",
    ),
    Provider(
        "tar1090 mirror globe.theairtraffic",
        "https://globe.theairtraffic.com/data/aircraft.json",
    ),
    Provider("hpradar mirror", "https://skylink.hpradar.com/data/aircraft.json"),
    Provider("adsb.one /v2/point", "https://api.adsb.one/v2/point/0/0/20000"),
    Provider("adsbexchange (hosted)", "https://www.adsbexchange.com/api/aircraft/json"),
    # README-documented mirror, no key, no credits. Served by the ops manager's
    # own worker; the README ships the exact URLs it currently advertises.
    Provider("ADSB.lol ops-manager mirror", "https://ops-manager.adsb.lol/api/v2/point/0/0/20000"),
    Provider("adsb.lol README mirror (api.2)", "https://api.2.adsb.lol/v2/point/0/0/20000"),
]


def parse_records(p: Provider, body: bytes) -> tuple[list[dict[str, Any]], str]:
    """Return (records, list_key). Handles the common aggregators' shapes."""
    j = json.loads(body)
    if not isinstance(j, dict):
        raise ValueError("non-dict body")
    for key in ("ac", "aircraft", "flights", "states", "data"):
        if isinstance(j.get(key), list):
            return j[key], key
    raise ValueError(f"no known list key (keys={list(j)[:8]})")


def normalize(rec: Any, list_key: str) -> tuple[float, float] | None:
    """Extract (lat, lon) from one record across the shapes these hosts use."""
    lat = rec.get("lat") if isinstance(rec, dict) else None
    lon = rec.get("lon") if isinstance(rec, dict) else None
    if isinstance(rec, dict):
        if lat is None:
            lat = rec.get("latitude")
        if lon is None:
            lon = rec.get("longitude")
    # OpenSky "states" entries are positional arrays:
    #   0 icao24  1 callsign  2 origin  3 time_position  4 last_contact
    #   5 longitude  6 latitude  7 baro_alt  8 on_ground  ...
    elif list_key == "states" and isinstance(rec, list) and len(rec) >= 7:
        lon, lat = rec[5], rec[6]
    if lat is None or lon is None:
        return None
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0):
        return None
    # A position over the pole or exactly (0,0) is the "unknown position"
    # sentinel several of these feeds emit; it would pollute the ocean stats.
    if lat_f == 0.0 and lon_f == 0.0:
        return None
    return lat_f, lon_f


def seen_age(rec: Any, list_key: str) -> float | None:
    """Age of the fix in seconds, if the upstream publishes one."""
    now = time.time()
    if list_key == "states" and isinstance(rec, list):
        # index 4 is last_contact (epoch seconds); index 3 is time_position.
        if len(rec) > 4 and rec[4]:
            try:
                return max(0.0, now - float(rec[4]))
            except (TypeError, ValueError):
                return None
        return None
    if not isinstance(rec, dict):
        return None
    for k in ("seen_pos", "last_contact", "updated", "timestamp", "time_position"):
        v = rec.get(k)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if v > 1e9:  # epoch seconds
            return max(0.0, now - v)
        return max(0.0, v)  # adsb.lol/airplanes.live: already an age in seconds
    return None


async def probe_one(
    client: httpx.AsyncClient, p: Provider, rings: list[list[list[float]]]
) -> None:
    t0 = time.monotonic()
    try:
        r = await client.get(p.url)
        p.status = r.status_code
        body = r.content
        p.bytes_seen = len(body)
        if r.status_code != 200:
            p.error = f"HTTP {r.status_code}"
            return
        recs, key = parse_records(p, body)
        ages: list[float] = []
        for rec in recs:
            ll = normalize(rec, key)
            if ll is None:
                continue
            lat, lon = ll
            p.lat.append(lat)
            p.lon.append(lon)
            age = seen_age(rec, key)
            if age is not None:
                ages.append(age)
            if on_land(lon, lat, rings):
                p.land_count += 1
            else:
                p.ocean_count += 1
        p.count = len(p.lat)
        if ages:
            p.age_median_s = statistics.median(ages)
    except Exception as exc:  # noqa: BLE001 -- probe reports, never raises
        p.error = f"{type(exc).__name__}: {exc}"
    finally:
        p.elapsed_s = time.monotonic() - t0


def summarize_basins(p: Provider) -> dict[str, int]:
    """Per-basin counts from the already-collected positions."""
    out: dict[str, int] = {}
    for name, box in BASINS.items():
        lat0, lat1, lon0, lon1 = box
        n = sum(
            1
            for la, lo in zip(p.lat, p.lon)
            if lat0 <= la <= lat1 and lon0 <= lo <= lon1
        )
        out[name] = n
    return out


def fmt_providers(results: list[Provider]) -> str:
    lines = [
        "",
        "=" * 100,
        f"{'PROVIDER':46} {'HTTP':>4} {'N':>7} {'OCEAN':>6} {'LAND%':>6} {'AGE(s)':>8} {'MB':>6} {'s':>5}",
        "=" * 100,
    ]
    for p in sorted(results, key=lambda x: -(x.count or 0)):
        pct = (100.0 * p.land_count / p.count) if p.count else 0.0
        note = f"  {p.error}" if p.error else ""
        lines.append(
            f"{p.name[:46]:46} {str(p.status or '-'):>4} {str(p.count or 0):>7} "
            f"{p.ocean_count:>6} {pct:>5.1f}% "
            f"{(f'{p.age_median_s:.1f}' if p.age_median_s is not None else '-'):>8} "
            f"{p.bytes_seen / 1e6:>6.2f} {p.elapsed_s:>5.1f}{note}"
        )
    return "\n".join(lines)


def fmt_basins(results: list[Provider]) -> str:
    names = list(BASINS)
    lines = ["", "OCEAN BASIN COUNTS", "=" * 100]
    lines.append(f"{'PROVIDER':40}" + "".join(f"{n.split('(')[0].strip()[:11]:>13}" for n in names))
    lines.append("-" * 100)
    for p in sorted(results, key=lambda x: -(x.ocean_count)):
        if not p.count:
            continue
        cells = summarize_basins(p)
        lines.append(f"{p.name[:40]:40}" + "".join(f"{cells[n]:>13,}" for n in names))
    return "\n".join(lines)


async def run_once(repeat: int) -> list[Provider]:
    """Probe every provider `repeat` times. Returns one entry per PROVIDER,
    aggregating across repeats (max count seen, summed ocean/land)."""
    rings = load_land_rings()
    sem = asyncio.Semaphore(4)  # stay a polite client

    async def guarded(p: Provider, client: httpx.AsyncClient) -> None:
        async with sem:
            await probe_one(client, p, rings)

    timeout = httpx.Timeout(25.0, connect=10.0)
    per_provider: dict[str, Provider] = {}
    async with httpx.AsyncClient(
        timeout=timeout, headers={"User-Agent": UA}, follow_redirects=True
    ) as client:
        for i in range(repeat):
            batch = [Provider(p.name, p.url) for p in PROVIDERS]
            await asyncio.gather(*(guarded(p, client) for p in batch))
            for fresh in batch:
                agg = per_provider.setdefault(
                    fresh.name, Provider(fresh.name, fresh.url)
                )
                if (fresh.count or 0) > (agg.count or 0):
                    agg.status = fresh.status
                    agg.error = fresh.error
                    agg.count = fresh.count
                    agg.ocean_count = fresh.ocean_count
                    agg.land_count = fresh.land_count
                    agg.bytes_seen = fresh.bytes_seen
                    agg.elapsed_s = fresh.elapsed_s
                    agg.lat, agg.lon = fresh.lat, fresh.lon
                    if fresh.age_median_s is not None:
                        agg.age_median_s = fresh.age_median_s
                elif fresh.error and not agg.error:
                    agg.error = fresh.error
                    agg.status = agg.status or fresh.status
            if i + 1 < repeat:
                print(f"  ... sampled {i + 1}/{repeat}, sleeping 20s", file=sys.stderr)
                await asyncio.sleep(20)
    return list(per_provider.values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    print(f"probing {len(PROVIDERS)} providers from this egress, repeat={args.repeat}")
    t0 = time.monotonic()
    results = asyncio.run(run_once(args.repeat))
    print(fmt_providers(results))
    print(fmt_basins(results))

    winner = max(results, key=lambda x: (x.count or 0) * (1.0 + x.ocean_count / max(1, x.count or 1)))
    print(f"\nBEST BY (total x ocean-weighted): {winner.name}")
    print(f"  count={winner.count}  ocean={winner.ocean_count}  "
          f"median_age_s={winner.age_median_s}  status={winner.status}")

    if args.json_out:
        payload = [
            {
                "name": p.name,
                "url": p.url,
                "status": p.status,
                "count": p.count,
                "ocean": p.ocean_count,
                "land": p.land_count,
                "age_median_s": p.age_median_s,
                "mb": round(p.bytes_seen / 1e6, 2),
                "elapsed_s": round(p.elapsed_s, 2),
                "error": p.error,
                "basins": summarize_basins(p) if p.count else {},
            }
            for p in results
        ]
        with open(args.json_out, "w") as fh:
            json.dump(payload, fh, indent=2)
        print(f"wrote {args.json_out}")

    print(f"\ntotal wall clock: {time.monotonic() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
