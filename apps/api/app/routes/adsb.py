"""GET /api/adsb/* — open ADS-B aggregators.

Per research.md §3 / research_updated.md §2.7:
- ADSB.lol — no auth, dynamic rate; ODbL. Most reliable upstream.
- airplanes.live — no auth; 1 req/s; non-commercial. /mil for military filter,
  /squawk/{code} for emergency, /point/{lat}/{lon}/{nm≤250} for radius.

All routes return GeoJSON FeatureCollection so the same PollGeoJsonAdapter
renders them. We normalize their slightly-different JSON shapes (both are
ADSBExchange-compatible) into our aircraft schema.

Design notes (post-breaker rewrite):
- The per-host circuit breaker was REMOVED. With the operator's egress IP
  rate-limited from 2 of 3 hosts, the breaker pinned the survivors open and
  starved the merge. Simpler "try each host in order, take first 200, cache
  result" approach is faster and self-heals: a host that 429'd one cell may
  still serve the next once its sliding window advances.
- Per-cell TTL is 30s full / 5s empty (CLAUDE.md guardrail). A productive
  cell holds 30s so steady-state upstream load is ~4-5 cells/sec — under
  airplanes.live's burst limit, which is often the ONLY reachable host. Empty
  cells keep a 5s TTL so a transiently-throttled cell refills fast. The
  sticky snapshot dict IS the merge cache — the hot route returns it in
  microseconds. The background refresher loop targets a 5s cycle (sleep =
  max(0, 5.0 - elapsed)) so a fast fan-out doesn't burn CPU and a slow
  fan-out doesn't add extra idle latency.
- Frontend polls every 5s + snapshot ≤5s old = end-to-end ≤10s.
- ~120 hand-picked dense cells over land (was 250+). Smaller grid × tighter
  TTL beats larger grid × longer TTL when egress is throttled.
- OpenSky (authed, env creds) sits between the anonymous firehoses and the
  per-cell grid in the degradation ladder.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import time
from math import cos, radians
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.ingest.opensky import OpenSkyTokenManager, fetch_states, states_to_geojson
from app.routes.aviation import _token_manager
from app.upstream import cache, get_client

router = APIRouter(tags=["adsb"])

# Cap concurrent upstream ADS-B fetches across the global fan-out. Cell-level
# caches still allow parallel cache hits; this semaphore only gates the actual
# upstream call inside `load_cell` so cold-start (all-miss) bursts cannot
# stampede the shared httpx client or trip per-host rate limits.
#
# Sized to airplanes.live's burst tolerance. Measured: ~8 concurrent
# /v2/point requests all return 200+JSON; ~15 concurrent trips the limiter,
# which answers with EITHER HTTP 429 OR — the sneaky case — HTTP 200 and a
# text/plain "You have been rate limited" body. With adsb.lol / adsb.fi
# frequently unreachable, airplanes.live is often the ONLY live host, so a
# 64-wide burst rate-limited most cells into empty results and the map showed
# only a few hundred aircraft. The 10s per-cell cache carries steady-state
# load; this cap only paces the cold-start stampede. Keep ≤8.
_UPSTREAM_SEMAPHORE = asyncio.Semaphore(8)

# Per-cell cache TTLs. CLAUDE.md pins the per-cell server cache at 30s — a
# productive cell holds its aircraft for 30s so the background loop only
# refetches ~134/30 ≈ 4-5 cells/sec in steady state, far under airplanes.live's
# burst limit. (At the old 10s this was ~13 cells/sec, which — combined with a
# 64-wide semaphore — bursted the only live host into rate-limiting most cells
# into emptiness.) The merge-with-previous carry-forward (75s) interpolates
# positions on the frontend, so 30s server cache is invisible to the operator.
# Empty cells keep a SHORT 5s TTL so a cell that came back empty under transient
# throttle retries quickly and fills in as the limiter cools, instead of being
# pinned blank for the full 30s.
_CELL_TTL_FULL = 30.0
_CELL_TTL_EMPTY = 5.0


def _aircraft_geojson(items: list[dict[str, Any]]) -> dict[str, Any]:
    features: list[dict[str, Any]] = []
    for a in items:
        lon = a.get("lon")
        lat = a.get("lat")
        if lon is None or lat is None:
            continue
        icao24 = (a.get("hex") or a.get("icao") or "").lower()
        if not icao24:
            continue
        callsign = (a.get("flight") or a.get("r") or "").strip() or None
        alt_baro = a.get("alt_baro")
        alt_geom = a.get("alt_geom")
        try:
            alt_baro_m = float(alt_baro) * 0.3048 if isinstance(alt_baro, (int, float)) else None
        except (TypeError, ValueError):
            alt_baro_m = None
        try:
            alt_geom_m = float(alt_geom) * 0.3048 if isinstance(alt_geom, (int, float)) else None
        except (TypeError, ValueError):
            alt_geom_m = None
        props: dict[str, Any] = {
            "icao24": icao24,
            "callsign": callsign,
            "registration": a.get("r"),
            "type": a.get("t"),
            "category": a.get("category"),
            "on_ground": (a.get("alt_baro") == "ground"),
            "velocity_ms": _to_ms(a.get("gs")),
            "track_deg": a.get("track"),
            "baro_alt_m": alt_baro_m,
            "geo_alt_m": alt_geom_m,
            "squawk": a.get("squawk"),
            "emergency": a.get("emergency"),
            # GNSS integrity fields per research_updated.md §2.7 / research.md §5.
            # nac_p = Navigation Accuracy Category (position); FAA wants ≥8.
            # nic   = Navigation Integrity Category; FAA wants ≥7.
            # Pass through verbatim so the jamming-cluster correlator and the
            # /api/jamming/nacp aggregator can read them off the same payload.
            "nac_p": a.get("nac_p"),
            "nic": a.get("nic"),
            "sil": a.get("sil"),
            "nac_v": a.get("nac_v"),
            "kind": "aircraft",
            "source": "adsb",
        }
        # seen_pos from upstream is "seconds since last position update" — pass
        # through so the frontend can tint stale dots.
        seen_pos = a.get("seen_pos")
        if isinstance(seen_pos, (int, float)):
            props["seen_pos_s"] = float(seen_pos)
        seen_at = a.get("_seen_at")
        if isinstance(seen_at, (int, float)):
            props["seen_at"] = float(seen_at)
        features.append(
            {
                "type": "Feature",
                "id": f"aircraft:{icao24}",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(lon), float(lat), alt_geom_m or alt_baro_m or 0],
                },
                "properties": props,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _to_ms(knots: Any) -> float | None:
    try:
        return float(knots) * 0.514444 if knots is not None else None
    except (TypeError, ValueError):
        return None


class _UpstreamUnavailable(Exception):
    """Every host for a cell failed or rate-limited. Distinct from a genuine
    empty-airspace answer — the caller must NOT cache this as an empty cell."""


def _parse_ac(r: httpx.Response) -> list[dict[str, Any]] | None:
    """Aircraft list from a JSON 200, or None when the body is not JSON.

    airplanes.live signals throttling with EITHER HTTP 429 OR — the case that
    silently broke the grid — HTTP 200 with a `text/plain` body
    ("You have been rate limited ..."). A bare `r.json()` raises ValueError on
    that body; the old code swallowed it and returned an empty cell, which then
    cached as "no aircraft here" for several seconds. We instead return None to
    mean "throttled / junk — try another host, don't cache", kept distinct from
    a valid JSON body whose `ac` list is genuinely empty (→ `[]`, safe to
    cache)."""
    if "json" not in r.headers.get("content-type", "").lower():
        return None
    try:
        j = r.json()
    except ValueError:
        return None
    if not isinstance(j, dict):
        return None
    ac = j.get("ac")
    if ac is None:
        ac = j.get("aircraft")
    return list(ac or [])


# ── ADSB.lol ──────────────────────────────────────────────────────────────
@router.get("/api/adsb/lol/point")
async def adsb_lol_point(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_nm: int = Query(250, ge=1, le=250),
) -> dict[str, Any]:
    key = f"adsblol:point:{lat:.2f}:{lon:.2f}:{radius_nm}"

    async def load() -> dict[str, Any]:
        url = f"https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}"
        r = await get_client().get(url)
        if r.status_code != 200:
            raise HTTPException(502, f"adsb.lol upstream {r.status_code}")
        j = r.json()
        return _aircraft_geojson(j.get("ac") or [])

    return await cache.get_or_fetch(key, 10.0, load)


# Hand-picked dense grid (~120 cells) over land + a handful of oceanic
# corridors. Smaller than the old 250+ cell mesh because the operator's
# egress IP is rate-limited from 2 of 3 hosts; fewer cells × tighter TTL
# gives better throughput than blasting upstream with every poll.
#
# Math: ~120 cells × 5s TTL = ~24 upstream calls/sec ÷ 3 hosts = ~8/sec per
# host — well under any free aggregator's burst budget. Even if 2 of 3 hosts
# are 429'ing, the survivor sees ~24/sec, still within steady-state limits
# because the per-cell cache absorbs duplicate polls.

_LAT_STEP: float = 4.0

# Coarse continent bounding boxes. Intentionally loose — we'd rather poll an
# extra coastal cell than miss one. Each box is (lat_min, lat_max, lon_min, lon_max).
_LAND_BBOXES: tuple[tuple[float, float, float, float], ...] = (
    # North America
    (26.0, 49.0, -124.0, -68.0),   # CONUS
    (49.0, 60.0, -130.0, -60.0),   # S Canada
    (16.0, 32.0, -116.0, -88.0),   # Mexico
    (8.0, 22.0, -90.0, -62.0),     # Central America + Caribbean
    # South America
    (-38.0, 12.0, -76.0, -38.0),
    # Europe + Mediterranean
    (36.0, 60.0, -10.0, 30.0),     # Europe core
    (50.0, 68.0, -10.0, 28.0),     # UK / Ireland / Scandinavia
    (24.0, 38.0, -8.0, 36.0),      # N Africa Med
    # Africa
    (-34.0, 22.0, -16.0, 46.0),
    # Middle East
    (14.0, 40.0, 34.0, 60.0),
    # S Asia
    (8.0, 36.0, 68.0, 92.0),
    # SE Asia + Indonesia / Philippines
    (-10.0, 28.0, 92.0, 128.0),
    # China + Mongolia + Korea + Japan
    (22.0, 50.0, 80.0, 146.0),
    # Australia
    (-38.0, -12.0, 113.0, 154.0),
    # NZ
    (-47.0, -34.0, 166.0, 178.0),
)


def _in_land(lat: float, lon: float) -> bool:
    for la0, la1, lo0, lo1 in _LAND_BBOXES:
        if la0 <= lat <= la1 and lo0 <= lon <= lo1:
            return True
    return False


# Major transoceanic flight corridors. Handful of anchors so the map doesn't
# look like the Pacific / Atlantic / Indian Ocean is empty.
_OCEAN_CORRIDORS: tuple[tuple[float, float], ...] = (
    # North Atlantic
    (50.0, -40.0), (45.0, -30.0), (40.0, -45.0), (40.0, -25.0),
    # North Pacific
    (45.0, -160.0), (40.0, -175.0), (35.0, -160.0),
    # Tropical Pacific
    (15.0, -160.0), (0.0, -150.0),
    # Indian Ocean
    (-10.0, 65.0), (-20.0, 75.0),
)


def _build_global_grid() -> list[tuple[float, float]]:
    cells: list[tuple[float, float]] = []
    lat = -38.0
    while lat <= 68.0 + 1e-6:
        c = cos(radians(lat))
        if c < 0.15:
            c = 0.15
        # 4° lat / 4°·sec(lat) lon — keeps on-ground spacing roughly constant.
        lon_step = _LAT_STEP / c
        n = max(1, int(round(360.0 / lon_step)))
        lon_step = 360.0 / n
        for i in range(n):
            lon = -180.0 + i * lon_step + lon_step / 2.0
            if lon >= 180.0:
                lon -= 360.0
            if _in_land(lat, lon):
                cells.append((round(lat, 2), round(lon, 2)))
        lat += _LAT_STEP
    # Decimate down to ~110 cells (deterministic stride so cells are stable
    # across polls — same cell → same cache key → cache hit). Without this
    # the 4° land mesh is ~250 cells, blowing the upstream budget when
    # 2 of 3 hosts are rate-limited. Optimal: ~110-120 cells.
    target = 110
    if len(cells) > target:
        stride = max(1, len(cells) // target)
        cells = cells[::stride]
    # Union in the oceanic corridors.
    seen = set(cells)
    for la, lo in _OCEAN_CORRIDORS:
        key = (float(la), float(lo))
        if key not in seen:
            cells.append(key)
            seen.add(key)
    return cells


_GLOBAL_GRID: list[tuple[float, float]] = _build_global_grid()


# Hosts we rotate across grid cells. ADSB.lol is the most reliable
# aggregator, so it's deliberately placed at index 1 (the second try after
# whichever airplanes.live cell is the deterministic primary). When
# airplanes.live rate-limits us, adsb.lol picks up the slack with the lowest
# miss rate.
#
# The per-host primary is chosen deterministically by md5(lat,lon) so the
# same cell always lands on the same host across polls (good for the
# upstream's own cache locality). On 429/403/timeout we just walk down the
# list — no breaker, no long-term memory of failures. A host that 429'd one
# cell may still serve the next once its sliding rate-limit window advances.
_HEAD_HOSTS: list[str] = [
    "https://api.airplanes.live",
    "https://api.adsb.lol",
    "https://opendata.adsb.fi/api",
]


# True global firehose endpoints. ~17k aircraft are airborne worldwide at any
# given moment; the per-cell grid below caps out around 3-4k even on a good
# day because of overlap, throttling, and cells that 429 mid-fan-out. Each
# of these single-shot endpoints returns *every* aircraft the aggregator
# knows about in one response — when one of them answers, we skip the grid
# entirely and ship 10-15k features instead of 3k.
#
# The order matters: airplanes.live first because its dataset is the largest
# and it explicitly publishes /v2/all-with-pos as the firehose verb;
# adsb.lol second (same verb, ADSBExchange-compatible payload); adsb.fi
# last via its dedicated /v2/snapshot endpoint. On 429 / 403 / 451 / 5xx we
# walk to the next; if all firehoses fail we fall through to the per-cell
# grid below, so a temporary rate-limit blip on every host doesn't blank
# the map (the existing snapshot retain-fraction guard further smooths
# this).
_FIREHOSE_URLS: tuple[str, ...] = (
    "https://api.airplanes.live/v2/all-with-pos",
    "https://api.adsb.lol/v2/all-with-pos",
    "https://opendata.adsb.fi/api/v2/snapshot",
    # adsb.lol full-snapshot quirk: a /v2/point at the globe centre with a
    # planet-spanning radius returns EVERY aircraft adsb.lol knows (~8-9k),
    # keyless and — unlike /v2/point grid cells and the /v2/all* verbs — NOT
    # Cloudflare/451-blocked from a datacenter egress (measured 8,473 from the
    # droplet while the all-with-pos verbs 404 and the aircraft.json mirrors
    # ReadError). It's the reliable breadth partner to OpenSky's ~9k; unioned by
    # icao24 the two push the snapshot back toward ~13k. Tried after the real
    # firehose verbs so a residential deploy still prefers them.
    "https://api.adsb.lol/v2/point/0/0/20000",
)


def _primary_host_idx(lat: float, lon: float) -> int:
    """Deterministic (lat,lon) → primary host index. Stable across polls."""
    key = f"{lat:.4f}:{lon:.4f}".encode()
    h = hashlib.md5(key, usedforsecurity=False).digest()
    return h[0] % len(_HEAD_HOSTS)


# Anchor fallback — coarse continental hub list. Only fires when the full
# grid produced fewer than _FALLBACK_MIN_AIRCRAFT aircraft (severe upstream
# degradation). Anchors reuse the same /v2/point verb so a single surviving
# host can serve them.
_FALLBACK_MIN_AIRCRAFT = 500
_ANCHOR_POINTS: tuple[tuple[float, float], ...] = (
    # North America
    (40.0, -74.0),    # NYC / mid-Atlantic
    (34.0, -118.0),   # LA / SoCal
    (41.9, -87.6),    # Chicago / Great Lakes
    (29.8, -95.4),    # Houston / Gulf
    (33.7, -84.4),    # Atlanta / SE US
    (47.6, -122.3),   # Seattle / PNW
    (49.0, -97.0),    # Manitoba / central Canada
    # Europe
    (51.5, 0.0),      # London / Channel
    (48.8, 2.4),      # Paris
    (50.1, 8.7),      # Frankfurt / DACH
    (52.5, 13.4),     # Berlin / N Germany
    (41.0, 12.5),     # Rome / central Med
    (55.7, 37.6),     # Moscow
    # Asia
    (31.2, 121.5),    # Shanghai / E China
    (39.9, 116.4),    # Beijing / N China
    (35.7, 139.7),    # Tokyo / Kanto
    (22.3, 114.2),    # HK / Pearl River Delta
    (1.4, 103.8),     # Singapore / SE Asia
    (28.6, 77.2),     # Delhi / N India
    (25.3, 55.4),     # Dubai / Gulf
    # Oceania
    (-33.9, 151.2),   # Sydney
    # South America
    (-23.5, -46.6),   # São Paulo
    (-34.6, -58.4),   # Buenos Aires
    # Africa
    (-26.2, 28.0),    # Johannesburg
    (30.0, 31.2),     # Cairo
)


async def _fetch_anchor_fallback(
    cell_timeout: httpx.Timeout,
) -> list[dict[str, Any]]:
    """Sparse anchor-grid fallback when the main fan-out collapsed.

    Each anchor walks the host list starting at its deterministic primary,
    same as fetch_cell. Bypasses the per-cell cache so the fallback is fresh
    on every call — only fires on the degraded path, gated by the global
    merge TTL upstream.
    """
    client = get_client()

    async def hit_anchor(lat: float, lon: float) -> list[dict[str, Any]]:
        primary_idx = _primary_host_idx(lat, lon)
        async with _UPSTREAM_SEMAPHORE:
            for offset in range(len(_HEAD_HOSTS)):
                host = _HEAD_HOSTS[(primary_idx + offset) % len(_HEAD_HOSTS)]
                url = f"{host}/v2/point/{lat}/{lon}/250"
                try:
                    r = await client.get(url, timeout=cell_timeout)
                except (httpx.TimeoutException, httpx.TransportError):
                    continue
                if r.status_code in (429, 403):
                    continue
                if r.status_code != 200:
                    continue
                ac = _parse_ac(r)
                if ac is None:
                    # 200 + rate-limit text — walk to the next host.
                    continue
                return [dict(a, _seen_at=time.time(), _host=host) for a in ac]
            return []

    batches = await asyncio.gather(*(hit_anchor(la, lo) for la, lo in _ANCHOR_POINTS))
    out: list[dict[str, Any]] = []
    for b in batches:
        out.extend(b)
    return out


# Multi-source global feed. Each grid cell is cached individually for 5s in
# the shared TtlCache so a hot poll dispatches ~120 cache lookups (cheap)
# and only the cells whose TTL expired hit upstream.
#
# STICKY SNAPSHOT MODEL: The endpoint never blocks on the fan-out and never
# returns a partial mid-merge result. A background task refreshes the
# snapshot on a 1s cycle (sleep = max(0, 1.0 - elapsed) per iteration); the
# endpoint just returns the most recent COMPLETE snapshot. New snapshots that
# are empty (or that have dropped to <50% of the previous count — i.e. a
# rate-limit blip swept half the hosts) are REJECTED so the visible count
# stays stable instead of flickering between 48 and 3959 as cell TTLs roll
# over.
#
# ESCAPE HATCH: If the live snapshot is older than _SNAPSHOT_STALE_S, we
# UNCONDITIONALLY accept the next fan-out result — even if it's below the
# retention threshold. Otherwise a real drop in air traffic (e.g. global
# night/day cycle, holiday lull) would lock us out forever at a stale high
# water mark.
#
# Each cell has a deterministic primary host but a soft fallback: on
# non-200 / timeout we walk the host list in order from the primary.
_LATEST_SNAPSHOT: dict[str, Any] = {"type": "FeatureCollection", "features": []}
_LATEST_SNAPSHOT_AT: float = 0.0
_SNAPSHOT_LOCK = asyncio.Lock()
# Separate lock for the one-time bootstrap so concurrent first callers all
# wait on the SAME bootstrap fetch instead of racing past the
# _SNAPSHOT_STARTED flip with an empty snapshot.
_SNAPSHOT_BOOTSTRAP_LOCK = asyncio.Lock()
_SNAPSHOT_TASK: asyncio.Task[None] | None = None
_SNAPSHOT_STARTED = False
# Background task target cycle. Each iteration sleeps for max(0, cycle -
# elapsed_fanout). A fast fan-out (~0.3s) waits out the rest; a slow one loops
# immediately. 2s keeps the merged snapshot fresh for the 1s frontend pull
# without hammering upstreams: OpenSky is served from its daily cache and the
# keyless feeds self-pace internally (adsb_feed_interval_s), so a faster cycle
# re-merges already-cached slices rather than issuing new upstream fetches.
_SNAPSHOT_TARGET_CYCLE_S = 2.0
# A new snapshot is accepted only if it's non-empty AND retains at least this
# fraction of the previous snapshot's aircraft count. Absorbs the "host
# rate-limit blip" that used to drop the visible count from 3959 to 48.
_SNAPSHOT_MIN_RETAIN_FRACTION = 0.5
# After this many seconds without a successful update, we drop the retention
# guard and accept whatever the next fan-out returns. Prevents the sticky
# snapshot from permanently locking out a genuine air-traffic decline.
_SNAPSHOT_STALE_S = 30.0


async def _fetch_cell(
    primary_idx: int, lat: float, lon: float, cell_timeout: httpx.Timeout
) -> list[dict[str, Any]]:
    """Load one cell from cache; on miss, hit primary host and fall through
    the host list when primary returns non-2xx."""
    cache_key = f"adsb:cell:{lat:.2f}:{lon:.2f}"

    async def load_cell() -> list[dict[str, Any]]:
        client = get_client()
        async with _UPSTREAM_SEMAPHORE:
            for offset in range(len(_HEAD_HOSTS)):
                host = _HEAD_HOSTS[(primary_idx + offset) % len(_HEAD_HOSTS)]
                url = f"{host}/v2/point/{lat}/{lon}/250"
                try:
                    r = await client.get(url, timeout=cell_timeout)
                except (httpx.TimeoutException, httpx.TransportError):
                    continue
                # 429 / 403 — host is throttling us right now; walk to
                # the next host. No long-term breaker; the host may
                # recover before the next poll.
                if r.status_code in (429, 403):
                    continue
                if r.status_code != 200:
                    continue
                ac = _parse_ac(r)
                if ac is None:
                    # 200 but a non-JSON body — airplanes.live's text/plain
                    # rate-limit notice (or an HTML error page). Treat exactly
                    # like a 429 and walk to the next host instead of caching
                    # an empty cell.
                    continue
                # 200 OK + JSON — an empty `ac` list is a legitimate "no
                # aircraft here" answer. The shorter EMPTY TTL below shortens
                # the cache so an ocean-edge cell that briefly sees a flight
                # recovers in 3s instead of being pinned to empty for 5s.
                return [dict(a, _seen_at=time.time(), _host=host) for a in ac]
            # No host returned parseable JSON — all timed out, errored, or
            # rate-limited. Raise so get_or_fetch does NOT persist an empty
            # list: a transient all-throttled cell must be retried on the next
            # fan-out, not pinned to empty for _CELL_TTL_EMPTY seconds (which
            # is what blanked most of the map under burst load).
            raise _UpstreamUnavailable(f"cell {lat:.2f},{lon:.2f}: all hosts failed")

    try:
        result = await cache.get_or_fetch(cache_key, _CELL_TTL_FULL, load_cell)
    except Exception:
        return []
    # Shorten the cache expiry for empty results.
    if not result:
        cache.shorten(cache_key, _CELL_TTL_EMPTY)
    return result


async def _try_firehose() -> list[dict[str, Any]] | None:
    """Try each single-shot firehose endpoint; first one with a real payload
    wins. Returns ~10-15k aircraft or None when every host refuses.

    FAIL FAST. The previous version retried each host up to 3× with 1-9s
    sleeps on 429/timeout — up to ~30s burned per background cycle when all
    three hosts were down (the common case: airplanes.live has no global
    endpoint and 404s here, adsb.lol is unreachable from some egress IPs, and
    adsb.fi's snapshot 403s). That delay starved the per-cell grid fallback,
    which is the path that actually produces aircraft. A 429 or unreachable
    host now just advances to the next host immediately; retrying a wedged
    firehose is pointless when the grid is the real workhorse, and a working
    firehose answers on the first try anyway. `_parse_ac` rejects the
    HTTP-200 text/plain rate-limit body the same way it does in the grid."""
    client = get_client()
    timeout = httpx.Timeout(8.0, connect=2.0)
    for url in _FIREHOSE_URLS:
        try:
            async with _UPSTREAM_SEMAPHORE:
                r = await client.get(url, timeout=timeout)
        except (httpx.TimeoutException, httpx.TransportError):
            continue
        if r.status_code != 200:
            continue
        ac = _parse_ac(r)
        if not ac:
            continue
        now = time.time()
        return [dict(a, _seen_at=now, _host=url) for a in ac]
    return None


async def _try_opensky_global() -> dict[str, Any] | None:
    """OpenSky /states/all — the global breadth source (~13k aircraft).

    This is the single endpoint that actually returns the whole planet in one
    shot. The anonymous aggregator "firehoses" are all dead from typical egress
    IPs (airplanes.live has no global verb → 404, adsb.lol /v2/all-with-pos →
    451 legal block, adsb.fi /v2/snapshot → 403), so the per-cell grid alone
    caps out around 1.5-3k. OpenSky fills the gap.

    Works ANONYMOUSLY — `fetch_states` omits the Authorization header when no
    creds are configured, and OpenSky still serves anonymous /states/all
    (capped at 400 credits/day by source IP). With OAuth creds the daily budget
    is larger; either way `_opensky_cached` paces the call rate. Returns a ready
    GeoJSON FeatureCollection (same schema the adapter consumes) or None on
    failure / empty sky. 429 is surfaced (raised) so the caller can back off.

    Two budgets, tried in order:
    1. AUTHED (if creds configured) — larger daily credit pool, 5s resolution.
    2. ANONYMOUS (by source IP) — separate ~400 credits/day, 10s resolution.
    When the authed pool is spent (429) we retry anonymously, so a drained
    OAuth account doesn't blank the breadth layer while the IP still has
    credits (and vice versa)."""
    settings = get_settings()
    tm = _token_manager(settings)  # token only attached if creds present
    try:
        raw = await fetch_states(tm, None)
    except Exception:  # noqa: BLE001
        # The AUTHED attempt failed for ANY reason — budget spent (429),
        # credentials invalid/expired (401/403 at the OAuth token endpoint), a
        # token-manager error, or a transient network fault. Fall back to the
        # SEPARATE anonymous-by-IP budget so a dead OAuth account never blanks
        # the global breadth tier (the bug that left Russia/China at ~0 aircraft
        # while opensky_authed reported "true" — configured != working). Only
        # when we were already anonymous (no creds) do we surface the error so
        # the caller can back off.
        if not tm.enabled:
            raise
        raw = await fetch_states(_ANON_TM, None)  # anonymous /states/all
    fc = states_to_geojson(raw)
    if not fc.get("features"):
        return None
    # Stamp source + seen_at so the frontend can tint staleness and the
    # carry-forward merge can age these aircraft like any other.
    #
    # seen_at stays = the serve/pull time (so the carry-forward breadth merge,
    # which ages by `now - seen_at`, keeps this always-served tier fresh). But
    # we ALSO stamp seen_pos_s = how old each aircraft's POSITION actually is,
    # from OpenSky's per-state time_position. Without this, OpenSky positions
    # looked 0 s old (seen_pos absent → frontend assumes fresh), so when a given
    # icao24 flips from the live grid/feeds to the cached OpenSky snapshot, the
    # frontend's monotonic fix guard accepted the STALE OpenSky position and the
    # icon teleported backwards. With an honest seen_pos_s the stale fix loses
    # the freshness comparison and the icon holds its live track instead.
    now = time.time()
    for f in fc["features"]:
        props = f.setdefault("properties", {})
        props.setdefault("source", "opensky")
        props["seen_at"] = now
        tp = props.get("time_position")
        if isinstance(tp, (int, float)) and tp > 0:
            props["seen_pos_s"] = max(0.0, now - float(tp))
    return fc


# OpenSky pull pacing + daily gate. OpenSky's free budget is a daily credit pool
# (≈400 credits/day anonymous, keyed by source IP; a global /states/all costs 4
# credits) that resets at 0000 UTC. We pull /states/all at most ONCE per UTC day:
# once on boot, then once after each 0000 UTC reset. Two rules:
#
#  1. ON SUCCESS — gate OpenSky off until the next 0000 UTC. The cached FC is
#     served on every tick in between, so the snapshot COUNT stays high all day
#     on ~4 credits; only OpenSky-only (oceanic) position freshness degrades, and
#     the per-cell grid keeps dense regions live.
#  2. ON FAILURE — (429 budget-spent, network, parse) gate OpenSky off until the
#     next 0000 UTC too. The daily budget cannot recover before midnight UTC, so
#     retrying just burns connect timeouts and, when authed, leaks more credits.
#     The gate is in-memory, so it also clears on process restart → "pull once
#     per start, and again each 0000 UTC".
#
# The pull itself runs in a BACKGROUND task (`_opensky_refresh_once`); the hot
# read (`_opensky_cached`) only ever returns the cached FC, so OpenSky's 5-6MB
# /states/all download NEVER blocks the fan-out. _OPENSKY_INTERVAL_S only paces
# the first boot kick (and any re-kick before the gate is set).
_OPENSKY_INTERVAL_S = 15.0
# Always-anonymous token manager for the 429 fallback (separate IP budget).
_ANON_TM = OpenSkyTokenManager("", "")

# Wall-clock budget for the per-cell grid overlay inside a fan-out tick. Beyond
# this, the grid is abandoned for the tick (its completed cells are already
# cached) so a throttled airplanes.live can't stall the OpenSky-driven snapshot.
_GRID_BUDGET_S = 8.0
# Overall wall-clock cap on ONE repull fan-out. Every tier (OpenSky cache,
# keyless feeds, firehose, grid) runs concurrently and is awaited only within
# this deadline; a wedged upstream is dropped for the tick (its siblings'
# completed results still merge) so the snapshot refresher never blocks past one
# cycle. Sized above _GRID_BUDGET_S so the grid still gets its full slice when
# it's the only tier in play.
_FANOUT_BUDGET_S = 10.0
_OPENSKY_FC: dict[str, Any] = {"type": "FeatureCollection", "features": []}
_OPENSKY_AT: float = 0.0  # monotonic seconds of last pull START
# Wall-clock epoch (time.time) until which OpenSky stays gated off; 0.0 =
# open/healthy. Set to the next 0000 UTC after EVERY pull — success or failure —
# so we spend at most one pull's credits per UTC day.
_OPENSKY_DISABLED_UNTIL: float = 0.0
# In-flight background pull. Guards against kicking a second pull while one is
# running, and lets the hot read return without ever awaiting the download.
_OPENSKY_REFRESH_TASK: asyncio.Task[None] | None = None


def _next_utc_midnight_epoch() -> float:
    """Wall-clock epoch (UTC) of the next 0000 — OpenSky's daily budget reset."""
    now = dt.datetime.now(dt.UTC)
    nxt = dt.datetime.combine(
        now.date() + dt.timedelta(days=1), dt.time.min, tzinfo=dt.UTC
    )
    return nxt.timestamp()


async def _opensky_refresh_once() -> None:
    """Background OpenSky pull: refresh the cached FC, then gate OpenSky off
    until the next 0000 UTC reset — on success AND failure alike, so we pull at
    most ONCE per UTC day (once on boot, then once after each reset). Runs as its
    own task so the 5-6MB /states/all download never blocks the fan-out."""
    global _OPENSKY_FC, _OPENSKY_DISABLED_UNTIL
    try:
        fc = await _try_opensky_global()
    except Exception:
        _OPENSKY_DISABLED_UNTIL = _next_utc_midnight_epoch()
        return
    if fc and fc.get("features"):
        _OPENSKY_FC = fc
    # Pulled (success or empty) — don't pull again until the daily budget resets.
    _OPENSKY_DISABLED_UNTIL = _next_utc_midnight_epoch()


async def _opensky_cached() -> dict[str, Any] | None:
    """INSTANT breadth read. Serves the last good OpenSky FeatureCollection and,
    when a pull is due and the daily gate is open, kicks one off in the
    BACKGROUND. NEVER awaits the pull — the fan-out must not wait on OpenSky's
    5-6MB /states/all download.

    Stays `async` (the fan-out awaits it) but holds no network await; the
    awaited coroutine resolves in microseconds."""
    global _OPENSKY_AT, _OPENSKY_REFRESH_TASK
    gated = bool(_OPENSKY_DISABLED_UNTIL) and time.time() < _OPENSKY_DISABLED_UNTIL
    refreshing = _OPENSKY_REFRESH_TASK is not None and not _OPENSKY_REFRESH_TASK.done()
    age = time.monotonic() - _OPENSKY_AT if _OPENSKY_AT else float("inf")
    if not gated and not refreshing and age >= _OPENSKY_INTERVAL_S:
        # Stamp BEFORE create_task so the interval paces from pull-start and a
        # re-entrant call in the same tick can't double-kick.
        _OPENSKY_AT = time.monotonic()
        _OPENSKY_REFRESH_TASK = asyncio.create_task(_opensky_refresh_once())
    return _OPENSKY_FC if _OPENSKY_FC.get("features") else None


# Opportunistic firehose pacing. The single-shot firehose hosts are dead from
# most egress IPs, but a deploy host with clean connectivity may have a working
# one (adsb.lol unmetered, no daily budget — strictly better than OpenSky when
# reachable). Two drags this path must avoid:
#  - a WORKING firehose downloads 5-6MB; awaiting it on the hot path stalled the
#    fan-out for seconds.
#  - DEAD hosts cost connect timeouts; we skip retrying for _FIREHOSE_DEAD_SKIP_S
#    after a miss so they don't tax every tick.
# So the pull runs in a BACKGROUND task and the hot read serves the last good
# raw list instantly. Downstream `_merge_with_previous` (180s) ages out a stale
# cached firehose if the host later goes dark.
_FIREHOSE_DEAD_SKIP_S = 30.0
_FIREHOSE_NEXT_TRY: float = 0.0
_FIREHOSE_RAW: list[dict[str, Any]] = []  # last good raw aircraft list
_FIREHOSE_REFRESH_TASK: asyncio.Task[None] | None = None


async def _firehose_refresh_once() -> None:
    """Background firehose pull: refresh the cached raw list, or arm the
    dead-skip. Runs as its own task so a working firehose's 5-6MB download — and
    dead hosts' connect timeouts — never block the fan-out."""
    global _FIREHOSE_RAW, _FIREHOSE_NEXT_TRY
    fh = await _try_firehose()
    if fh:
        _FIREHOSE_RAW = fh
    else:
        _FIREHOSE_NEXT_TRY = time.monotonic() + _FIREHOSE_DEAD_SKIP_S


async def _firehose_throttled() -> list[dict[str, Any]] | None:
    """INSTANT firehose read. Serves the last good raw list and, when outside the
    dead-skip window with no pull in flight, kicks one off in the BACKGROUND.
    NEVER awaits the 5-6MB download. Stays `async` (the fan-out awaits it) but
    holds no network await."""
    global _FIREHOSE_REFRESH_TASK
    if time.monotonic() >= _FIREHOSE_NEXT_TRY:
        refreshing = (
            _FIREHOSE_REFRESH_TASK is not None and not _FIREHOSE_REFRESH_TASK.done()
        )
        if not refreshing:
            _FIREHOSE_REFRESH_TASK = asyncio.create_task(_firehose_refresh_once())
    return _FIREHOSE_RAW or None


# Keyless full-feed ADS-B. Open global readsb/tar1090 instances (theairtraffic,
# hpradar, the user's own ultrafeeder) serve their FULL aircraft set as
# aircraft.json — no key, no Cloudflare block — so they add the aircraft
# OpenSky's network misses (measured union ~14k vs ~12.7k OpenSky-only).
#
# RATE-LIMIT DISCIPLINE without staleness: each feed has its OWN cadence
# (_feed_interval) and we pull every feed that's due, concurrently. Full
# aircraft.json mirrors refresh ~1 s and tolerate a 5 s poll, so positions stay
# fresh (stale fixes are exactly what make a tracked aircraft jump). The
# rate-limited /v2 APIs use the slow cadence. Each feed's last good slice is
# retained + unioned (deduped by icao24); a slice older than _FEED_SLICE_MAX_AGE_S
# is dropped so a dead feed's aircraft don't linger.
_FEED_SLICES: dict[str, tuple[float, list[dict[str, Any]]]] = {}  # url -> (mono_ts, ac)
_FEED_NEXT_PULL: dict[str, float] = {}  # url -> next monotonic pull time
_FEED_SLICE_MAX_AGE_S = 180.0
# Some hosts (adsb.lol) answer 451 to a non-browser User-Agent — send a real one.
_FEED_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _feed_urls() -> list[str]:
    return [u.strip() for u in get_settings().adsb_feed_urls.split(",") if u.strip()]


def _feed_interval(url: str) -> float:
    s = get_settings()
    if "127.0.0.1" in url or "localhost" in url:
        return s.adsb_feed_fast_interval_s  # sidecar — no rate limit, keep fresh
    if "/v2/" in url or "/re-api" in url:
        return s.adsb_feed_slow_interval_s  # rate-limit-sensitive API
    if "theairtraffic.com" in url:
        # theairtraffic is the FRESHEST + BIGGEST real source measured from this
        # egress: ~10k aircraft, position age median ~1.6 s, and the ~5 MB body
        # now downloads in ~2 s (not the old 4-9 s). It's pulled in the BACKGROUND
        # (_pull_one_feed), so a ~2 s download never blocks the fan-out — there's
        # no reason to throttle it to 30 s. Pull it fast so the bulk of aircraft
        # carry genuinely fresh REAL positions (operator wants real data refreshed
        # consistently, NOT synthesized motion between stale fixes).
        return max(8.0, s.adsb_feed_interval_s)
    return s.adsb_feed_interval_s  # full aircraft.json mirror


def _feed_timeout(url: str) -> httpx.Timeout:
    # httpx connect/read budget. theairtraffic.com gets a tight connect so a
    # stalled handshake bails fast; the TOTAL wall-clock cap below is what bounds
    # its slow body.
    if "theairtraffic.com" in url:
        return httpx.Timeout(5.0, connect=3.0)
    return httpx.Timeout(12.0, connect=5.0)


def _feed_total_s(url: str) -> float:
    # Total wall-clock cap per feed, enforced with asyncio.wait_for. httpx's read
    # timeout is PER-CHUNK, so theairtraffic.com's 3.6MB aircraft.json — which
    # streams steadily over 4-9s — never trips a 5s read timeout and was pushing
    # the fan-out onto its 10s cap, holding the refresh well above the 5s target.
    # The body streams steadily over 4-9 s, so the cap must clear that or the
    # pull aborts every time and theairtraffic contributes 0 (measured: 8.2 k
    # aircraft never landing). 9 s clears the body and still fits the 10 s fanout
    # budget; the slow 30 s cadence (see _feed_interval) means this longer pull
    # runs rarely and is carried forward 180 s in between.
    if "theairtraffic.com" in url:
        return 9.0
    return 13.0


async def _fetch_one_feed(client: httpx.AsyncClient, url: str) -> list[dict[str, Any]]:
    try:
        r = await asyncio.wait_for(
            client.get(url, timeout=_feed_timeout(url), headers={"User-Agent": _FEED_UA}),
            timeout=_feed_total_s(url),
        )
    except (httpx.TimeoutException, httpx.TransportError, TimeoutError):
        return []
    if r.status_code != 200 or "json" not in r.headers.get("content-type", ""):
        return []
    try:
        j = r.json()
        # readsb tar1090 uses "aircraft"; ADSBx-v2 (adsb.lol) uses "ac". Both
        # carry the same readsb fields (hex/lat/lon/track/alt_baro/gs).
        return j.get("aircraft") or j.get("ac") or []
    except Exception:  # noqa: BLE001 — non-JSON / truncated body
        return []


# One INDEPENDENT background pull task per feed url. A shared gather over all due
# feeds was a freshness trap: a dead/slow feed (adsb.lol /v2 times out at ~20 s
# from a datacenter egress) held the whole gather, gating the fresh mirrors
# (theairtraffic ~2 s, hpradar ~0.4 s) to the slow feed's cadence — so served
# positions were ~14 s old even though theairtraffic's raw data is ~1.6 s. Per
# feed each runs on its own cadence; a slow feed only delays itself.
_FEED_TASKS: dict[str, asyncio.Task[None]] = {}


def _ac_seen_pos(a: dict[str, Any]) -> float:
    """readsb position age (s) for freshest-wins dedup; absent → treat as stale."""
    v = a.get("seen_pos")
    return v if isinstance(v, (int, float)) else 1e9


async def _pull_one_feed(url: str) -> None:
    """Pull ONE feed and update its slice. Independent task per feed so a slow or
    dead feed never delays the fresh ones. Re-arms its own next-pull on the way
    out (success or failure) so a dead feed retries on cadence, not every tick."""
    ac: list[dict[str, Any]] = []
    try:
        ac = await _fetch_one_feed(get_client(), url)
    finally:
        _FEED_NEXT_PULL[url] = time.monotonic() + _feed_interval(url)
    if ac:
        _FEED_SLICES[url] = (time.monotonic(), ac)


async def _readsb_feeds() -> list[dict[str, Any]]:
    """Union of recent keyless readsb feed slices — read from cache, INSTANT.

    Each DUE feed is refreshed by its OWN background task (kicked here, never
    awaited) so a slow mirror can't stall the fan-out or the other feeds. Returns
    the union deduped by icao24, FRESHEST upstream observation winning (so
    theairtraffic's ~1.6 s fixes beat hpradar's ~5 s where they overlap). Stale
    slices (> _FEED_SLICE_MAX_AGE_S) and de-configured feeds are dropped.
    """
    urls = _feed_urls()
    if not urls:
        return []
    now = time.monotonic()
    for u in urls:
        if now >= _FEED_NEXT_PULL.get(u, 0.0):
            t = _FEED_TASKS.get(u)
            if t is None or t.done():
                # Arm immediately so the due-check can't re-kick before the task
                # sets its own next-pull in the finally.
                _FEED_NEXT_PULL[u] = now + _feed_interval(u)
                _FEED_TASKS[u] = asyncio.create_task(_pull_one_feed(u))

    nowm = time.monotonic()
    cutoff = nowm - _FEED_SLICE_MAX_AGE_S
    # hexid -> (effective_age_s, aircraft). Effective age = how old this slice is
    # PLUS the upstream position age inside it. Comparing raw seen_pos across
    # slices was a freeze bug: a feed that succeeds once then goes dead (adsb.lol
    # /v2 times out every cycle from this egress) keeps a FROZEN slice whose
    # seen_pos stamps stay low, so it beat the live theairtraffic feed and the
    # whole snapshot stopped moving. Folding in the slice's own age makes a stale
    # slice lose, so the genuinely freshest REAL fix wins.
    best: dict[str, tuple[float, dict[str, Any]]] = {}
    for url in list(_FEED_SLICES):
        ts, ac = _FEED_SLICES[url]
        if ts < cutoff or url not in urls:
            _FEED_SLICES.pop(url, None)  # stale or de-configured feed
            continue
        slice_age = max(0.0, nowm - ts)
        for a in ac:
            hexid = (a.get("hex") or "").lower()
            if not hexid or a.get("lat") is None or a.get("lon") is None:
                continue
            eff = slice_age + _ac_seen_pos(a)
            prev = best.get(hexid)
            if prev is None or eff < prev[0]:
                best[hexid] = (eff, a)
    return [v[1] for v in best.values()]


def _merge_raw_into(by_id: dict[Any, dict[str, Any]], raw: list[dict[str, Any]]) -> None:
    """Convert raw aggregator aircraft dicts → features and union into by_id,
    overwriting any existing entry for the same id (caller orders sources so the
    freshest source is merged last)."""
    for f in _aircraft_geojson(raw).get("features") or []:
        fid = f.get("id")
        if fid is not None:
            by_id[fid] = f


async def _grid_fanout() -> list[dict[str, Any]]:
    """Per-cell airplanes.live /v2/point grid + low-water anchor fallback.
    Returns raw aircraft dicts (hex-keyed). Provides dense-region freshness on
    top of the OpenSky breadth layer."""
    # 6s read / 2s connect. A short connect timeout makes walking the host list
    # cheap when the deterministic primary is an unreachable host.
    cell_timeout = httpx.Timeout(6.0, connect=2.0)
    tasks = [
        _fetch_cell(_primary_host_idx(lat, lon), lat, lon, cell_timeout)
        for (lat, lon) in _GLOBAL_GRID
    ]
    cell_batches = await asyncio.gather(*tasks)
    out: list[dict[str, Any]] = []
    for batch in cell_batches:
        out.extend(batch)
    # Anchor fallback only when the grid produced essentially nothing.
    by_hex_count = len({(a.get("hex") or "").lower() for a in out if a.get("hex")})
    if by_hex_count < _FALLBACK_MIN_AIRCRAFT:
        out.extend(await _fetch_anchor_fallback(cell_timeout))
    return out


# Grid dead-skip. From a datacenter egress IP every airplanes.live/adsb.lol
# /v2/point cell is Cloudflare/451-blocked, so the grid yields ~nothing yet its
# 134 cell host-walks (2 s connect each) drag _do_global_fanout out to ~15-20 s
# — which froze the snapshot refresher and made tracked aircraft fly on
# dead-reckoning for 20 s then JUMP. When the grid comes back near-empty we skip
# it for a while so the fanout is driven by the fast keyless feeds (~1 s). A
# reachable host (residential / feeder) yields plenty and is never skipped.
_GRID_DEAD_SKIP_S = 30.0
_GRID_NEXT_TRY: float = 0.0
# Skip the (slow, server-blocked) grid entirely once the fast tiers already
# cover the sky. The keyless feeds alone supply ~11k, so the grid only runs as a
# fallback when feeds + OpenSky are below this — i.e. effectively never on a
# healthy deploy.
_GRID_SKIP_ABOVE = 3000


async def _grid_throttled() -> list[dict[str, Any]]:
    global _GRID_NEXT_TRY
    if time.monotonic() < _GRID_NEXT_TRY:
        return []
    grid = await _grid_fanout()
    yielded = len({(a.get("hex") or "").lower() for a in grid if a.get("hex")})
    if yielded < _FALLBACK_MIN_AIRCRAFT:
        _GRID_NEXT_TRY = time.monotonic() + _GRID_DEAD_SKIP_S
    return grid


async def _await_within(
    task: asyncio.Future[Any], deadline: float
) -> Any:
    """Await ``task`` but never past the fan-out ``deadline`` (monotonic secs).

    Returns the task result, or None if it's already failed or can't finish in
    time. A task that overruns is cancelled so it can't leak past the tick; its
    siblings that already completed still merge. Keeps one wedged upstream from
    stalling the snapshot refresher beyond _FANOUT_BUDGET_S."""
    if task.done():
        try:
            return task.result()
        except Exception:
            return None
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        task.cancel()
        return None
    try:
        return await asyncio.wait_for(task, timeout=remaining)
    except Exception:  # TimeoutError, CancelledError, or upstream error
        return None


async def _do_global_fanout() -> dict[str, Any]:
    """Return a merged GeoJSON FeatureCollection of all globally airborne
    aircraft, unioned across every reachable source so the count approaches the
    ~13k aircraft actually airborne worldwide:

      1. OpenSky /states/all (once/UTC-day, cached) — global breadth, ~13k.
      2. Opportunistic single-shot firehose — overlays real-time global data on
         deploy hosts where one is reachable.
      3. airplanes.live /v2/point grid — dense-region freshness (sub-2s in busy
         airspace), merged LAST so it wins conflicts with the slower tiers.

    Deduped by feature id (aircraft:<icao24>); later (fresher) sources overwrite
    earlier ones. This is the expensive path — only the background snapshot
    refresher should call it.

    The three tiers run CONCURRENTLY and the grid is time-boxed: a throttled
    airplanes.live (slow per-cell host-walks) must NOT stall the snapshot, since
    OpenSky alone already supplies the ~13k breadth. Grid cells that don't
    finish inside the budget are cancelled, but any that completed are cached,
    so the next tick — reading those warm cells — finishes the grid fast."""
    by_id: dict[Any, dict[str, Any]] = {}

    osky_task = asyncio.ensure_future(_opensky_cached())
    feeds_task = asyncio.ensure_future(_readsb_feeds())
    fh_task = asyncio.ensure_future(_firehose_throttled())
    deadline = time.monotonic() + _FANOUT_BUDGET_S

    # 1. Breadth — OpenSky global (~13k). Served from cache between daily pulls,
    #    so it contributes its full count on every tick.
    osky = await _await_within(osky_task, deadline)
    if osky:
        for f in osky.get("features") or []:
            fid = f.get("id")
            if fid is not None:
                by_id[fid] = f

    # 2. Keyless full-feed readsb instances (theairtraffic, hpradar, the user's
    #    ultrafeeder) — full global aircraft.json at ~1s. Adds the aircraft
    #    OpenSky's feeders miss (+~1.3k measured) and is fresher, so it merges
    #    AFTER OpenSky.
    feeds = await _await_within(feeds_task, deadline)
    if feeds:
        _merge_raw_into(by_id, feeds)

    # 3. Opportunistic firehose (deploy hosts with a reachable global verb).
    firehose = await _await_within(fh_task, deadline)
    if firehose:
        _merge_raw_into(by_id, firehose)

    # 4. Per-cell grid — ONLY as a FALLBACK when the fast tiers came up thin. The
    #    keyless feeds now supply ~11k at ~0.1s; on a datacenter IP every
    #    /v2/point cell is Cloudflare/451-blocked and the 134 cell host-walks
    #    dragged the fan-out to ~40s — which froze the snapshot refresher (~20s
    #    cycles) and made tracked aircraft fly on dead-reckoning then JUMP. So we
    #    skip the grid entirely once feeds + OpenSky cover the sky; it runs (time
    #    -boxed) only when everything else is down. A reachable host yields plenty
    #    and is never blocked, so a residential/feeder deploy still gets it.
    if len(by_id) < _GRID_SKIP_ABOVE:
        grid_budget = min(_GRID_BUDGET_S, deadline - time.monotonic())
        if grid_budget > 0:
            try:
                grid = await asyncio.wait_for(_grid_throttled(), timeout=grid_budget)
            except TimeoutError:
                grid = []
            if grid:
                _merge_raw_into(by_id, grid)

    return {"type": "FeatureCollection", "features": list(by_id.values())}


def _merge_with_previous(
    new_fc: dict[str, Any], prev_fc: dict[str, Any], max_age_s: float = 180.0
) -> dict[str, Any]:
    """Union the fresh fan-out with recently-seen aircraft from the previous
    snapshot.

    The anonymous firehose hosts have DISJOINT coverage and the primary
    alternates as they throttle us — without this merge, half the aircraft
    blink out on every host flip and reappear on the next (the exact
    "icons disappear and reappear" regression CLAUDE.md forbids). An
    aircraft missing from the current fan-out is carried forward until its
    last fix is older than max_age_s; the frontend tints stale contacts via
    seen_pos/seen_at, so carried-forward aircraft degrade visibly instead
    of vanishing. 180 s covers the worst observed throttled fan-out cycle
    (~30 s) plus several missed OpenSky pulls (15 s pacing + backoff) —
    shorter windows made oceanic OpenSky-only contacts flicker."""
    now = time.time()
    by_id: dict[Any, dict[str, Any]] = {}
    for f in new_fc.get("features") or []:
        fid = f.get("id")
        if fid is not None:
            by_id[fid] = f
    for f in prev_fc.get("features") or []:
        fid = f.get("id")
        if fid is None or fid in by_id:
            continue
        seen = (f.get("properties") or {}).get("seen_at")
        if isinstance(seen, (int, float)) and now - seen <= max_age_s:
            by_id[fid] = f
    return {"type": "FeatureCollection", "features": list(by_id.values())}


async def _refresh_snapshot_forever() -> None:
    """Background task: refresh the sticky snapshot on a 5s target cycle.

    Each iteration measures fan-out time and sleeps for the remainder of the
    cycle (sleep = max(0, _SNAPSHOT_TARGET_CYCLE_S - elapsed)). A fast
    fan-out doesn't burn the loop; a slow one loops immediately so we never
    fall further behind than upstream latency forces.

    Snapshots that are empty OR drop below 50% of the previous count are
    REJECTED — UNLESS the live snapshot is already older than
    _SNAPSHOT_STALE_S, in which case we accept unconditionally so a genuine
    drop in air traffic can never permanently lock us out."""
    global _LATEST_SNAPSHOT, _LATEST_SNAPSHOT_AT
    while True:
        t0 = time.monotonic()
        try:
            fc = await _do_global_fanout()
            async with _SNAPSHOT_LOCK:
                # Carry forward recently-seen aircraft so host-coverage flips
                # between fan-outs never blank half the map.
                fc = _merge_with_previous(fc, _LATEST_SNAPSHOT)
                new_count = len(fc.get("features") or [])
                prev_count = len(_LATEST_SNAPSHOT.get("features") or [])
                age = (
                    time.monotonic() - _LATEST_SNAPSHOT_AT
                    if _LATEST_SNAPSHOT_AT
                    else float("inf")
                )
                stale = age >= _SNAPSHOT_STALE_S
                accept = new_count > 0 and (
                    stale
                    or prev_count == 0
                    or new_count >= int(prev_count * _SNAPSHOT_MIN_RETAIN_FRACTION)
                )
                if accept:
                    _LATEST_SNAPSHOT = fc
                    _LATEST_SNAPSHOT_AT = time.monotonic()
            # Mirror accepted aircraft fixes into the history store for 3D
            # replay. Outside the snapshot lock; ingest_aircraft only buffers
            # in memory (rate-limited, no I/O) so it can't stall the tick.
            if accept:
                try:
                    from app import history  # noqa: PLC0415

                    history.ingest_aircraft(fc.get("features") or [])
                except Exception:  # noqa: BLE001
                    pass
        except Exception:
            # Never let the background loop die — a transient httpx /
            # cancellation / asyncio exception just rolls into the next tick.
            pass
        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0.0, _SNAPSHOT_TARGET_CYCLE_S - elapsed))


