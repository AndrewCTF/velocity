"""GPS jammer/spoofer geolocation from the open-ADS-B degradation footprint.

We don't have RF direction-finding. But GPS interference is ground-based and its
effect on aircraft GNSS integrity (NACp/NIC) is strongest near the emitter and
fades with distance — so the set of degraded aircraft forms a footprint whose
severity-weighted centroid estimates the emitter, with a CEP (circular error
probable) from the spread. This is a footprint-centroid estimate (~tens of km),
honestly NOT an RF fix — stated in the response. Even so it converts "jamming
somewhere here" into "emitter ~here ±N km", which is the defense-relevant product.
"""

from __future__ import annotations

import time
from typing import Any

from app.intel.geo import BBox, feature_lonlat, haversine_km


def _degradation_weight(props: dict[str, Any]) -> float:
    """0 (clean) .. 2 (both NACp and NIC below the FAA thresholds)."""
    w = 0.0
    nac_p, nic = props.get("nac_p"), props.get("nic")
    try:
        if nac_p is not None and int(nac_p) < 8:
            w += 1.0
    except (TypeError, ValueError):
        pass
    try:
        if nic is not None and int(nic) < 7:
            w += 1.0
    except (TypeError, ValueError):
        pass
    return w


def estimate_from_points(points: list[tuple[float, float, float]]) -> dict[str, Any] | None:
    """points = [(lon, lat, weight)]; weight>0. Returns an emitter estimate."""
    pts = [(lo, la, w) for (lo, la, w) in points if w > 0]
    if len(pts) < 3:
        return None
    tw = sum(w for _, _, w in pts)
    clon = sum(lo * w for lo, _, w in pts) / tw
    clat = sum(la * w for _, la, w in pts) / tw
    # CEP ~ severity-weighted median distance from the centroid.
    dists = sorted(haversine_km(clon, clat, lo, la) for lo, la, _ in pts)
    cep = dists[len(dists) // 2]
    # Confidence climbs with sample size and a TIGHTER footprint (small CEP
    # relative to extent), but is HARD-penalised by absolute CEP: a 300 km-wide
    # degraded footprint is region-wide interference, not a locatable point
    # source, and must NOT read as a high-confidence emitter fix.
    extent = dists[-1] or 1.0
    concentration = 1.0 - min(1.0, cep / extent)
    n_factor = min(1.0, len(pts) / 25.0)
    cep_factor = max(0.0, 1.0 - cep / 150.0)  # → 0 once CEP exceeds ~150 km
    raw = 0.3 + 0.4 * n_factor + 0.3 * concentration
    confidence = round(max(0.15, min(0.9, raw * (0.3 + 0.7 * cep_factor))), 2)
    quality = (
        "point-like" if cep <= 60.0
        else "diffuse — region-wide interference, not a point source"
    )
    return {
        "lon": round(clon, 4),
        "lat": round(clat, 4),
        "cep_km": round(cep, 1),
        "footprint_km": round(extent, 1),
        "n_degraded": len(pts),
        "confidence": confidence,
        "quality": quality,
        "method": "severity-weighted centroid of GPS-degraded ADS-B reports; "
        "footprint-centroid estimate (not RF DF), accuracy ~tens of km, assumes "
        "a single dominant ground emitter.",
    }


async def estimate(bbox: BBox | None) -> dict[str, Any]:
    """Gather GPS-degraded aircraft (in bbox or global) and estimate the emitter."""
    from app.intel import analytics  # noqa: PLC0415

    feats = await analytics._snapshot()
    points: list[tuple[float, float, float]] = []
    for f in feats:
        ll = feature_lonlat(f)
        if ll is None or (bbox is not None and not bbox.contains(ll[0], ll[1])):
            continue
        w = _degradation_weight(f.get("properties") or {})
        if w > 0:
            points.append((ll[0], ll[1], w))
    est = estimate_from_points(points)
    return {
        "generated_at": int(time.time()),
        "bbox": bbox.as_dict() if bbox else None,
        "degraded_considered": len(points),
        "emitter": est,
        "note": None if est else "Too few degraded reports to estimate an emitter (need >=3).",
    }


def estimate_for_incident(jamming_lonlats: list[tuple[float, float]]) -> dict[str, Any] | None:
    """Lightweight per-incident estimate from that incident's jamming cell
    centroids (equal weight — cells are already aggregated)."""
    if len(jamming_lonlats) < 3:
        return None
    clon = sum(lo for lo, _ in jamming_lonlats) / len(jamming_lonlats)
    clat = sum(la for _, la in jamming_lonlats) / len(jamming_lonlats)
    dists = sorted(haversine_km(clon, clat, lo, la) for lo, la in jamming_lonlats)
    return {
        "lon": round(clon, 4), "lat": round(clat, 4),
        "cep_km": round(dists[len(dists) // 2], 1),
        "n_cells": len(jamming_lonlats),
    }
