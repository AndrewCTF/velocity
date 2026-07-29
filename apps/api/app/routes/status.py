"""GET /api/status — PUBLIC live status + honest coverage.

Measured counts from the running snapshot (aircraft in the live feed, refresh
age) plus per-feed green/degraded health. Public (no auth) so it can back a
trust/status page. Deliberately states coverage limits rather than implying
total coverage.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections import deque
from typing import Any

from fastapi import APIRouter

from app.config import get_settings
from app.routes import adsb as adsb_routes

router = APIRouter(tags=["status"])

# Steady-state floor the aircraft union should hold (see CLAUDE.md guardrail).
_AIRCRAFT_FLOOR = 8000


def _feed(name: str, ok: bool, detail: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "green" if ok else "degraded", "detail": detail, **extra}


@router.get("/api/status")
async def status() -> dict[str, Any]:
    s = get_settings()
    from app import ais_firehose, ais_keyless, marinetraffic  # noqa: PLC0415

    # Counts only — never `global_snapshot()`. This route is public, anonymous
    # and polled by status pages, and calling the snapshot helper for a number
    # took _SNAPSHOT_LOCK (held by the 1 Hz refresher across its merge), copied
    # the snapshot dict, and on a cold process could kick a fan-out from an
    # anonymous request. Measured p50 12.5 ms -> 10.1 ms. The multi-second tail
    # is loop-wide, not this route's, and is unchanged — see
    # adsb_routes.snapshot_count().
    try:
        aircraft = adsb_routes.snapshot_count()
    except Exception:  # noqa: BLE001 — status must never 500
        aircraft = 0
    age = adsb_routes.snapshot_age_s()

    # Live vessels in the unified store: latest fix per MMSI across ALL AIS
    # sources (Digitraffic, Kystverket/Kystdatahuset, AISStream) accumulated
    # within the store retention window. Northern Europe only without an AISStream
    # key; global AIS needs one.
    vessels = 0
    parked = 0
    try:
        from app.correlate.store import store  # noqa: PLC0415
        from app.routes import maritime  # noqa: PLC0415

        vessels = store.count("vessel")
        parked = maritime.parked_count()
    except Exception:  # noqa: BLE001 — never let vessels break status
        vessels = 0

    ais_stats = ais_keyless.stats()
    keyless_ais_on = bool(
        ais_firehose.stats().get("enabled")
        or ais_stats.get("kystdatahuset_enabled")
        or ais_stats.get("digitraffic_mqtt_enabled")
        # The two GLOBAL keyless sources count too — without them this read
        # "no keyless AIS" while ~46k of the ~56k vessels came from exactly here.
        or ais_stats.get("shipxplorer_enabled")
        or ais_stats.get("myshiptracking_sidecar_enabled")
    )
    # Non-zero while the MyShipTracking feeder's browser has lost the site: the
    # poller then refuses its replayed union, so its ~22k global MMSIs drop out
    # BY DESIGN. Surface it — a third of the vessel layer going missing is not a
    # green feed, and the count alone can't show it (the rest of the union hides
    # the hole).
    mst_stale_s = int(ais_stats.get("myshiptracking_stale_s") or 0)
    # Enabled but landing nothing — the site is blocking its browser, or it is
    # still warming its first sweep. The union stays honest either way (the other
    # sources carry it), so this annotates the detail rather than reddening the
    # feed. Naming a source that is contributing zero would be the same overclaim
    # this feed used to make when it called a global union "Northern Europe only".
    mst_dry = bool(ais_stats.get("myshiptracking_sidecar_enabled")) and not int(
        ais_stats.get("myshiptracking_vessels") or 0
    )

    feeds = [
        _feed(
            "ADS-B aircraft (OpenSky + airplanes.live grid)",
            aircraft >= _AIRCRAFT_FLOOR,
            f"{aircraft} aircraft in the live snapshot"
            + (f", refreshed {age}s ago" if age is not None else ""),
            count=aircraft,
            age_s=age,
        ),
        _feed(
            "AIS vessels — keyless",
            keyless_ais_on and vessels > 0 and not mst_stale_s,
            f"{vessels} vessels ({parked} parked, long-retained) · worldwide, "
            "MMSI-deduped across ShipXplorer"
            + ("" if mst_dry else " and MyShipTracking")
            + " plus the Norway and Baltic regional feeds"
            + (
                f" · MyShipTracking is replaying a {mst_stale_s}s-old scrape and is "
                "held out of the union until it recovers"
                if mst_stale_s
                else " · MyShipTracking is not reporting"
                if mst_dry
                else ""
            ),
            count=vessels,
        ),
        _feed(
            "AIS vessels — AISStream (global firehose)",
            bool(s.aisstream_key),
            "GLOBAL coverage — live."
            if s.aisstream_key
            else "Dormant: set AISSTREAM_KEY (free at aisstream.io) for worldwide AIS. "
            "No keyless global feed exists from a server — this is the firehose.",
        ),
        _feed(
            "AIS vessels — MarineTraffic (global, paid)",
            bool(s.marinetraffic_key) and marinetraffic.stats().get("last_error") is None,
            (
                f"{marinetraffic.stats().get('vessels', 0)} vessels"
                + (
                    f" · err: {marinetraffic.stats().get('last_error')}"
                    if marinetraffic.stats().get("last_error") else ""
                )
            )
            if s.marinetraffic_key
            else "Dormant: set MARINETRAFFIC_KEY (paid) to enable. May be IP-restricted.",
        ),
        _feed(
            "GPS/GNSS jamming (derived)",
            aircraft > 0,
            "Inference from ADS-B NACp/NIC degradation — not a direct RF/SIGINT cut.",
        ),
        _feed("USGS earthquakes", True, "Keyless, always on."),
        _feed(
            "Sentinel-1 SAR dark-vessel",
            True,
            "Curated chokepoint AOIs only (e.g. Strait of Hormuz); ~6 h revisit.",
        ),
        _feed(
            "NASA FIRMS fires",
            bool(s.firms_map_key),
            "Key configured." if s.firms_map_key else "Needs MAP_KEY (degrades off).",
        ),
        _feed(
            "AISStream global AIS",
            bool(s.aisstream_key),
            "BYOK, on-demand." if s.aisstream_key else "BYOK — bring a key to enable.",
        ),
    ]

    overall = "operational" if aircraft >= _AIRCRAFT_FLOOR else ("degraded" if aircraft else "down")
    return {
        "status": overall,
        "generated_at": int(time.time()),
        "build_id": s.build_id,
        "aircraft_count": aircraft,
        "aircraft_age_s": age,
        "aircraft_floor": _AIRCRAFT_FLOOR,
        "vessel_count": vessels,
        "parked_count": parked,
        "feeds": feeds,
        "note": (
            "Live counts from the running snapshot. Coverage is uneven by design — "
            "absence of a signal in a thin-coverage region is not evidence of absence. "
            "See /api/intel/sources (authenticated) for per-feed detail."
        ),
    }


# ── /api/status/perf ─────────────────────────────────────────────────────────
#
# The 2026-07-27 baseline could not report event-loop lag because nothing
# measured it, so the single most diagnostic number for "the backend blows up
# when I enable all toggles" was missing from the evidence. This endpoint is
# that number plus the counters that explain it, and it is what the perf
# harnesses poll.
#
# It must stay CHEAP — it is sampled once a second during a measurement run, so
# it may not walk the snapshot or the vessel store the way /api/status does.

_LAG_SAMPLES: deque[float] = deque(maxlen=120)
_LAG_TASK: asyncio.Task[None] | None = None
_LAG_TICK_S = 0.5


async def _lag_probe_forever() -> None:
    """Sleep a known interval and record the overshoot.

    A task that asks for 0.5 s and gets 0.9 s spent 400 ms waiting behind
    something that would not yield. That overshoot IS the lag every request on
    this loop is also paying.
    """
    loop = asyncio.get_running_loop()
    while True:
        t0 = loop.time()
        await asyncio.sleep(_LAG_TICK_S)
        _LAG_SAMPLES.append(max(0.0, (loop.time() - t0 - _LAG_TICK_S) * 1000.0))


def start_lag_probe() -> None:
    global _LAG_TASK
    if _LAG_TASK is None or _LAG_TASK.done():
        _LAG_TASK = asyncio.create_task(_lag_probe_forever())


async def stop_lag_probe() -> None:
    global _LAG_TASK
    t = _LAG_TASK
    _LAG_TASK = None
    if t and not t.done():
        t.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await t


def _pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, max(0, round((p / 100.0) * (len(s) - 1))))], 2)


@router.get("/api/status/perf")
async def status_perf() -> dict[str, Any]:
    """Event-loop lag, payload freshness and container sizes. Keyless, cheap."""
    lag = list(_LAG_SAMPLES)
    out: dict[str, Any] = {
        "generated_at": int(time.time()),
        "loop_lag_ms_p50": _pct(lag, 50),
        "loop_lag_ms_p95": _pct(lag, 95),
        "loop_lag_ms_max": round(max(lag), 2) if lag else None,
        "loop_lag_samples": len(lag),
        "loop_lag_window_s": round(len(lag) * _LAG_TICK_S, 1),
    }
    # ADS-B world blob — size and age come from module state, no snapshot walk.
    try:
        out["adsb"] = {
            "blob_bytes": len(adsb_routes._HOT_BLOB) if adsb_routes._HOT_BLOB else 0,
            "etag": adsb_routes._HOT_ETAG[:12] or None,
            "age_s": round(adsb_routes.snapshot_age_s(), 2),
            "ws_subscribers": len(adsb_routes._WS_SUBSCRIBERS),
            "feed_slices": len(adsb_routes._FEED_SLICES),
            "cycle_ms": adsb_routes.cycle_timings(),
        }
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        out["adsb"] = {"error": "unavailable"}
    try:
        from app.routes import maritime as maritime_routes  # noqa: PLC0415

        out["vessels"] = maritime_routes.vessel_blob_state()
        out["vessels"]["parked_cached"] = maritime_routes.parked_count()
    except Exception:  # noqa: BLE001
        out["vessels"] = {"error": "unavailable"}
    try:
        from app.upstream import cache as upstream_cache  # noqa: PLC0415

        out["feed_cache"] = {
            "entries": len(upstream_cache._data),
            "max_entries": upstream_cache._MAX_CACHE_ENTRIES
            if hasattr(upstream_cache, "_MAX_CACHE_ENTRIES")
            else None,
        }
    except Exception:  # noqa: BLE001
        out["feed_cache"] = {"error": "unavailable"}
    try:
        from app import ais_sidecar  # noqa: PLC0415

        out["ais_supervision"] = ais_sidecar.supervision_state()
    except Exception:  # noqa: BLE001
        out["ais_supervision"] = {"error": "unavailable"}
    return out


@router.get("/api/status/provenance")
async def status_provenance() -> dict[str, Any]:
    """Who is actually seeing the sky right now, and how much they agree.

    Every competitor in this category renders whatever its upstream asserts and
    says nothing about where it came from (docs/research-last30days-2026-07-29.md
    §1.1). The single highest-engagement story in the category is fabricated
    ADS-B rendered as real on a live map, and the community's own detection
    method is cross-source corroboration. This endpoint is that method, exposed:

      - per tier: how many contacts it saw, and how many ONLY it saw,
      - overall: the share of contacts with two or more independent observers.

    Exclusive counts are the interesting column. A tier contributing thousands of
    contacts nobody else can see is either genuinely unique coverage (oceanic
    breadth) or an unverifiable claim, and knowing which of your tiers is in that
    position is the difference between honest breadth and inherited noise.

    Diagnostics: never 500, and never triggers a fan-out of its own - it reads
    the snapshot the refresher already built.
    """
    out: dict[str, Any] = {"as_of": time.time()}
    try:
        snap = await adsb_routes.global_snapshot()
        feats = snap.get("features") or []
        per_tier: dict[str, dict[str, int]] = {}
        corroborated = 0
        counted = 0
        unknown = 0
        for f in feats:
            props = f.get("properties") or {}
            srcs = props.get("sources")
            if not isinstance(srcs, list) or not srcs:
                unknown += 1
                continue
            counted += 1
            if len(srcs) >= 2:
                corroborated += 1
            for s in srcs:
                row = per_tier.setdefault(str(s), {"contacts": 0, "exclusive": 0})
                row["contacts"] += 1
                if len(srcs) == 1:
                    row["exclusive"] += 1
        out["aircraft"] = {
            "total": len(feats),
            # Contacts whose observer set we know. A contact carried forward from
            # an earlier cycle has no set for THIS cycle, and calling that
            # "single source" would be a guess.
            "attributed": counted,
            "unattributed": unknown,
            "corroborated": corroborated,
            "corroborated_pct": round(100.0 * corroborated / counted, 1) if counted else None,
            "tiers": per_tier,
            "confidence_rule": adsb_routes.CONFIDENCE_RULE,
        }
    except Exception:  # noqa: BLE001 — diagnostics must never 500
        out["aircraft"] = {"error": "unavailable"}
    return out