def viewport_filter(
    fc: dict[str, Any],
    lamin: float | None,
    lomin: float | None,
    lamax: float | None,
    lomax: float | None,
    limit: int | None,
) -> dict[str, Any]:
    """Filter a Point FeatureCollection to a bbox + decimate to ``limit``.

    Serves only the on-screen subset so the frontend never instantiates the
    full ~12k/18k entity set (the per-poll upsert + re-cluster of that many
    entities is the web UI's real bottleneck — render itself is cheap). When no
    bbox/limit is given the input is returned unchanged. Tolerates the
    antimeridian (lomin > lomax). Decimation is a uniform stride so the thinned
    set stays spatially even rather than clipping a corner.
    """
    feats = fc.get("features") or []
    if None not in (lamin, lomin, lamax, lomax):
        wrap = lomin > lomax  # type: ignore[operator]
        kept: list[dict[str, Any]] = []
        for f in feats:
            try:
                coords = f["geometry"]["coordinates"]
                lon, lat = float(coords[0]), float(coords[1])
            except (KeyError, TypeError, ValueError, IndexError):
                continue
            if lat < lamin or lat > lamax:  # type: ignore[operator]
                continue
            in_lon = (lon >= lomin or lon <= lomax) if wrap else (lomin <= lon <= lomax)
            if not in_lon:
                continue
            kept.append(f)
        feats = kept
    if limit and len(feats) > limit:
        # STABLE decimation — keep a deterministic subset keyed by feature id,
        # NOT a positional stride. The snapshot's feature order and exact count
        # shift on every refresh (multi-source union + 180s carry-forward merge),
        # so a positional `feats[int(i*stride)]` resampled a DIFFERENT subset
        # every poll. The frontend upserts entities by id and interpolates motion
        # in place, so that churned ~half the icons each second (measured: 112%
        # id churn between two 1s polls) — destroying the motion model so
        # aircraft never survived long enough to glide and sat frozen at world
        # view. Hashing the id keeps the SAME aircraft visible poll-to-poll; only
        # genuine entry/exit (or a hash-boundary flip) changes the set, so icons
        # persist and interpolate smoothly. md5 (not the salted builtin hash) so
        # the kept set is identical across worker processes and restarts.
        # Two-key sort: (1) live tier first, (2) stable id hash within a tier.
        #  - Tier biases the world-view cap toward aircraft that actually move:
        #    OpenSky is pulled once/UTC-day and served cached, so its fixes are
        #    frozen until tomorrow; the keyless feeds are sub-10s fresh. When we
        #    can only show `limit` of ~9k, fill with movers so the globe looks
        #    live instead of dotted with stale icons. Degrades gracefully — if
        #    feeds are unreachable (datacenter egress) everything is OpenSky, all
        #    tiers tie, and it falls back to pure stable-hash decimation.
        #  - The hash (md5 of the id, not the salted builtin hash) is what's
        #    STABLE across polls: it keeps the SAME subset visible each refresh
        #    so the frontend's in-place motion interpolation survives. `source`
        #    is per-aircraft constant, so the tier never oscillates either. Do
        #    NOT key on seen_pos_s / any age field — those tick every snapshot
        #    and would reintroduce the churn this whole block exists to kill.
        def _keep_rank(f: dict[str, Any]) -> tuple[int, bytes]:
            src = (f.get("properties") or {}).get("source")
            tier = 1 if src == "opensky" else 0
            return tier, hashlib.md5(str(f.get("id")).encode()).digest()  # noqa: S324 — not security

        feats = sorted(feats, key=_keep_rank)[:limit]
    return {"type": "FeatureCollection", "features": feats}


