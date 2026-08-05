"""``/api/intel/corroborate`` — the only sanctioned use of a claim-tier source.

docs/plan-99-2026-08.md §0 states the rule this route implements: a `claim` never
sources a fact, never colours the map, and is off by default. Its one legitimate
use is *corroboration* — given an observation an instrument made, does a claim
exist near it in space and time, and how long after.

That is a measurement ABOUT the claim, not a use of it, and the distinction is
the whole reason this is a separate route rather than a field on the contact.

**What it does not do, stated because the temptation is obvious.** It does not
say the claim is about the observation. It cannot. Two things being 12 km and 40
minutes apart is proximity, not aboutness, and a shelling report near a tanker at
anchor may have nothing whatever to do with the tanker. Every response repeats
that in words, and the field is named `nearby` rather than `matching` for the
same reason.

What the number IS good for is the lag. A claim that appears 40 minutes after a
transponder anomaly and a claim that appears three days before it are different
kinds of evidence, and the lag distribution is the thing an analyst can actually
reason about.
"""

from __future__ import annotations

import datetime as dt
import math
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.intel.conflict import conflict_events

router = APIRouter(prefix="/api/intel", tags=["intel"])

_EARTH_KM = 6371.0088


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * _EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def _event_epoch(props: dict[str, Any]) -> float | None:
    """GDELT stamps a day as ``YYYYMMDD`` and nothing finer on this feed."""
    day = str(props.get("day") or "")
    if len(day) != 8 or not day.isdigit():
        return None
    y, m, d = int(day[:4]), int(day[4:6]), int(day[6:8])
    # Ranges checked explicitly, because `mktime` NORMALISES rather than
    # rejects: month 13 day 45 becomes a real timestamp four months into the
    # future, and a garbage stamp silently turning into a confident lag is
    # exactly the quiet fabrication this route exists to avoid.
    try:
        return dt.datetime(y, m, d, tzinfo=dt.UTC).timestamp()
    except ValueError:
        return None


@router.get("/corroborate")
async def corroborate(
    lon: float = Query(..., ge=-180, le=180),
    lat: float = Query(..., ge=-90, le=90),
    at: float | None = Query(None, description="observation time, epoch seconds"),
    radius_km: float = Query(50.0, gt=0, le=500),
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """Claim-tier reports near one observation, with their lag."""
    fc = await conflict_events(hours=hours)
    if fc.get("unavailable"):
        # A dead claim feed is not "nothing was said". The caller has to be able
        # to tell those apart, so this is an explicit failure and not an empty
        # result with a reassuring shape.
        raise HTTPException(502, "claim-tier source unavailable")

    t0 = at if at and at > 0 else time.time()
    near: list[dict[str, Any]] = []
    for f in fc.get("features", []):
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        d = haversine_km(lon, lat, float(coords[0]), float(coords[1]))
        if d > radius_km:
            continue
        p = f.get("properties") or {}
        ts = _event_epoch(p)
        near.append(
            {
                "distance_km": round(d, 1),
                # Positive: the claim is dated AFTER the observation.
                "lag_s": None if ts is None else round(ts - t0),
                "actor1": p.get("actor1"),
                "actor2": p.get("actor2"),
                "event": p.get("event"),
                "mentions": p.get("mentions"),
                "day": p.get("day"),
                "url": p.get("url"),
                "source": p.get("source"),
            }
        )
    near.sort(key=lambda r: r["distance_km"])
    lags = [r["lag_s"] for r in near if r["lag_s"] is not None]
    return {
        "observation": {"lon": lon, "lat": lat, "at": t0},
        "window": {"radius_km": radius_km, "hours": hours},
        "nearby": near[:limit],
        "count": len(near),
        "considered": len(fc.get("features", [])),
        "earliest_lag_s": min(lags) if lags else None,
        "tier": "claim",
        "note": (
            "Proximity is not aboutness. This counts claim-tier reports near this position in "
            "space and time; it does not assert that any of them is about this observation, and "
            "nothing here may be used to source a fact. The GDELT feed dates events to the day, "
            "so a lag is accurate to about a day and no finer."
        ),
    }
