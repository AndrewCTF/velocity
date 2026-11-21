"""GET /api/overhead: the aircraft nearest a point, shaped for a microcontroller.

A desk display (ESP32, e-ink) polls this every few seconds and prints the
nearest few planes. The payload is a few hundred bytes of flat JSON, numbers
already rounded, null for anything the feed did not report, so ArduinoJson reads
it with a small fixed document. Walkthrough and a sketch: docs/desk-display.md.

It costs no upstream anything. It reads the in-memory snapshot the refresher
already keeps (``global_snapshot()``) and makes no HTTP request of its own, so
ten displays polling every ten seconds add no aggregator load. It does not call
``note_demand()`` either: a poller must not pin the refresher at its 1 s cadence
(idle back-pressure in routes/adsb.py), and the 5 s idle cycle is ample for a
10 s poll.

What is listed, and why that is narrower than the globe:

- Airborne only. A parked airliner 3 km away is not "overhead", and near an
  airport dozens of them would fill the whole list.
- Live fixes only. Age is ``now - (seen_at - seen_pos_s)``, the one stamp that is
  comparable across tiers (apps/api/CLAUDE.md), never raw ``seen_pos_s``. A fix
  older than the globe's own "live" line, ``_FRESH_POS_S``, is left out: the
  globe keeps such a contact and dims it, a text list cannot dim, and a plane
  that was 25 km away two minutes ago is not overhead now. An unknown age is
  kept and reported as null, the same rule ``_pos_stale`` applies.
  docs/desk-display.md quotes the 120 s, so change both together.
- An empty answer from a snapshot that has stopped refreshing is a 503, not an
  empty list. "Nothing overhead" and "feed down" must not look the same on a
  screen nobody is watching.
"""

from __future__ import annotations

import math
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.intel.geo import feature_lonlat, haversine_km
from app.routes import adsb as adsb_routes

router = APIRouter(tags=["overhead"])

# The snapshot stores speed as m/s = knots * 0.514444 (adsb._to_ms) and altitude
# as metres = feet * 0.3048. Invert with the same factors so a value that
# arrived as 36000 ft / 450 kt leaves as exactly that.
_MS_PER_KT = 0.514444
_M_PER_FT = 0.3048

# Latitude pre-filter. Two points are never closer on a sphere than their
# latitude difference measured along a meridian, so |dlat| * km_per_degree >
# radius rules a contact out without a trig call. It never looks at longitude,
# so it holds across the antimeridian and over the poles. 110 sits below the true
# 111.19 km on purpose: it stays a safe lower bound whatever radius haversine_km
# uses, and a safe bound can only let extra contacts through to the exact test.
_KM_PER_DEG_LAT = 110.0


class OverheadAircraft(BaseModel):
    """One aircraft. A field the feed did not report is JSON null."""

    id: str  # lower-case ICAO24 hex ("4ca7b3"), not the internal "aircraft:" id
    callsign: str | None  # flight callsign, else registration
    type: str | None  # ICAO type designator ("A320")
    alt_ft: int | None  # barometric, geometric only if that is all there is
    gs_kt: int | None  # ground speed
    dist_km: float  # great-circle distance from the point
    bearing_deg: float  # compass bearing from the point to the aircraft, [0, 360)
    age_s: int | None  # how old the position fix is, at ``as_of``


class OverheadResponse(BaseModel):
    as_of: int  # server clock when the answer was built, epoch seconds
    center: tuple[float, float]  # [lat, lon], as requested
    radius_km: float
    aircraft: list[OverheadAircraft]  # nearest first


def _now() -> float:
    """Wall clock. One seam so tests can pin it; nothing else reads time here."""
    return time.time()


def _num(v: Any) -> float | None:
    """A finite real number, else None. A bool is a flag, not a quantity."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v) if math.isfinite(v) else None


def _bearing_deg(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Initial great-circle bearing from point 1 to point 2, in [0, 360).

    lon-first like ``haversine_km`` and ``feature_lonlat``, so the call sites
    line up. geo.py has no bearing helper; the two private ones elsewhere
    (intel/project.py, adsb_heatmap.py) disagree on argument order.
    """
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def _callsign(v: Any) -> str | None:
    """The callsign, or None when it carries no letter or digit.

    Some feeds send a blank callsign as "@@@@@@@@"; printing that is a value the
    feed never really reported. adsb.py applies the same test (an all-'@'
    callsign is no callsign).
    """
    if not isinstance(v, str):
        return None
    s = v.strip()
    return s if any(c.isalnum() for c in s) else None