async def global_snapshot() -> dict[str, Any]:
    """The full aircraft snapshot (no viewport filter), bootstrapping the
    background refresher on first call.

    Plain helper so INTERNAL callers (e.g. the jamming layer) can read the
    snapshot directly. Calling the route handler ``adsb_global()`` in-process
    passed its unresolved ``Query(...)`` defaults straight through to
    viewport_filter, which then compared Query objects ('>' not supported
    between instances of 'Query') and 500'd — that broke the GPS-jamming layer.
    """
    global _SNAPSHOT_STARTED, _SNAPSHOT_TASK, _LATEST_SNAPSHOT, _LATEST_SNAPSHOT_AT
    if not _SNAPSHOT_STARTED:
        # Bootstrap under a lock so every concurrent first caller waits on
        # the SAME initial fan-out — otherwise the second request races
        # past `_SNAPSHOT_STARTED = True` and returns the empty seed
        # snapshot before the bootstrap finishes.
        async with _SNAPSHOT_BOOTSTRAP_LOCK:
            if not _SNAPSHOT_STARTED:
                try:
                    first = await _do_global_fanout()
                    if first.get("features"):
                        async with _SNAPSHOT_LOCK:
                            _LATEST_SNAPSHOT = first
                            _LATEST_SNAPSHOT_AT = time.monotonic()
                except Exception:
                    pass
                _SNAPSHOT_TASK = asyncio.create_task(_refresh_snapshot_forever())
                _SNAPSHOT_STARTED = True
    async with _SNAPSHOT_LOCK:
        # Shallow copy so callers can't mutate the live snapshot dict.
        return dict(_LATEST_SNAPSHOT)


