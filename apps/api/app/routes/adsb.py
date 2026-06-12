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
- Per-cell TTL is aggressive (10s full / 5s empty) so the frontend perceives
  sub-2-second updates. The sticky snapshot dict IS the merge cache — the
  hot route returns it in microseconds. The background refresher loop
  targets a 1s cycle (sleep = max(0, 1.0 - elapsed)) so a fast fan-out
  doesn't burn CPU and a slow fan-out doesn't add extra idle latency.
- Frontend polls every 1s + snapshot ≤1s old = end-to-end ≤2s.
- ~120 hand-picked dense cells over land (was 250+). Smaller grid × tighter
  TTL beats larger grid × longer TTL when egress is throttled.
- OpenSky (authed, env creds) sits between the anonymous firehoses and the
  per-cell grid in the degradation ladder.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from math import cos, radians
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.ingest.opensky import fetch_states, states_to_geojson
from app.routes.aviation import _token_manager
from app.upstream import cache, get_client

router = APIRouter(tags=["adsb"])

# Cap concurrent upstream ADS-B fetches across the global fan-out. Cell-level
# caches still allow parallel cache hits; this semaphore only gates the actual
# upstream call inside `load_cell` so cold-start (all-miss) bursts cannot
# stampede the shared httpx client or trip per-host rate limits.
_UPSTREAM_SEMAPHORE = asyncio.Semaphore(64)

# Per-cell cache TTLs. Higher (10s full / 5s empty) to prioritize coverage
# over freshness. Sticky snapshot (1s cycle) caps end-to-end age regardless.
# Longer TTL reduces upstream rate-limit pressure → better firehose hit rate
# and more aircraft discovery globally.
_CELL_TTL_FULL = 10.0
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
    timeout: httpx.Timeout,
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
                    r = await client.get(url, timeout=timeout)
                except (httpx.TimeoutException, httpx.TransportError):
                    continue
                if r.status_code in (429, 403):
                    continue
                if r.status_code != 200:
                    continue
                try:
                    ac = list(r.json().get("ac") or [])
                except ValueError:
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
# Background task target cycle. Each iteration sleeps for max(0, 1.0 -
# elapsed_fanout). A fast fan-out (~0.3s) waits 0.7s; a slow one (>1s) loops
# immediately. Combined with the frontend's 1s pull this gives ≤2s
# end-to-end refresh.
_SNAPSHOT_TARGET_CYCLE_S = 1.0
# A new snapshot is accepted only if it's non-empty AND retains at least this
# fraction of the previous snapshot's aircraft count. Absorbs the "host
# rate-limit blip" that used to drop the visible count from 3959 to 48.
_SNAPSHOT_MIN_RETAIN_FRACTION = 0.5
# After this many seconds without a successful update, we drop the retention
# guard and accept whatever the next fan-out returns. Prevents the sticky
# snapshot from permanently locking out a genuine air-traffic decline.
_SNAPSHOT_STALE_S = 30.0


async def _fetch_cell(primary_idx: int, lat: float, lon: float, cell_timeout: httpx.Timeout) -> list[dict[str, Any]]:
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
                try:
                    ac = list(r.json().get("ac") or [])
                except ValueError:
                    continue
                # 200 OK — empty list is a legitimate "no aircraft here"
                # answer. The shorter EMPTY TTL below shortens the cache
                # so an ocean-edge cell that briefly sees a flight
                # recovers in 3s instead of being pinned to empty for 5s.
                return [dict(a, _seen_at=time.time(), _host=host) for a in ac]
            return []

    try:
        result = await cache.get_or_fetch(cache_key, _CELL_TTL_FULL, load_cell)
    except Exception:
        return []
    # Shorten the cache expiry for empty results.
    if not result:
        entry = cache._data.get(cache_key)
        if entry is not None:
            short_expiry = time.monotonic() + _CELL_TTL_EMPTY
            if entry[0] > short_expiry:
                cache._data[cache_key] = (short_expiry, entry[1])
    return result


