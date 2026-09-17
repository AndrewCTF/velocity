"""Projected position cone + chokepoint ETA for ONE tracked contact.

An honest predictive product, not a claim: the cone is extrapolated straight
from this entity's OWN recorded fixes (mean heading/speed over the recent
history window, ± 2 standard deviations), never a model, never an LLM. A track
too short to extrapolate honestly answers ``status: "insufficient"`` with the
reason, never a guess — same posture as ``pol.py``'s pattern-of-life baseline.

Reuses ``pol.py``'s speed-segment gating (``_segment_speeds_kn``) and mean/std
helper (``_mean_std``) so a spoofed sub-30s cross-source jump or a physically
impossible speed can't skew the projection the same way it can't skew the
pattern-of-life baseline. Heading needs its own mean/std because heading is
CIRCULAR (0deg and 360deg are the same direction) — a linear mean/std would
answer ~180deg for a track wobbling around due north, which is why that helper
is written fresh here rather than reused from ``pol.py``.
"""

from __future__ import annotations

import math
from typing import Any

from app.intel.geo import NM_TO_KM, haversine_km
from app.intel.pol import (
    _KM_S_TO_KN,
    _MAX_PLAUSIBLE_KN,
    _MIN_SEG_DT_S,
    _mean_std,
    _segment_speeds_kn,
)

# Fewer than this many fixes, or a track spanning less than this many seconds,
# is too short to extrapolate honestly.
_MIN_FIXES: int = 3
_MIN_SPAN_S: float = 120.0

# Cone floor so a perfectly straight/stationary track still yields a real
# polygon rather than a degenerate line or point.
_MIN_HALF_FAN_DEG: float = 5.0
_MIN_RANGE_SPREAD_NM: float = 0.5

# Heading spread is capped so a track with genuinely no directional signal
# (circular resultant length near zero) still yields a bounded fan rather than
# a degenerate near-infinite one from log(~0).
_MAX_HALF_FAN_DEG: float = 90.0

_ARC_STEPS: int = 8  # polygon smoothness for the outer/inner arcs


# ── geodesy: bearing / destination (not in geo.py or pol.py) ────────────────

def _bearing_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Initial great-circle bearing from (lon1,lat1) to (lon2,lat2), in
    [0, 360)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    y = math.sin(dlmb) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlmb)
    return math.degrees(math.atan2(y, x)) % 360.0


def _destination(lon: float, lat: float, bearing_deg: float, dist_km: float) -> tuple[float, float]:
    """Point reached from (lon,lat) travelling ``bearing_deg`` for ``dist_km``
    along a great circle. ``bearing_deg`` may be any real number (trig is
    periodic) so callers never need to wrap a fan edge before calling this."""
    r = 6371.0088
    brng = math.radians(bearing_deg)
    lat1, lon1 = math.radians(lat), math.radians(lon)
    dr = dist_km / r
    sin_lat2 = math.sin(lat1) * math.cos(dr) + math.cos(lat1) * math.sin(dr) * math.cos(brng)
    lat2 = math.asin(min(1.0, max(-1.0, sin_lat2)))
    lon2 = lon1 + math.atan2(
        math.sin(brng) * math.sin(dr) * math.cos(lat1),
        math.cos(dr) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lon2), math.degrees(lat2)


def _circular_mean_std_deg(headings_deg: list[float]) -> tuple[float, float]:
    """Mean + std of a list of compass headings, using the circular (vector)
    definition so a track wobbling around due north doesn't answer ~180deg.

    Std comes from the resultant vector length ``R`` (Mardia's circular
    std: ``sqrt(-2 ln R)``), clamped so ``R`` near 0 (no directional signal at
    all) yields ``_MAX_HALF_FAN_DEG`` rather than a division/log blowup.
    """
    if not headings_deg:
        return 0.0, 0.0
    rad = [math.radians(h) for h in headings_deg]
    n = len(rad)
    sin_mean = sum(math.sin(r) for r in rad) / n
    cos_mean = sum(math.cos(r) for r in rad) / n
    mean_deg = math.degrees(math.atan2(sin_mean, cos_mean)) % 360.0
    resultant = min(1.0, max(1e-9, math.sqrt(sin_mean * sin_mean + cos_mean * cos_mean)))
    std_deg = math.degrees(math.sqrt(-2.0 * math.log(resultant)))
    return mean_deg, min(std_deg, _MAX_HALF_FAN_DEG)


