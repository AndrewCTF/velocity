"""Entity pattern-of-life dossiers.

Assembles everything the warm store knows about ONE contact — a vessel (MMSI) or
aircraft (ICAO24) — into a single read: its recent track, AIS/ADS-B gaps, a
derived speed profile (loiter vs transit vs dash), the area it has covered, and
which live incidents it currently appears in. The track window is bounded by the
observation store's retention (~1h, single-process Phase 1) — stated honestly in
the response rather than implied to be a full history.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from app.correlate.store import store
from app.correlate.types import Observation
from app.intel import incidents
from app.intel.geo import bbox_from_radius, haversine_km, vessel_category

_RETENTION_S = 3600.0
_GAP_S = 600.0          # >10 min between fixes counts as a track gap
_MIN_DT_FOR_SPEED = 30.0  # ignore sub-30s deltas for speed (GPS jitter blows up)
_KM_S_TO_KN = 1943.84


def _track(entity_id: str, kind: str) -> list[Observation]:
    pts = [o for o in store.window(_RETENTION_S, {kind}) if o.id == entity_id]
    pts.sort(key=lambda o: o.t)
    return pts


def _track_stats(pts: list[Observation]) -> dict[str, Any]:
    gaps: list[dict[str, Any]] = []
    seg_speeds_kn: list[float] = []
    dist_km = 0.0
    lons = [p.lon for p in pts]
    lats = [p.lat for p in pts]
    for a, b in zip(pts, pts[1:], strict=False):
        dt = b.t - a.t
        d = haversine_km(a.lon, a.lat, b.lon, b.lat)
        dist_km += d
        if dt > _GAP_S:
            gaps.append({
                "start": int(a.t), "end": int(b.t), "minutes": round(dt / 60, 1),
                "lon": round(a.lon, 4), "lat": round(a.lat, 4),
            })
        # Per-segment speed (for the max / dash detection) only from segments
        # long enough that GPS jitter doesn't blow it up.
        if dt >= _MIN_DT_FOR_SPEED:
            seg_speeds_kn.append((d / dt) * _KM_S_TO_KN)
    # Net speed = straight-line DISPLACEMENT / total time, not cumulative path:
    # immune to the path-length inflation that per-fix GPS jitter causes under
    # the fast ingest cadence, and it cleanly separates transit (displacement ≈
    # path) from loiter (displacement ≪ path → low net speed even if it wiggled).
    total_t = pts[-1].t - pts[0].t if len(pts) > 1 else 0.0
    disp_km = (
        haversine_km(pts[0].lon, pts[0].lat, pts[-1].lon, pts[-1].lat) if len(pts) > 1 else 0.0
    )
    avg_kn = round((disp_km / total_t) * _KM_S_TO_KN, 1) if total_t > 0 else None
    max_kn = round(max(seg_speeds_kn), 1) if seg_speeds_kn else avg_kn
    # Only label a profile once the track is long enough to be meaningful. The
    # global ADS-B snapshot repeats an aircraft's last position until a fresh
    # upstream fix arrives (~10-30 s for the OpenSky-cached tier), so a track
    # spanning a few seconds has ~zero displacement and must NOT be called
    # "loitering" — it's just too short to judge.
    if total_t < 60 or avg_kn is None:
        profile = "insufficient track"
    elif avg_kn < 2 and (max_kn or 0) < 5:
        profile = "loitering / stationary"
    elif (max_kn or 0) > 25 and avg_kn < (max_kn or 0) * 0.6:
        profile = "loiter-then-dash"
    else:
        profile = "transiting"
    return {
        "fixes": len(pts),
        "track_minutes": round((pts[-1].t - pts[0].t) / 60, 1) if len(pts) > 1 else 0.0,
        "distance_km": round(dist_km, 1),
        "speed_kn": {"avg": avg_kn, "max": max_kn},
        "profile": profile,
        "gaps": gaps,
        "gap_count": len(gaps),
        "bbox": (
            {"min_lon": round(min(lons), 4), "min_lat": round(min(lats), 4),
             "max_lon": round(max(lons), 4), "max_lat": round(max(lats), 4)}
            if pts else None
        ),
    }


async def _incident_membership(
    lon: float, lat: float, match: Callable[[dict[str, Any]], bool]
) -> list[dict[str, Any]]:
    b = await incidents.brief(bbox_from_radius(lat, lon, 120.0), link_km=50.0)
    hits: list[dict[str, Any]] = []
    for inc in b.get("incidents", []):
        for e in inc.get("evidence", []):
            if match(e.get("ref") or {}):
                hits.append({
                    "threat_level": inc["threat_level"],
                    "domains": inc["domains"],
                    "narrative": inc["narrative"],
                })
                break
    return hits


async def vessel_dossier(mmsi: str) -> dict[str, Any]:
    eid = f"vessel:{mmsi}"
    pts = _track(eid, "vessel")
    if not pts:
        return {"found": False, "mmsi": mmsi,
                "note": "No fix in the store's ~1h retention window."}
    last = pts[-1]
    a = last.attrs or {}
    stats = _track_stats(pts)
    in_incidents = await _incident_membership(
        last.lon, last.lat, lambda r: str(r.get("mmsi")) == str(mmsi)
    )

    assessment = "nominal"
    if stats["gap_count"] and stats["profile"] == "loiter-then-dash":
        assessment = "loiter-then-dash with AIS gaps — shadow-fleet / STS pattern"
    elif stats["gap_count"]:
        assessment = f"{stats['gap_count']} AIS gap(s) in the last hour"
    if in_incidents:
        assessment = f"appears in {len(in_incidents)} live incident(s); " + assessment

    return {
        "found": True,
        "mmsi": mmsi,
        "name": a.get("name"),
        "category": vessel_category(a.get("shipType")),
        "ship_type": a.get("shipType"),
        "last_fix": {"lon": round(last.lon, 4), "lat": round(last.lat, 4),
                     "t": int(last.t), "age_s": int(time.time() - last.t),
                     "sog": a.get("sog"), "cog": a.get("cog"), "source": last.source},
        "track": stats,
        "in_incidents": in_incidents,
        "assessment": assessment,
        "window_note": "Track is the store's ~1h retention; older history is not kept server-side.",
    }


async def aircraft_dossier(ident: str) -> dict[str, Any]:
    needle = ident.strip().lower()
    eid = f"aircraft:{needle}"
    pts = _track(eid, "aircraft")
    if not pts:
        # callsign? scan the window for a matching callsign.
        for o in store.window(_RETENTION_S, {"aircraft"}):
            if needle in str((o.attrs or {}).get("callsign") or "").lower():
                eid = o.id
                pts = _track(eid, "aircraft")
                break
    if not pts:
        return {"found": False, "query": ident,
                "note": "No fix in the store's ~1h retention window."}
    last = pts[-1]
    a = last.attrs or {}
    stats = _track_stats(pts)
    icao = (a.get("icao24") or eid.split(":", 1)[-1])
    in_incidents = await _incident_membership(
        last.lon, last.lat, lambda r: str(r.get("icao24") or "").lower() == str(icao).lower()
    )

    degraded = False
    try:
        degraded = (a.get("nac_p") is not None and int(a.get("nac_p")) < 8) or (
            a.get("nic") is not None and int(a.get("nic")) < 7
        )
    except (TypeError, ValueError):
        degraded = False
    squawk = a.get("squawk")
    assessment = "nominal"
    if str(squawk) in ("7500", "7600", "7700"):
        assessment = f"EMERGENCY squawk {squawk}"
    elif degraded:
        assessment = "GNSS degraded — possible jamming/spoofing footprint"
    if a.get("source") == "adsb_mil":
        assessment = "military contact; " + assessment
    if in_incidents:
        assessment = f"appears in {len(in_incidents)} live incident(s); " + assessment

    return {
        "found": True,
        "icao24": icao,
        "callsign": a.get("callsign"),
        "squawk": squawk,
        "source": last.source,
        "gnss_degraded": degraded,
        "last_fix": {"lon": round(last.lon, 4), "lat": round(last.lat, 4),
                     "t": int(last.t), "age_s": int(time.time() - last.t)},
        "track": stats,
        "in_incidents": in_incidents,
        "assessment": assessment,
        "window_note": "Track is the store's ~1h retention; full history is client-side.",
    }
