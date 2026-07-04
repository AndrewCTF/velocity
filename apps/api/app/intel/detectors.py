"""Behavioral detectors over position tracks — the Phase-2 rule primitives.

Pure functions over the track shape ``history.query_tracks`` already returns
(``{"id","kind","points":[[lon,lat,t,track], ...]}``, points ascending in ``t``),
so they're trivially unit-testable with synthetic tracks and carry no network or
DB dependency. ``intel/watch.py`` wires them into the evaluator loop + alert
firing; keeping the detection logic here keeps that integration thin.

Detectors return plain dicts (hits) the evaluator turns into ``_Candidate``s.
"""

from __future__ import annotations

import math
from typing import Any

_NM_PER_M = 1.0 / 1852.0

Track = dict[str, Any]
Bbox = tuple[float, float, float, float]  # (min_lon, min_lat, max_lon, max_lat)


def haversine_nm(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance in nautical miles."""
    r_m = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return (2 * r_m * math.asin(math.sqrt(a))) * _NM_PER_M


def _in_bbox(lon: float, lat: float, bbox: Bbox | None) -> bool:
    if bbox is None:
        return True
    min_lon, min_lat, max_lon, max_lat = bbox
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def ais_gap(
    tracks: list[Track],
    now: float,
    gap_seconds: float,
    aoi: Bbox | None = None,
) -> list[dict[str, Any]]:
    """Vessels that went dark: last fix older than ``gap_seconds`` while the last
    known position is inside ``aoi``.

    This is the dark-vessel / AIS-blindspot signal — a transponder that stops
    reporting inside a watched area is exactly the thing to tip a SAR look at
    (see ``intel/cue.py``). One hit per silent track.
    """
    hits: list[dict[str, Any]] = []
    for trk in tracks:
        pts = trk.get("points") or []
        if not pts:
            continue
        lon, lat, t = pts[-1][0], pts[-1][1], pts[-1][2]
        age = now - t
        if age >= gap_seconds and _in_bbox(lon, lat, aoi):
            hits.append(
                {
                    "id": trk.get("id"),
                    "kind": trk.get("kind", "vessel"),
                    "lon": lon,
                    "lat": lat,
                    "last_t": t,
                    "age_s": age,
                }
            )
    return hits


def proximity(
    tracks: list[Track],
    max_nm: float,
    aoi: Bbox | None = None,
) -> list[dict[str, Any]]:
    """Pairs of tracks whose latest fixes are within ``max_nm`` of each other —
    the rendezvous / ship-to-ship-transfer precursor.

    Point-in-time proximity on the most recent fix of each track. Dwell-time
    (sustained closeness over Y minutes) is a refinement layered in the evaluator
    using its enter/exit state.

    # ponytail: O(n^2) over tracks; callers bound it to an AOI. Add a spatial
    # grid only if a watch AOI ever holds thousands of simultaneous tracks.
    """
    recent: list[tuple[str, float, float]] = []
    for trk in tracks:
        pts = trk.get("points") or []
        if not pts:
            continue
        lon, lat = pts[-1][0], pts[-1][1]
        if _in_bbox(lon, lat, aoi):
            recent.append((trk.get("id"), lon, lat))

    hits: list[dict[str, Any]] = []
    for i in range(len(recent)):
        id_a, lon_a, lat_a = recent[i]
        for j in range(i + 1, len(recent)):
            id_b, lon_b, lat_b = recent[j]
            nm = haversine_nm(lon_a, lat_a, lon_b, lat_b)
            if nm <= max_nm:
                hits.append({"a": id_a, "b": id_b, "nm": round(nm, 3)})
    return hits


def loiter(
    track: Track,
    radius_nm: float,
    dwell_seconds: float,
    now: float,
) -> dict[str, Any] | None:
    """A single track that stayed within ``radius_nm`` of its recent centroid for
    at least ``dwell_seconds`` (anchoring / holding off a sensitive site).

    Considers only fixes within the trailing ``dwell_seconds`` window; returns a
    hit when that window is fully populated and every fix is within the radius of
    the window's centroid. ``None`` otherwise.
    """
    pts = [p for p in (track.get("points") or []) if now - p[2] <= dwell_seconds]
    if len(pts) < 2:
        return None
    if (now - pts[0][2]) < dwell_seconds * 0.9:  # window not yet covered
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    if all(haversine_nm(p[0], p[1], cx, cy) <= radius_nm for p in pts):
        return {"id": track.get("id"), "lon": cx, "lat": cy, "dwell_s": now - pts[0][2]}
    return None