def _normalize_near(angle_deg: float, ref_deg: float) -> float:
    """Shift ``angle_deg`` by whole turns so it sits within 180deg of
    ``ref_deg`` — makes a fan comparison ([lo, hi] around ``ref_deg``, which
    may extend outside [0, 360)) correct across the 0/360 wrap."""
    a = angle_deg
    while a - ref_deg > 180.0:
        a -= 360.0
    while a - ref_deg < -180.0:
        a += 360.0
    return a


def _headings(pts: list[tuple[float, float, float]]) -> list[float]:
    """Segment-to-segment bearings over time-ordered ``(t, lon, lat)`` fixes,
    gated exactly like ``_segment_speeds_kn`` (dt >= 30s, plausible speed) so
    heading and speed are derived from the same real segments."""
    out: list[float] = []
    for (ta, lo_a, la_a), (tb, lo_b, la_b) in zip(pts, pts[1:], strict=False):
        dt = tb - ta
        if dt < _MIN_SEG_DT_S:
            continue
        d_km = haversine_km(lo_a, la_a, lo_b, la_b)
        spd_kn = (d_km / dt) * _KM_S_TO_KN
        if spd_kn > _MAX_PLAUSIBLE_KN:
            continue
        out.append(_bearing_deg(lo_a, la_a, lo_b, la_b))
    return out


def _sector_polygon(
    lon0: float, lat0: float, bearing_lo: float, bearing_hi: float, r_min_nm: float, r_max_nm: float
) -> dict[str, Any]:
    """A GeoJSON Polygon sweeping the heading fan [bearing_lo, bearing_hi] from
    ``r_min_nm`` to ``r_max_nm`` out of (lon0, lat0). When ``r_min_nm`` is
    negligible the inner edge collapses to the origin (a triangular fan);
    otherwise it is a proper annular wedge."""
    span = bearing_hi - bearing_lo
    outer = [
        list(_destination(lon0, lat0, bearing_lo + span * i / _ARC_STEPS, r_max_nm * NM_TO_KM))
        for i in range(_ARC_STEPS + 1)
    ]
    if r_min_nm > 1e-6:
        inner = [
            list(_destination(lon0, lat0, bearing_hi - span * i / _ARC_STEPS, r_min_nm * NM_TO_KM))
            for i in range(_ARC_STEPS + 1)
        ]
        ring = [*outer, *inner, outer[0]]
    else:
        ring = [[lon0, lat0], *outer, [lon0, lat0]]
    return {"type": "Polygon", "coordinates": [ring]}


def _insufficient(reason: str) -> dict[str, Any]:
    return {"status": "insufficient", "reason": reason}


