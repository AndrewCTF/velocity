"""GET /api/jamming/nacp — GPS/GNSS jamming detection layer.

Per research_updated.md §2.7 + §5 and research.md §5 (GPSJam methodology).

Every ADS-B position message carries `nac_p` (Navigation Accuracy Category –
position) and the operational-status message carries `nic` (Navigation
Integrity Category). FAA-compliant operation requires nac_p ≥ 8 and nic ≥ 7;
values below indicate the on-board GNSS is degraded — typically because the
aircraft is flying through a jamming / spoofing footprint.

We replicate GPSJam.org's bucketing without pulling in an H3 dep: bin every
aircraft with a known nac_p into a 1°×1° lat/lon cell, count total vs. bad,
and return GeoJSON points at the cell centres so the same PollGeoJsonAdapter
can render the heat layer.

Source of truth for the multi-host fan-out is /api/adsb/global, which we
call directly (in-process) so we don't fan out a second pass of upstream
requests and stay well under the 1 req/s ceilings of airplanes.live and
adsb.lol.
"""

from __future__ import annotations

import math
from math import sqrt
from typing import Any

from fastapi import APIRouter

from app.upstream import cache

router = APIRouter(tags=["jamming"])


# FAA-compliant GNSS thresholds per research.md §5. Anything below counts as
# "bad" for the purposes of the heat map — exactly the GPSJam.org rule.
NACP_GOOD = 8
NIC_GOOD = 7

# Minimum cell population before a cell is considered diagnostic. Below this,
# a single bad fix in an empty cell would look like a 100% jamming hit when
# it's actually just noise. Mirrors the correlation-rule threshold.
MIN_TOTAL_FOR_HIGH = 3
PCT_HIGH = 50.0
PCT_MEDIUM = 30.0


def _hex_polygon(cx: float, cy: float, r: float = 0.5) -> list[list[float]]:
    """6-sided polygon centred on (cx, cy) with circumradius r degrees.

    Returns 7 coordinate pairs (first == last to close the GeoJSON ring).
    At r=0.5 the hexagons tile a 1°×1° grid exactly.
    """
    pts: list[list[float]] = []
    for i in range(7):  # 6 vertices + closing repeat
        angle = math.radians(60 * i)
        pts.append([cx + r * math.cos(angle), cy + r * math.sin(angle)])
    return pts


def _bucket_key(lon: float, lat: float) -> tuple[int, int]:
    """1°×1° cell key (floor). Antimeridian-safe via wrap into [-180, 180).

    We use floor — not int() — because int() truncates toward zero, which
    collapses (-0.5, 0.5) into bucket 0 from both sides. Floor keeps
    negative lons in their own buckets.
    """
    # wrap longitude defensively in case an upstream emits ±180.x
    wlon = ((lon + 180.0) % 360.0) - 180.0
    return (int(wlon // 1.0), int(lat // 1.0))


def _severity(total: int, percent_bad: float) -> str:
    """Continuous severity score, then bucketed.

    A cell with 1 bad fix at 100 % isn't as suspicious as a cell with 30 bad
    fixes at 60 %. We want a single scalar that rises with BOTH population and
    percentage, capped so a megacluster doesn't drown out the percent term.

    score = sqrt(min(1, total / MIN_TOTAL_FOR_HIGH)) * (percent_bad / 100)

    The sqrt(min(1, total/N)) factor saturates at 1.0 once we have enough
    population to be statistically diagnostic, and degrades smoothly below
    that threshold rather than the old step ≥3 cutoff.
    """
    if percent_bad <= 0:
        return "none"
    pop = min(1.0, total / float(MIN_TOTAL_FOR_HIGH))
    score = sqrt(pop) * (percent_bad / 100.0)
    # Hard population gate: "high" requires at least MIN_TOTAL_FOR_HIGH
    # aircraft. A single bad fix can't escalate past "medium" no matter how
    # bad — single-fix outliers are too noisy to alert on at the high tier.
    if score >= 0.5 and total >= MIN_TOTAL_FOR_HIGH:
        return "high"
    if score >= 0.3:
        return "medium"
    return "low"


def _aggregate_jamming(features: list[dict[str, Any]]) -> dict[str, Any]:
    """Bucket aircraft features into 1° cells and compute percent_bad per cell.

    Only counts aircraft that actually reported nac_p (i.e. equipped + sending
    integrity data). Aircraft with no nac_p at all are excluded from BOTH
    numerator and denominator — they're MLAT or position-only.
    """
    buckets: dict[tuple[int, int], dict[str, int]] = {}
    for f in features:
        coords = (f.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon = float(coords[0])
            lat = float(coords[1])
        except (TypeError, ValueError):
            continue
        props = f.get("properties") or {}
        nac_p = props.get("nac_p")
        nic = props.get("nic")
        # Require at least one of nac_p / nic to be present and numeric —
        # otherwise the aircraft simply isn't reporting integrity data.
        try:
            nac_p_v = int(nac_p) if nac_p is not None else None
        except (TypeError, ValueError):
            nac_p_v = None
        try:
            nic_v = int(nic) if nic is not None else None
        except (TypeError, ValueError):
            nic_v = None
        if nac_p_v is None and nic_v is None:
            continue

        key = _bucket_key(lon, lat)
        slot = buckets.setdefault(key, {"total": 0, "bad": 0})
        slot["total"] += 1
        is_bad = (nac_p_v is not None and nac_p_v < NACP_GOOD) or (
            nic_v is not None and nic_v < NIC_GOOD
        )
        if is_bad:
            slot["bad"] += 1

    out_features: list[dict[str, Any]] = []
    for (gx, gy), v in buckets.items():
        total = v["total"]
        bad = v["bad"]
        percent_bad = 100.0 * bad / max(total, 1)
        severity = _severity(total, percent_bad)
        if severity == "none":
            continue
        # Cell centre (the bucket key floors the SW corner, so add 0.5).
        center_lon = gx + 0.5
        center_lat = gy + 0.5
        out_features.append(
            {
                "type": "Feature",
                "id": f"jam:{gx}:{gy}",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [_hex_polygon(center_lon, center_lat)],
                },
                "properties": {
                    "total": total,
                    "bad": bad,
                    "percent_bad": round(percent_bad, 1),
                    "severity": severity,
                    "kind": "jamming",
                    "source": "adsb_nacp",
                },
            }
        )
    return {"type": "FeatureCollection", "features": out_features}


@router.get("/api/jamming/nacp")
async def jamming_nacp() -> dict[str, Any]:
    """GPS jamming heat layer derived from live ADS-B integrity flags."""
    # Import here to dodge the routes ↔ routes import cycle at module load.
    # Use the plain snapshot helper, NOT the adsb_global route handler — calling
    # the handler in-process passes its unresolved Query() defaults into
    # viewport_filter and 500s ('>' not supported between instances of 'Query').
    from app.routes.adsb import global_snapshot  # noqa: PLC0415

    async def load() -> dict[str, Any]:
        fc = await global_snapshot()
        return _aggregate_jamming(list(fc.get("features") or []))

    return await cache.get_or_fetch("jamming:nacp", 60.0, load)