def _alt_ft(props: dict[str, Any]) -> int | None:
    # props, not geometry[2]: the geometry altitude falls back to 0 when unknown,
    # and "0 ft" is a claim. baro_alt_m is None when the feed gave no altitude.
    for key in ("baro_alt_m", "geo_alt_m"):
        m = _num(props.get(key))
        if m is not None:
            return round(m / _M_PER_FT)
    return None


def _gs_kt(props: dict[str, Any]) -> int | None:
    ms = _num(props.get("velocity_ms"))
    return None if ms is None else round(ms / _MS_PER_KT)


def _nearest(
    features: list[dict[str, Any]],
    lat: float,
    lon: float,
    radius_km: float,
    limit: int,
    now: float,
) -> list[OverheadAircraft]:
    """The ``limit`` nearest live, airborne aircraft within ``radius_km``.

    Pure over plain dicts and no I/O. Runs inline: measured 2.6-4.4 ms p50 over a
    17 000-contact snapshot (max 7 ms), well under the copy ``global_snapshot()``
    already makes, so a thread hop would cost more than it saves.
    """
    fresh_s = adsb_routes._FRESH_POS_S
    hits: list[tuple[float, str, dict[str, Any], float | None, float]] = []
    for f in features:
        lonlat = feature_lonlat(f)
        if lonlat is None:
            continue
        flon, flat = lonlat
        # One corrupt record must not take the endpoint down for every display:
        # math.sin(inf) raises, and every `>` test below is False for a NaN, so
        # it would be treated as in range.
        if not math.isfinite(flat + flon):
            continue
        if abs(flat - lat) * _KM_PER_DEG_LAT > radius_km:
            continue
        props = f.get("properties") or {}
        if props.get("on_ground"):
            continue
        obs = adsb_routes._feat_obs_at(f)
        age = None if obs is None else max(0.0, now - obs)
        if age is not None and age > fresh_s:
            continue
        dist = haversine_km(lon, lat, flon, flat)
        if dist > radius_km:
            continue
        ident = str(props.get("icao24") or "").lower()
        if not ident:
            ident = str(f.get("id") or "").removeprefix("aircraft:").lower()
        if not ident:
            continue
        hits.append((dist, ident, props, age, _bearing_deg(lon, lat, flon, flat)))

    # Ties broken by id so two contacts at one spot keep a stable order.
    hits.sort(key=lambda h: (h[0], h[1]))
    return [
        OverheadAircraft(
            id=ident,
            callsign=_callsign(props.get("callsign")),
            type=props.get("type") if isinstance(props.get("type"), str) else None,
            alt_ft=_alt_ft(props),
            gs_kt=_gs_kt(props),
            dist_km=round(dist, 1),
            # round() first, then wrap: 359.96 rounds to 360.0, which is not a bearing.
            bearing_deg=round(bearing, 1) % 360.0,
            age_s=None if age is None else round(age),
        )
        for dist, ident, props, age, bearing in hits[:limit]
    ]


@router.get("/api/overhead")
async def overhead(
    lat: float = Query(..., ge=-90, le=90, description="Your latitude, decimal degrees."),
    lon: float = Query(..., ge=-180, le=180, description="Your longitude, decimal degrees."),
    radius_km: float = Query(25.0, ge=1, le=250, description="Search radius in km."),
    limit: int = Query(5, ge=1, le=20, description="Most aircraft to return, nearest first."),
) -> OverheadResponse:
    """The aircraft nearest ``lat``/``lon``, nearest first, as small flat JSON."""
    # The plain snapshot helper, looked up through the module at call time. Never
    # the adsb route handler: its unresolved Query() defaults 500 in-process.
    snap = await adsb_routes.global_snapshot()
    now = _now()
    rows = _nearest(snap.get("features") or [], lat, lon, radius_km, limit, now)
    if not rows:
        age = adsb_routes.snapshot_age_s()
        if age is None or age > adsb_routes._SNAPSHOT_STALE_S:
            raise HTTPException(status_code=503, detail="aircraft feed is not live")
    return OverheadResponse(
        as_of=int(now), center=(lat, lon), radius_km=radius_km, aircraft=rows
    )