def project(
    points: list[tuple[float, float, float]],
    horizon_s: float,
    chokepoints: list[tuple[str, float, float, float, float, float, float]] | None = None,
) -> dict[str, Any]:
    """Project a contact's position ``horizon_s`` seconds forward from its own
    recorded ``(lon, lat, t)`` fixes.

    Returns ``status: "insufficient"`` with a reason for a track too short or
    too static to honestly extrapolate (fewer than 3 fixes, a span under 120s,
    or no segment surviving the same gating ``_segment_speeds_kn`` applies).
    Otherwise returns the mean/std heading and speed, the projection origin
    (the most recent fix), a GeoJSON cone polygon, and ETA to any chokepoint
    whose centre lies within the cone's heading fan, sorted by ETA.
    """
    if chokepoints is None:
        # Local import: avoids an intel-module -> routes-module import at load time.
        from app.routes.oceans import _CHOKEPOINTS  # noqa: PLC0415

        chokepoints = _CHOKEPOINTS

    if len(points) < _MIN_FIXES:
        return _insufficient(f"only {len(points)} fix(es); need >={_MIN_FIXES}")

    # project()'s public signature is (lon, lat, t); the pol.py helpers this
    # reuses want (t, lon, lat) — convert once, time-ordered.
    tll = sorted(((t, lon, lat) for lon, lat, t in points), key=lambda p: p[0])

    span_s = tll[-1][0] - tll[0][0]
    if span_s < _MIN_SPAN_S:
        return _insufficient(f"track spans {span_s:.0f}s; need >={_MIN_SPAN_S:.0f}s")

    speeds_kn = _segment_speeds_kn(tll)
    headings_deg = _headings(tll)
    if not speeds_kn and not headings_deg:
        return _insufficient(
            "no consecutive fixes survive the >=30s / plausible-speed gate; "
            "track too noisy or too tightly sampled to extrapolate"
        )

    mean_kn, sd_kn = _mean_std(speeds_kn)
    mean_hdg, sd_hdg = _circular_mean_std_deg(headings_deg)

    origin_t, origin_lon, origin_lat = tll[-1]
    h_hours = horizon_s / 3600.0

    half_fan = max(_MIN_HALF_FAN_DEG, min(_MAX_HALF_FAN_DEG, 2.0 * sd_hdg))
    bearing_lo = mean_hdg - half_fan
    bearing_hi = mean_hdg + half_fan

    r_min_nm = max(0.0, (mean_kn - 2.0 * sd_kn) * h_hours)
    r_max_nm = max((mean_kn + 2.0 * sd_kn) * h_hours, r_min_nm + _MIN_RANGE_SPREAD_NM)

    cone = _sector_polygon(origin_lon, origin_lat, bearing_lo, bearing_hi, r_min_nm, r_max_nm)

    eta: list[dict[str, Any]] = []
    if mean_kn > 0:
        for name, _lomin, _lamin, _lomax, _lamax, clon, clat in chokepoints:
            bearing = _bearing_deg(origin_lon, origin_lat, clon, clat)
            bearing_adj = _normalize_near(bearing, mean_hdg)
            if not (bearing_lo <= bearing_adj <= bearing_hi):
                continue
            dist_nm = haversine_km(origin_lon, origin_lat, clon, clat) / NM_TO_KM
            eta.append(
                {
                    "name": name,
                    "eta_s": round((dist_nm / mean_kn) * 3600.0, 1),
                    "bearing_deg": round(bearing, 1),
                    "in_cone": r_min_nm <= dist_nm <= r_max_nm,
                }
            )
        eta.sort(key=lambda e: e["eta_s"])

    return {
        "status": "ok",
        "mean_kn": round(mean_kn, 2),
        "sd_kn": round(sd_kn, 2),
        "mean_hdg": round(mean_hdg, 1),
        "sd_hdg": round(sd_hdg, 1),
        "origin": [round(origin_lon, 6), round(origin_lat, 6), origin_t],
        "cone": cone,
        "eta": eta,
        "params": {
            "horizon_s": horizon_s,
            "half_fan_deg": round(half_fan, 1),
            "r_min_nm": round(r_min_nm, 2),
            "r_max_nm": round(r_max_nm, 2),
            "fixes": len(points),
            "span_s": round(span_s, 1),
        },
        "note": (
            "Extrapolated from this contact's own recorded fixes (mean heading/"
            "speed +/- 2 std dev). Not a model; not a guarantee. See "
            "scripts/backtest_projection.py for the measured hit-rate."
        ),
    }


async def project_entity(
    entity_id: str,
    horizon_s: float,
    chokepoints: list[tuple[str, float, float, float, float, float, float]] | None = None,
) -> dict[str, Any]:
    """Load ``entity_id``'s recent track (``pol._load_track``'s own ~48h
    lookback) and project it forward. Convenience entry point mirroring
    ``pol.pattern_of_life`` for callers that want the default lookback rather
    than the route's caller-specified ``window_s``."""
    from app.intel.pol import _load_track  # noqa: PLC0415 — keep module import cheap

    t_lon_lat = await _load_track(entity_id)
    points = [(lon, lat, t) for t, lon, lat in t_lon_lat]
    return project(points, horizon_s, chokepoints=chokepoints)