def snapshot_age_s() -> float | None:
    """Seconds since the global snapshot last refreshed (None if never). For the
    public /api/status page — lets callers see feed freshness, not just a count."""
    return round(time.monotonic() - _LATEST_SNAPSHOT_AT, 1) if _LATEST_SNAPSHOT_AT else None


@router.get("/api/adsb/global")
async def adsb_global(
    lamin: float | None = Query(None, ge=-90, le=90),
    lomin: float | None = Query(None, ge=-180, le=180),
    lamax: float | None = Query(None, ge=-90, le=90),
    lomax: float | None = Query(None, ge=-180, le=180),
    limit: int | None = Query(None, ge=1, le=20000),
) -> dict[str, Any]:
    """Return the latest aircraft snapshot, optionally scoped to a viewport.

    With ``lamin/lomin/lamax/lomax`` (+ optional ``limit``) the snapshot is
    filtered to that bbox and decimated — the frontend sends its camera view so
    only on-screen aircraft are instantiated. With no params the FULL snapshot
    is returned (back-compat for the MCP/intel tools).

    First call kicks off the background refresher and does one synchronous
    bootstrap fetch so the response isn't empty. Subsequent calls return
    immediately with whatever the background task last accepted."""
    snap = await global_snapshot()
    if lamin is None and lomin is None and lamax is None and lomax is None and limit is None:
        return snap
    return viewport_filter(snap, lamin, lomin, lamax, lomax, limit)


