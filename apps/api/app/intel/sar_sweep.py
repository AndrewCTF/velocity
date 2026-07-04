"""Scheduled SAR dark-vessel sweep.

The on-demand ``sar_vessels.detect_dark_vessels`` grabs one Sentinel-1 scene for one
AOI. This loop runs it as standing surveillance: every cycle it sweeps the curated
chokepoint AOIs, caches each result, and keeps a light summary so the frontend/route
can show the latest picture without an operator kicking each AOI by hand.

Cadence is tied loosely to Sentinel-1 revisit (~6-12 h over a given box); a shorter
cycle just re-grabs the same scene, so 6 h is the default. Lifecycle mirrors
``intel.watch`` (module ``_TASK``/``start``/``stop``), started from the app lifespan
and gated off by ``OSINT_DISABLE_BACKGROUND`` for tests.

Scene-freshness skip (only re-run an AOI when CDSE has a newer scene) needs the scene
acquisition id from the Process API, which the current grab does not surface — tracked
as a refinement. For now each cycle re-grabs; the cost is bounded (one small scene per
AOI, sequential, once per 6 h).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from app.intel import sar_vessels

log = logging.getLogger("app.sar_sweep")

_SWEEP_CYCLE_S = 6 * 3600.0
_GAP_S = 2.0  # small pause between AOI grabs so a sweep never bursts CDSE

# aoi -> {summary, features, swept_at}. Latest sweep only (a scene is a point in time).
_RESULTS: dict[str, dict[str, Any]] = {}
_LAST_SWEEP_AT: float | None = None


async def sweep_once(aois: list[str] | None = None) -> int:
    """Grab + detect for each AOI, caching the result. Returns AOIs with detections."""
    global _LAST_SWEEP_AT
    keys = aois if aois is not None else list(sar_vessels.AOIS.keys())
    hit = 0
    for aoi in keys:
        try:
            r = await sar_vessels.detect_dark_vessels(aoi)
        except Exception as exc:  # noqa: BLE001 — one bad AOI must not sink the sweep
            log.debug("sar_sweep: %s failed: %s", aoi, exc)
            continue
        # Drop the heavy raw-scene bytes before caching — the route serves GeoJSON.
        feats = r.get("features", [])
        _RESULTS[aoi] = {
            "summary": r.get("summary", {}),
            "features": feats,
            "swept_at": time.time(),
        }
        if feats:
            hit += 1
        await asyncio.sleep(_GAP_S)
    _LAST_SWEEP_AT = time.time()
    total = sum(len(v["features"]) for v in _RESULTS.values())
    mil = sum(v["summary"].get("mil_hints", 0) for v in _RESULTS.values())
    log.info("sar_sweep: %d AOIs, %d detections, %d mil-hints", len(keys), total, mil)
    return hit


def latest() -> dict[str, Any]:
    """Cached sweep across all AOIs — for the route/frontend."""
    aois = []
    for aoi, v in _RESULTS.items():
        s = v["summary"]
        aois.append(
            {
                "aoi": aoi,
                "label": s.get("label", aoi),
                "detections": s.get("detections", 0),
                "dark_candidates": s.get("dark_candidates", 0),
                "mil_hints": s.get("mil_hints", 0),
                "ais_coverage": s.get("ais_coverage", 0),
                "px_size_m": s.get("px_size_m"),
                "date": s.get("date"),
                "swept_at": int(v["swept_at"]),
            }
        )
    aois.sort(key=lambda a: (a["mil_hints"], a["dark_candidates"], a["detections"]), reverse=True)
    return {
        "swept_at": int(_LAST_SWEEP_AT) if _LAST_SWEEP_AT else None,
        "aois": aois,
        "total_detections": sum(a["detections"] for a in aois),
        "total_mil_hints": sum(a["mil_hints"] for a in aois),
    }


def results_for(aoi: str) -> dict[str, Any] | None:
    """Full GeoJSON FeatureCollection for one AOI's latest sweep, or None."""
    v = _RESULTS.get(aoi)
    if v is None:
        return None
    return {"type": "FeatureCollection", "features": v["features"], "summary": v["summary"]}


def reset_state() -> None:
    global _LAST_SWEEP_AT
    _RESULTS.clear()
    _LAST_SWEEP_AT = None


# ── background task lifecycle (mirrors intel.watch.start / stop) ─────────────────

_TASK: asyncio.Task[None] | None = None
_STARTED = False


async def _run_forever() -> None:
    # First sweep shortly after boot (not instantly — let imagery creds + store warm).
    await asyncio.sleep(30.0)
    while True:
        try:
            await sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.debug("sar_sweep: cycle error: %s", exc)
        await asyncio.sleep(_SWEEP_CYCLE_S)


async def start() -> None:
    """Start the SAR sweep loop (idempotent)."""
    global _TASK, _STARTED
    if _STARTED:
        return
    _STARTED = True
    _TASK = asyncio.create_task(_run_forever())


async def stop() -> None:
    """Cancel the loop and clear state (clean shutdown / test isolation)."""
    global _TASK, _STARTED
    _STARTED = False
    if _TASK is not None:
        _TASK.cancel()
        try:
            await _TASK
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _TASK = None
    reset_state()
