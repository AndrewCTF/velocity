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

router = APIRouter(tags=["timeline"])


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
