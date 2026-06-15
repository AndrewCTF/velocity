"""Denial & deception detection — "am I being fed?".

A hardened analyst trusts no raw feed. This module flags MANIPULATED tracks,
separately from the (already-handled) GPS *jamming* layer:

AIS:
  * duplicate-MMSI   — the same MMSI reported at two far-apart positions within
    a short interval (one identity, two hulls → spoof / identity theft).
  * teleport         — consecutive fixes for one MMSI imply an impossible speed
    (a jumped/injected position).

GPS / ADS-B:
  * spoof-cluster    — many DISTINCT aircraft reporting the SAME position (a
    spoofer broadcasting one false fix snaps receivers to a point). This is the
    GPS-SPOOFING signature, distinct from jamming (scattered degraded NACp).
  * kinematic        — an aircraft whose consecutive fixes imply an impossible
    ground speed (position injection / track break).

Findings are returned as compact records and fed into the incident brief under
the ``spoofing`` domain, so a convergence of spoofing + dark vessels + jamming
reads as the coordinated deception it usually is.
"""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from app.correlate.store import store
from app.intel.geo import BBox, feature_lonlat, haversine_km

# Impossible-speed thresholds (knots) over a real time delta.
_VESSEL_MAX_KN = 80.0       # a ship over ~80 kn is a bad/spoofed fix
_AIRCRAFT_MAX_KN = 1400.0   # > ~Mach 2 ground speed at airliner alt = injection
_KM_S_TO_KN = 1943.84
_MIN_DT_S = 20.0            # ignore sub-20s deltas (jitter)
_DUP_DT_S = 120.0           # two fixes within 2 min...
_DUP_MIN_KM = 50.0          # ...more than 50 km apart for one MMSI = duplicate id
_SPOOF_CLUSTER_MIN = 5      # >=5 distinct aircraft at one rounded position
_WINDOW_S = 900.0


def _in(bbox: BBox | None, lon: float, lat: float) -> bool:
    return bbox is None or bbox.contains(lon, lat)


def detect_ais(bbox: BBox | None) -> list[dict[str, Any]]:
    """Duplicate-MMSI and impossible-speed teleports over the vessel window."""
    by_mmsi: dict[str, list[Any]] = defaultdict(list)
    for o in store.window(_WINDOW_S, {"vessel"}):
        mmsi = (o.attrs or {}).get("mmsi")
        if mmsi is not None and _in(bbox, o.lon, o.lat):
            by_mmsi[str(mmsi)].append(o)

    out: list[dict[str, Any]] = []
    for mmsi, obs in by_mmsi.items():
        if len(obs) < 2:
            continue
        obs.sort(key=lambda o: o.t)
        for a, b in zip(obs, obs[1:], strict=False):
            dt = b.t - a.t
            d = haversine_km(a.lon, a.lat, b.lon, b.lat)
            if dt <= _DUP_DT_S and d >= _DUP_MIN_KM:
                out.append({
                    "type": "ais-duplicate-mmsi", "mmsi": mmsi, "severity": "high",
                    "lon": round(b.lon, 4), "lat": round(b.lat, 4),
                    "detail": f"MMSI {mmsi} at two positions {d:.0f} km apart within {dt:.0f}s",
                })
                break
            if dt >= _MIN_DT_S:
                kn = (d / dt) * _KM_S_TO_KN
                if kn > _VESSEL_MAX_KN:
                    out.append({
                        "type": "ais-teleport", "mmsi": mmsi, "severity": "medium",
                        "lon": round(b.lon, 4), "lat": round(b.lat, 4),
                        "detail": f"MMSI {mmsi} implied {kn:.0f} kn between fixes (impossible)",
                    })
                    break
    return out


def detect_gps(bbox: BBox | None, feats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Spoof-cluster (many aircraft, one position) + aircraft kinematic teleports."""
    out: list[dict[str, Any]] = []

    # Spoof-cluster: count DISTINCT icao24 reporting the same rounded position.
    pos_ac: dict[tuple[float, float], set[str]] = defaultdict(set)
    for f in feats:
        ll = feature_lonlat(f)
        if ll is None or not _in(bbox, ll[0], ll[1]):
            continue
        p = f.get("properties") or {}
        if p.get("on_ground"):
            continue
        key = (round(ll[0], 3), round(ll[1], 3))  # ~100 m bin
        icao = p.get("icao24")
        if icao:
            pos_ac[key].add(str(icao))
    for (lon, lat), icaos in pos_ac.items():
        if len(icaos) >= _SPOOF_CLUSTER_MIN:
            out.append({
                "type": "gps-spoof-cluster", "severity": "high",
                "lon": lon, "lat": lat, "count": len(icaos),
                "detail": f"{len(icaos)} distinct aircraft reporting the identical "
                          f"position {lat:.3f},{lon:.3f} — GPS spoofing footprint",
            })

    # Kinematic teleport from the aircraft store window.
    by_icao: dict[str, list[Any]] = defaultdict(list)
    for o in store.window(_WINDOW_S, {"aircraft"}):
        icao = (o.attrs or {}).get("icao24")
        if icao and _in(bbox, o.lon, o.lat):
            by_icao[str(icao)].append(o)
    for icao, obs in by_icao.items():
        if len(obs) < 2:
            continue
        obs.sort(key=lambda o: o.t)
        for a, b in zip(obs, obs[1:], strict=False):
            dt = b.t - a.t
            if dt < _MIN_DT_S:
                continue
            kn = (haversine_km(a.lon, a.lat, b.lon, b.lat) / dt) * _KM_S_TO_KN
            if kn > _AIRCRAFT_MAX_KN:
                out.append({
                    "type": "gps-kinematic", "icao24": icao, "severity": "medium",
                    "lon": round(b.lon, 4), "lat": round(b.lat, 4),
                    "detail": f"{icao} implied {kn:.0f} kn between fixes — position injection",
                })
                break
    return out


async def detect(bbox: BBox | None) -> dict[str, Any]:
    """Full deception sweep for an area (or global)."""
    from app.intel import analytics  # noqa: PLC0415

    feats = await analytics._snapshot()
    ais = detect_ais(bbox)
    gps = detect_gps(bbox, feats)
    findings = ais + gps
    by_type: dict[str, int] = defaultdict(int)
    for f in findings:
        by_type[f["type"]] += 1
    return {
        "generated_at": int(time.time()),
        "bbox": bbox.as_dict() if bbox else None,
        "finding_count": len(findings),
        "by_type": dict(by_type),
        "findings": findings[:100],
        "method": "AIS duplicate-MMSI/teleport + ADS-B spoof-cluster/kinematic; "
        "distinct from the GPS-jamming (degraded-NACp) layer.",
    }