async def start_snapshot() -> None:
    """Warm the sticky snapshot at app boot so the first browser poll returns
    instantly instead of paying for a cold synchronous fan-out.

    Non-blocking on purpose: it only creates the background refresher (which
    fills the snapshot on its first cycle), it does NOT await a synchronous
    bootstrap fan-out — that would stall app startup for the several seconds
    OpenSky + the grid take. By the time a browser opens and polls, the
    refresher has already populated the snapshot. Idempotent: a no-op once the
    refresher is running, and it sets _SNAPSHOT_STARTED so the lazy bootstrap
    in adsb_global is skipped (no double fan-out)."""
    global _SNAPSHOT_STARTED, _SNAPSHOT_TASK
    if _SNAPSHOT_STARTED:
        return
    async with _SNAPSHOT_BOOTSTRAP_LOCK:
        if _SNAPSHOT_STARTED:
            return
        _SNAPSHOT_TASK = asyncio.create_task(_refresh_snapshot_forever())
        _SNAPSHOT_STARTED = True


async def stop_snapshot() -> None:
    """Cancel the background snapshot refresher (and any in-flight feed pulls)
    and reset the bootstrap flag.

    Wired into the app lifespan so the tasks never outlive their event loop
    (clean shutdown, no "Task was destroyed but it is pending" on reload,
    test isolation). Safe to call when nothing is running."""
    global _SNAPSHOT_TASK, _SNAPSHOT_STARTED
    global _OPENSKY_REFRESH_TASK, _FIREHOSE_REFRESH_TASK
    tasks = [
        _SNAPSHOT_TASK,
        _OPENSKY_REFRESH_TASK,
        _FIREHOSE_REFRESH_TASK,
        *_FEED_TASKS.values(),
    ]
    _FEED_TASKS.clear()
    _SNAPSHOT_TASK = None
    _OPENSKY_REFRESH_TASK = None
    _FIREHOSE_REFRESH_TASK = None
    _SNAPSHOT_STARTED = False
    for task in tasks:
        if task is None or task.done():
            continue
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass


