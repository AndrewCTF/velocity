"""Area-of-interest (AOI) priority loading.

The MCP brief: *"when the agent wants an area, load that area PRIMARY, then
only load others."* The guarded global snapshot (``app.routes.adsb``) stays
exactly as is — densify-only, sticky, background-refreshed. This module adds
a parallel, **additive** mechanism on top of it:

1. ``focus(lat, lon, radius_nm)`` registers an AOI and does an immediate
   dedicated ``/v2/point`` fetch for just that area. A single point query is
   cheap and rarely throttled even when the global firehose is 429'ing 2 of 3
   hosts — so the agent's area is fresh and dense regardless of global rate
   limits.
2. A background warmer keeps every registered AOI hot on a short cycle
   (priority), while the rest of the world keeps streaming from the global
   snapshot ("only load others").
3. If every host refuses the direct fetch, we degrade gracefully to filtering
   the global snapshot for the AOI bbox — the agent always gets data.

Bounded to ``_MAX_AOIS`` (LRU). Uses the SAME shared httpx client + upstream
semaphore + host list + normaliser as the adsb module, so it can never
out-pace the global fan-out's rate budget.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Any

import httpx

from app.intel.geo import BBox, bbox_from_radius, feature_lonlat
from app.upstream import cache, get_client

# Fresh-priority TTL for a focused area. Short → the warmer + agent see
# sub-5s data for their AOI. Independent of the global snapshot's TTLs.
_AOI_TTL = 4.0
_WARMER_PERIOD = 4.0
_MAX_AOIS = 8
_MAX_RADIUS_NM = 250  # /v2/point hard ceiling on airplanes.live / adsb.lol
# An AOI nobody has focused/queried for this long is evicted by the warmer.
# Without this, up to _MAX_AOIS stale areas kept hitting upstream every
# _WARMER_PERIOD seconds FOREVER after the agent session that registered
# them ended.
_AOI_IDLE_EVICT_S = 900.0


class AOI:
    __slots__ = (
        "id",
        "lat",
        "lon",
        "radius_nm",
        "label",
        "bbox",
        "created_at",
        "last_access",
        "last_fetch_at",
        "fetch_count",
        "last_count",
        "last_mode",
    )

    def __init__(self, lat: float, lon: float, radius_nm: float, label: str | None):
        self.id = f"{lat:.2f}_{lon:.2f}_{int(radius_nm)}"
        self.lat = lat
        self.lon = lon
        self.radius_nm = radius_nm
        self.label = label or self.id
        self.bbox: BBox = bbox_from_radius(lat, lon, radius_nm)
        now = time.time()
        self.created_at = now
        self.last_access = now
        self.last_fetch_at = 0.0
        self.fetch_count = 0
        self.last_count = 0
        self.last_mode = "pending"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "center": {"lat": round(self.lat, 4), "lon": round(self.lon, 4)},
            "radius_nm": self.radius_nm,
            "bbox": self.bbox.as_dict(),
            "fetch_count": self.fetch_count,
            "last_count": self.last_count,
            "last_mode": self.last_mode,
            "age_s": round(time.time() - self.created_at, 1),
            "last_fetch_age_s": (
                round(time.time() - self.last_fetch_at, 1) if self.last_fetch_at else None
            ),
        }


_AOIS: OrderedDict[str, AOI] = OrderedDict()
_WARMER_TASK: asyncio.Task[None] | None = None


def _clamp_radius(radius_nm: float) -> int:
    return max(1, min(_MAX_RADIUS_NM, int(radius_nm)))


async def _direct_point(lat: float, lon: float, radius_nm: int) -> dict[str, Any] | None:
    """Dedicated single-area fetch. Walks the adsb host list from the
    deterministic primary, takes the first 200, normalises with the same
    schema the globe consumes. Returns a FeatureCollection, or None if every
    host refused (caller then falls back to the global snapshot)."""
    # Imported lazily: adsb imports nothing from us, but we touch its module
    # globals and the routes package is wired at app start.
    from app.routes.adsb import (  # noqa: PLC0415
        _HEAD_HOSTS,
        _UPSTREAM_SEMAPHORE,
        _aircraft_geojson,
        _primary_host_idx,
    )

    client = get_client()
    # Tight budget: a focused area must answer fast. Try the deterministic
    # primary + one fallback (≤~8s worst case), then the caller drops to the
    # instant snapshot subset. The background warmer keeps retrying so a
    # transiently-throttled AOI upgrades to a fresh direct fetch within a cycle.
    timeout = httpx.Timeout(4.0, connect=3.0)
    primary = _primary_host_idx(lat, lon)
    hosts_to_try = min(2, len(_HEAD_HOSTS))
    async with _UPSTREAM_SEMAPHORE:
        for offset in range(hosts_to_try):
            host = _HEAD_HOSTS[(primary + offset) % len(_HEAD_HOSTS)]
            url = f"{host}/v2/point/{lat}/{lon}/{radius_nm}"
            try:
                r = await client.get(url, timeout=timeout)
            except (httpx.TimeoutException, httpx.TransportError):
                continue
            if r.status_code != 200:  # 429/403/5xx → walk to next host
                continue
            try:
                ac = list(r.json().get("ac") or [])
            except ValueError:
                continue
            stamped = [dict(a, _seen_at=time.time(), _host=host) for a in ac]
            fc = _aircraft_geojson(stamped)
            fc["_host"] = host
            return fc
    return None


async def _snapshot_subset(bbox: BBox) -> dict[str, Any]:
    """Fallback: filter the warm global snapshot to the AOI bbox."""
    from app.routes.adsb import adsb_global  # noqa: PLC0415

    snap = await adsb_global()
    feats: list[dict[str, Any]] = []
    for f in snap.get("features") or []:
        ll = feature_lonlat(f)
        if ll and bbox.contains(ll[0], ll[1]):
            feats.append(f)
    return {"type": "FeatureCollection", "features": feats}


async def fetch_area(lat: float, lon: float, radius_nm: float) -> dict[str, Any]:
    """Area-primary fetch (cached ``_AOI_TTL``). Always returns a dict with
    ``fc`` (FeatureCollection), ``mode`` ('direct'|'snapshot'), ``host``."""
    radius = _clamp_radius(radius_nm)
    bbox = bbox_from_radius(lat, lon, radius)
    key = f"intel:aoi:{lat:.2f}:{lon:.2f}:{radius}"

    async def load() -> dict[str, Any]:
        direct = await _direct_point(lat, lon, radius)
        if direct is not None:
            return {
                "fc": {"type": "FeatureCollection", "features": direct["features"]},
                "mode": "direct",
                "host": direct.get("_host"),
            }
        subset = await _snapshot_subset(bbox)
        return {"fc": subset, "mode": "snapshot", "host": None}

    result = await cache.get_or_fetch(key, _AOI_TTL, load)
    return result


def _register(lat: float, lon: float, radius_nm: float, label: str | None) -> AOI:
    radius = _clamp_radius(radius_nm)
    aoi = AOI(lat, lon, radius, label)
    existing = _AOIS.get(aoi.id)
    if existing is not None:
        existing.last_access = time.time()
        if label:
            existing.label = label
        _AOIS.move_to_end(aoi.id)
        return existing
    _AOIS[aoi.id] = aoi
    _AOIS.move_to_end(aoi.id)
    while len(_AOIS) > _MAX_AOIS:
        _AOIS.popitem(last=False)  # evict least-recently-focused
    return aoi


async def focus(
    lat: float, lon: float, radius_nm: float = 200.0, label: str | None = None
) -> dict[str, Any]:
    """Register an AOI as PRIMARY, do an immediate fetch, ensure the warmer
    is running. Returns the AOI descriptor + the fetched FeatureCollection."""
    aoi = _register(lat, lon, radius_nm, label)
    _ensure_warmer()
    result = await fetch_area(aoi.lat, aoi.lon, aoi.radius_nm)
    fc = result["fc"]
    aoi.fetch_count += 1
    aoi.last_fetch_at = time.time()
    aoi.last_count = len(fc.get("features") or [])
    aoi.last_mode = result["mode"]
    return {"aoi": aoi.as_dict(), "fc": fc, "mode": result["mode"], "host": result.get("host")}


def list_aois() -> list[dict[str, Any]]:
    return [a.as_dict() for a in reversed(_AOIS.values())]


def _ensure_warmer() -> None:
    global _WARMER_TASK
    if _WARMER_TASK is None or _WARMER_TASK.done():
        try:
            _WARMER_TASK = asyncio.create_task(_warmer_loop())
        except RuntimeError:
            # No running loop (e.g. a unit test calling focus() synchronously
            # via asyncio.run on a fresh loop each time). The per-call fetch
            # still works; only the background priority refresh is skipped.
            _WARMER_TASK = None


async def stop_warmer() -> None:
    """Cancel the background warmer. Wired into the app lifespan so the task
    never outlives its event loop (prevents test-process leakage and ensures a
    clean shutdown). Safe to call when no warmer is running."""
    global _WARMER_TASK
    task = _WARMER_TASK
    _WARMER_TASK = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass


async def _warmer_loop() -> None:
    """Keep every registered AOI hot on a short cycle. Evicts AOIs that have
    not been focused/accessed within _AOI_IDLE_EVICT_S, and self-terminates
    when no AOIs remain so we don't spin an idle task forever."""
    idle_cycles = 0
    while True:
        await asyncio.sleep(_WARMER_PERIOD)
        now = time.time()
        for key in [k for k, a in _AOIS.items() if now - a.last_access > _AOI_IDLE_EVICT_S]:
            _AOIS.pop(key, None)
        aois = list(_AOIS.values())
        if not aois:
            idle_cycles += 1
            if idle_cycles >= 3:
                return
            continue
        idle_cycles = 0
        for aoi in aois:
            try:
                result = await fetch_area(aoi.lat, aoi.lon, aoi.radius_nm)
            except Exception:
                continue
            aoi.fetch_count += 1
            aoi.last_fetch_at = time.time()
            aoi.last_count = len(result["fc"].get("features") or [])
            aoi.last_mode = result["mode"]