async def _try_firehose() -> list[dict[str, Any]] | None:
    """Try each firehose endpoint with exponential backoff on 429.
    Retry rate-limited hosts after wait. Returns 10-15k aircraft or None."""
    client = get_client()
    timeout = httpx.Timeout(15.0, connect=5.0)
    for url in _FIREHOSE_URLS:
        # Exponential backoff for 429: try up to 3 times with delays
        for attempt in range(3):
            try:
                async with _UPSTREAM_SEMAPHORE:
                    r = await client.get(url, timeout=timeout)
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)  # 1s, 2s backoff
                continue

            # 429 rate-limit: retry with backoff
            if r.status_code == 429:
                if attempt < 2:
                    await asyncio.sleep(2 + (2 ** attempt))  # 3s, 5s, 9s
                continue

            # 403/451/5xx: give up on this host, try next
            if r.status_code != 200:
                break

            try:
                j = r.json()
            except ValueError:
                break

            ac = j.get("ac") or j.get("aircraft") or []
            if not ac:
                break

            now = time.time()
            return [dict(a, _seen_at=now, _host=url) for a in ac]

    return None


async def _try_opensky_global() -> dict[str, Any] | None:
    """Authed OpenSky /states/all — the last firehose resort.

    Only fires when every anonymous aggregator refused us. OpenSky's authed
    quota is a finite daily credit budget, so it's the safety net, not the
    primary. Returns a ready GeoJSON FeatureCollection (states_to_geojson
    emits the same aircraft schema the frontend adapter consumes) or None
    when creds are missing / the call failed / the sky came back empty."""
    settings = get_settings()
    if not (settings.opensky_client_id and settings.opensky_client_secret):
        return None
    try:
        tm = _token_manager(settings)
        raw = await fetch_states(tm, None)
        fc = states_to_geojson(raw)
    except Exception:
        return None
    return fc if fc.get("features") else None


async def _do_global_fanout() -> dict[str, Any]:
    """Return a merged GeoJSON FeatureCollection of all globally airborne
    aircraft. Tries the firehose hosts first (single-shot ~17k aircraft);
    falls back to the per-cell /v2/point grid + anchor fallback when every
    firehose is rate-limited / blocked. This is the expensive path —
    callers should not invoke it from a request handler. The background
    snapshot refresher is the sole steady-state caller."""
    # Firehose path. When upstream is healthy this is the only network call
    # we make this tick — and it returns ~5× more aircraft than the grid.
    firehose = await _try_firehose()
    if firehose:
        by_hex: dict[str, dict[str, Any]] = {}
        for a in firehose:
            hexid = (a.get("hex") or "").lower()
            if not hexid:
                continue
            cur = by_hex.get(hexid)
            if cur is None:
                by_hex[hexid] = a
            elif (a.get("seen_pos") or 1e9) < (cur.get("seen_pos") or 1e9):
                by_hex[hexid] = a
        return _aircraft_geojson(list(by_hex.values()))

    # Authed OpenSky firehose — fires only when all anonymous hosts refused.
    opensky_fc = await _try_opensky_global()
    if opensky_fc:
        return opensky_fc

    # Grid fallback. Only fires when every firehose host refused us.
    # 8s read / 4s connect. Lower than the old 15s because we want fast
    # fall-through on a wedged TCP connection.
    cell_timeout = httpx.Timeout(8.0, connect=4.0)

    tasks = [
        _fetch_cell(_primary_host_idx(lat, lon), lat, lon, cell_timeout)
        for (lat, lon) in _GLOBAL_GRID
    ]
    cell_batches = await asyncio.gather(*tasks)

    # Dedupe by ICAO24 hex across all cells; freshest wins.
    by_hex: dict[str, dict[str, Any]] = {}
    for batch in cell_batches:
        for a in batch:
            hexid = (a.get("hex") or "").lower()
            if not hexid:
                continue
            cur = by_hex.get(hexid)
            if cur is None:
                by_hex[hexid] = a
            elif (a.get("seen_pos") or 1e9) < (cur.get("seen_pos") or 1e9):
                by_hex[hexid] = a

    # Second-tier fallback. When the per-cell grid produced essentially
    # nothing (every host throttling, transient network blip), try the
    # small anchor set against whatever hosts are still serving.
    if len(by_hex) < _FALLBACK_MIN_AIRCRAFT:
        anchor_aircraft = await _fetch_anchor_fallback(cell_timeout)
        for a in anchor_aircraft:
            hexid = (a.get("hex") or "").lower()
            if not hexid:
                continue
            cur = by_hex.get(hexid)
            if cur is None:
                by_hex[hexid] = a
            elif (a.get("seen_pos") or 1e9) < (cur.get("seen_pos") or 1e9):
                by_hex[hexid] = a

    return _aircraft_geojson(list(by_hex.values()))