@router.get("/api/adsb/snapshot_age")
async def adsb_snapshot_age() -> dict[str, Any]:
    """Debug: age of the sticky snapshot in seconds.

    `age_s` is wall-clock-monotonic seconds since the last accepted snapshot;
    `features` is the current snapshot aircraft count. Used to verify the
    background refresher is keeping the snapshot under the ≤10s end-to-end
    freshness budget (5s target cycle, fan-out capped at 10s)."""
    async with _SNAPSHOT_LOCK:
        age = (
            time.monotonic() - _LATEST_SNAPSHOT_AT
            if _LATEST_SNAPSHOT_AT
            else None
        )
        count = len(_LATEST_SNAPSHOT.get("features") or [])
    return {
        "age_s": age,
        "features": count,
        "target_cycle_s": _SNAPSHOT_TARGET_CYCLE_S,
        "stale_threshold_s": _SNAPSHOT_STALE_S,
    }


# Kept for backward compatibility — alias of /api/adsb/global (full snapshot).
@router.get("/api/adsb/lol/global")
async def adsb_lol_global() -> dict[str, Any]:
    return await global_snapshot()


@router.get("/api/adsb/fi/global")
async def adsb_fi_global() -> dict[str, Any]:
    """Global snapshot from adsb.fi /v2/snapshot (single-host fallback)."""

    async def load() -> dict[str, Any]:
        r = await get_client().get("https://opendata.adsb.fi/api/v2/snapshot")
        if r.status_code != 200:
            raise HTTPException(502, f"adsb.fi /snapshot {r.status_code}")
        j = r.json()
        return _aircraft_geojson(j.get("aircraft") or j.get("ac") or [])

    return await cache.get_or_fetch("adsbfi:snapshot", 30.0, load)


