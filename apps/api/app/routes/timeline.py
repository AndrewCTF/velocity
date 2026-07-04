"""GET /api/timeline/density — bucketed activity histogram.

Backed by the in-memory Observation store. Returns three series — detections
(aircraft + vessel + quake observations), alerts (from the bus's recent
buffer), and gaps (placeholder until per-MMSI gap tracking lands) — bucketed
into N equal-width bins over the last `windowSec` seconds.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Query

from app.correlate.bus import bus
from app.correlate.store import store
from app.intel.incident_store import incident_store

router = APIRouter(tags=["timeline"])

# Cap discrete markers per lane so a busy window can't ship thousands of points
# to the scrubber (the existing /density strip already carries ADS-B/AIS volume —
# these lanes are the clickable, low-count, analytic events).
# ponytail: 2 discrete lanes (incidents + signals); ADS-B/AIS volume stays on the
# density strip. Add per-source detection lanes here if the operator wants them.
_MAX_MARKERS = 200


@router.get("/api/timeline/density")
async def density(
    bins: int = Query(240, ge=12, le=720),
    window_sec: int = Query(20 * 3600, ge=60, le=72 * 3600),
) -> dict[str, Any]:
    now = time.time()
    bin_width = window_sec / bins
    detections = [0] * bins
    alerts = [0] * bins
    gaps = [0] * bins

    for o in store.window(seconds=window_sec):
        idx = int((o.t - (now - window_sec)) / bin_width)
        if 0 <= idx < bins and o.emits_kind in ("aircraft", "vessel", "quake"):
            detections[idx] += 1

    for a in bus.recent(500):
        idx = int((a.t - (now - window_sec)) / bin_width)
        if 0 <= idx < bins:
            alerts[idx] += 1

    return {
        "from": int((now - window_sec) * 1000),
        "to": int(now * 1000),
        "bins": bins,
        "binWidthSec": bin_width,
        "detections": detections,
        "alerts": alerts,
        "gaps": gaps,
    }


@router.get("/api/timeline/events")
async def events(
    window_sec: int = Query(20 * 3600, ge=60, le=72 * 3600),
    scope: str = Query("global"),
) -> dict[str, Any]:
    """Discrete, clickable timeline events grouped by source lane (the Gotham
    multi-track scrubber). Two lanes: fused INCIDENTS (from the incident store's
    per-scope history) and SIGNALS (recent alert-bus events). Each marker carries a
    timestamp, a label, a position, and a ref id so a click can fly + select + jump
    the clock. Markers are capped per lane; the existing /density strip carries the
    high-volume ADS-B/AIS activity."""
    now = time.time()
    floor = now - window_sec

    # ── Incidents lane: one marker per incident at the time it FIRST appeared. ──
    inc_events: list[dict[str, Any]] = []
    hist = incident_store.history(scope, window_sec)
    for inc in hist.get("incidents", []):
        pts = inc.get("points") or []
        if not pts:
            continue
        first = min(pts, key=lambda p: p.get("t", 0))
        cen = inc.get("centroid") or {}
        inc_events.append(
            {
                "t": int(first.get("t", floor)) * 1000,
                "label": (inc.get("narrative") or inc.get("key") or "incident")[:120],
                "lat": cen.get("lat"),
                "lon": cen.get("lon"),
                "ref_id": f"incident:{inc.get('key')}" if inc.get("key") else None,
                "severity": first.get("level"),
            }
        )
    inc_events.sort(key=lambda e: e["t"])

    # ── Signals lane: recent alert-bus events within the window. ──
    sig_events: list[dict[str, Any]] = []
    for a in bus.recent(1000):
        if a.t < floor:
            continue
        sig_events.append(
            {
                "t": int(a.t * 1000),
                "label": (a.message or a.rule_id or "alert")[:120],
                "lat": a.lat,
                "lon": a.lon,
                "ref_id": a.id,
                "severity": a.severity,
            }
        )
    sig_events.sort(key=lambda e: e["t"])

    return {
        "window": {"from": int(floor * 1000), "to": int(now * 1000)},
        "lanes": [
            {
                "id": "incidents",
                "label": "Incidents",
                "color": "#ef4444",
                "events": inc_events[-_MAX_MARKERS:],
            },
            {
                "id": "signals",
                "label": "Signals Intel",
                "color": "#f59e0b",
                "events": sig_events[-_MAX_MARKERS:],
            },
        ],
    }