def _merge_with_previous(
    new_fc: dict[str, Any], prev_fc: dict[str, Any], max_age_s: float = 75.0
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
    of vanishing. 75 s covers the worst observed throttled fan-out cycle
    (~30 s) plus two missed cycles — below that, contacts flickered."""
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
    """Background task: refresh the sticky snapshot on a 1s target cycle.

    Each iteration measures fan-out time and sleeps for the remainder of the
    second (sleep = max(0, _SNAPSHOT_TARGET_CYCLE_S - elapsed)). A fast
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
                age = time.monotonic() - _LATEST_SNAPSHOT_AT if _LATEST_SNAPSHOT_AT else float("inf")
                stale = age >= _SNAPSHOT_STALE_S
                accept = new_count > 0 and (
                    stale
                    or prev_count == 0
                    or new_count >= int(prev_count * _SNAPSHOT_MIN_RETAIN_FRACTION)
                )
                if accept:
                    _LATEST_SNAPSHOT = fc
                    _LATEST_SNAPSHOT_AT = time.monotonic()
        except Exception:
            # Never let the background loop die — a transient httpx /
            # cancellation / asyncio exception just rolls into the next tick.
            pass
        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0.0, _SNAPSHOT_TARGET_CYCLE_S - elapsed))


@router.get("/api/adsb/global")
async def adsb_global() -> dict[str, Any]:
    """Return the latest complete aircraft snapshot. Near-instant — never
    blocks on the fan-out, never returns a partial result.

    First call kicks off the background refresher and does one synchronous
    bootstrap fetch so the response isn't empty. Subsequent calls return
    immediately with whatever the background task last accepted."""
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
        # Shallow copy so the caller can't mutate the live snapshot dict.
        # The features list itself is shared (immutable from the caller's
        # POV — every refresh assigns a new FeatureCollection).
        return dict(_LATEST_SNAPSHOT)


@router.get("/api/adsb/snapshot_age")
async def adsb_snapshot_age() -> dict[str, Any]:
    """Debug: age of the sticky snapshot in seconds.

    `age_s` is wall-clock-monotonic seconds since the last accepted snapshot;
    `features` is the current snapshot aircraft count. Used to verify the
    background refresher is keeping the snapshot under the ≤2s end-to-end
    freshness budget."""
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


# Kept for backward compatibility — alias of /api/adsb/global.
@router.get("/api/adsb/lol/global")
async def adsb_lol_global() -> dict[str, Any]:
    return await adsb_global()


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
    async def load() -> dict[str, Any]:
        url = "https://api.airplanes.live/v2/mil"
        r = await get_client().get(url)
        if r.status_code != 200:
            raise HTTPException(502, f"airplanes.live upstream {r.status_code}")
        j = r.json()
        return _aircraft_geojson(j.get("ac") or [])

    return await cache.get_or_fetch("airplaneslive:mil", 30.0, load)


@router.get("/api/adsb/live/squawk/{code}")
async def adsb_live_squawk(code: str) -> dict[str, Any]:
    if not code.isdigit() or len(code) != 4:
        raise HTTPException(400, "squawk must be 4 digits")

    async def load() -> dict[str, Any]:
        url = f"https://api.airplanes.live/v2/squawk/{code}"
        r = await get_client().get(url)
        if r.status_code != 200:
            raise HTTPException(502, f"airplanes.live upstream {r.status_code}")
        j = r.json()
        return _aircraft_geojson(j.get("ac") or [])

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