# ── airplanes.live ────────────────────────────────────────────────────────
@router.get("/api/adsb/live/mil")
async def adsb_live_mil() -> dict[str, Any]:
    # Walk _HEAD_HOSTS, first 200-with-JSON wins. A single host's /v2/mil is
    # flaky (rate-limit answered with 200+text/plain, or 403/404 from some
    # egress IPs) — a hardcoded single host turned every blip into a 502. Match
    # the /api/adsb/live/emergencies fan-out: try each host, guard the JSON
    # parse against text/plain limiter bodies, and degrade to an empty
    # collection rather than failing the layer.
    async def load() -> dict[str, Any]:
        for host in _HEAD_HOSTS:
            url = f"{host}/v2/mil"
            try:
                r = await get_client().get(url)
            except (httpx.TimeoutException, httpx.TransportError):
                continue
            if r.status_code != 200:
                continue
            try:
                ac = r.json().get("ac") or []
            except ValueError:
                continue
            return _aircraft_geojson(ac)
        return {"type": "FeatureCollection", "features": []}

    return await cache.get_or_fetch("airplaneslive:mil", 30.0, load)


@router.get("/api/adsb/live/squawk/{code}")
async def adsb_live_squawk(code: str) -> dict[str, Any]:
    if not code.isdigit() or len(code) != 4:
        raise HTTPException(400, "squawk must be 4 digits")

    # Same fan-out as /mil and /emergencies: a single host's /v2/squawk is
    # flaky (200+text/plain limiter body, or 403/404 per egress IP). Walk hosts,
    # guard the JSON parse, degrade to an empty collection rather than 502.
    async def load() -> dict[str, Any]:
        for host in _HEAD_HOSTS:
            url = f"{host}/v2/squawk/{code}"
            try:
                r = await get_client().get(url)
            except (httpx.TimeoutException, httpx.TransportError):
                continue
            if r.status_code != 200:
                continue
            try:
                ac = r.json().get("ac") or []
            except ValueError:
                continue
            return _aircraft_geojson(ac)
        return {"type": "FeatureCollection", "features": []}

    return await cache.get_or_fetch(f"airplaneslive:sq:{code}", 15.0, load)


# Convenience: union of emergency squawks. Uses the same multi-host fan-out
# pattern as /api/adsb/global so a single rate-limited host can't blank the
# emergency layer — hijack/radio-failure/general-mayday is the layer we MOST
# need to stay live when one upstream is throttling us.
@router.get("/api/adsb/live/emergencies")
async def adsb_live_emergencies() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        feats: list[dict[str, Any]] = []
        seen_hex: set[str] = set()
        for code in ("7500", "7600", "7700"):
            # Walk hosts in order; first 200 OK wins for THIS squawk code. The
            # subsequent codes start the walk from the top again — a host that
            # blocked 7500 may still serve 7600/7700.
            for host in _HEAD_HOSTS:
                url = f"{host}/v2/squawk/{code}"
                try:
                    r = await get_client().get(url)
                except (httpx.TimeoutException, httpx.TransportError):
                    continue
                if r.status_code != 200:
                    continue
                try:
                    ac = r.json().get("ac") or []
                except ValueError:
                    continue
                # Dedupe across squawk codes — an aircraft squawking 7700 is
                # also surfaced by some hosts when it transitions, so the same
                # hex can appear under two codes simultaneously.
                fc = _aircraft_geojson(ac)
                for f in fc["features"]:
                    hexid = str((f.get("properties") or {}).get("icao24") or "").lower()
                    if hexid and hexid in seen_hex:
                        continue
                    if hexid:
                        seen_hex.add(hexid)
                    feats.append(f)
                break  # this code is satisfied — don't poll more hosts for it
        return {"type": "FeatureCollection", "features": feats}

    return await cache.get_or_fetch("airplaneslive:emerg", 15.0, load)


# ── per-aircraft full flight trail (tar1090 trace_full) ──────────────────────
# The selection polyline was built only from positions accumulated client-side
# since the page opened — short, slow to fill. adsb.lol serves the FULL recent
# trace (tar1090 trace_full: up to ~24 h, thousands of points) keyless, so we
# seed the trail from it on selection. airplanes.live's trace 403s a datacenter
# IP; OpenSky's /tracks path is the fallback.


def _parse_tar1090_trace(j: dict[str, Any]) -> list[dict[str, Any]]:
    base = j.get("timestamp")
    try:
        base = float(base)
    except (TypeError, ValueError):
        return []
    out: list[dict[str, Any]] = []
    for e in j.get("trace") or []:
        # entry: [dt_s, lat, lon, alt(ft|"ground"), gs, track, ...]
        if not isinstance(e, list) or len(e) < 4:
            continue
        try:
            t = base + float(e[0])
            lat = float(e[1])
            lon = float(e[2])
        except (TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        alt = e[3]
        alt_m = round(float(alt) * 0.3048) if isinstance(alt, (int, float)) else 0
        out.append({"t": int(t * 1000), "lon": round(lon, 5), "lat": round(lat, 5), "alt_m": alt_m})
    return out


async def _fetch_opensky_track(h: str) -> list[dict[str, Any]]:
    try:
        r = await get_client().get(
            f"https://opensky-network.org/api/tracks/all?icao24={h}&time=0",
            headers={"User-Agent": _FEED_UA},
            follow_redirects=True,
        )
    except Exception:  # noqa: BLE001
        return []
    if r.status_code != 200:
        return []
    try:
        j = r.json()
    except ValueError:
        return []
    out: list[dict[str, Any]] = []
    for wp in j.get("path") or []:
        # waypoint: [time, lat, lon, baro_alt, track, on_ground]
        if not isinstance(wp, list) or len(wp) < 4:
            continue
        try:
            t = float(wp[0])
            lat = float(wp[1])
            lon = float(wp[2])
        except (TypeError, ValueError):
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        alt_m = round(float(wp[3])) if isinstance(wp[3], (int, float)) else 0
        out.append({"t": int(t * 1000), "lon": round(lon, 5), "lat": round(lat, 5), "alt_m": alt_m})
    return out


@router.get("/api/adsb/trace/{icao}")
async def adsb_trace(icao: str) -> dict[str, Any]:
    """Full recent flight trail for one aircraft, ordered oldest→newest.

    Pulls the keyless tar1090 ``trace_full`` from adsb.lol (up to ~24 h of the
    flight, thousands of points); falls back to the OpenSky track path. Returns
    ``{icao, source, count, points: [{t (epoch ms), lon, lat, alt_m}]}`` —
    downsampled to <=800 points so the polyline + payload stay light.
    """
    h = icao.lower().strip()
    if len(h) != 6 or any(c not in "0123456789abcdef" for c in h):
        raise HTTPException(400, "icao must be 6 hex chars")

    async def load() -> dict[str, Any]:
        url = f"https://globe.adsb.lol/data/traces/{h[-2:]}/trace_full_{h}.json"
        pts: list[dict[str, Any]] = []
        source = "none"
        try:
            r = await get_client().get(
                url, headers={"User-Agent": _FEED_UA}, follow_redirects=True
            )
            if r.status_code == 200 and "json" in r.headers.get("content-type", ""):
                pts = _parse_tar1090_trace(r.json())
                if pts:
                    source = "adsb.lol"
        except Exception:  # noqa: BLE001
            pts = []
        if not pts:
            pts = await _fetch_opensky_track(h)
            if pts:
                source = "opensky"
        # Downsample evenly so a 2 600-point trace doesn't bloat the polyline.
        if len(pts) > 800:
            step = len(pts) / 800.0
            pts = [pts[int(i * step)] for i in range(800)]
        return {"icao": h, "source": source, "count": len(pts), "points": pts}

    return await cache.get_or_fetch(f"adsbtrace:{h}", 45.0, load)
