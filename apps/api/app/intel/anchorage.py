"""Densest anchored-vessel cluster in a box: the seed of a detected situation.

Promoted from the Gotham situation copy (gotham/gotham/_situation_data.py): an
"incident" there was the densest cluster of hulls at anchor inside the view. The
input is the parked-vessel snapshot (SOG under the parked threshold), so this is
a pure function over GeoJSON features and makes no claim beyond "these hulls are
stationary together right now".
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

from app.ais_pipeline.store import haversine_km


def densest_cluster(
    features: list[dict[str, Any]],
    bbox: tuple[float, float, float, float],
    r_km: float = 10.0,
) -> dict[str, Any] | None:
    """The point with the most neighbours within ``r_km``, and those neighbours.

    Grid-bucketed so a box holding thousands of parked hulls stays linear-ish:
    only the 3x3 cells around a point can hold a neighbour.
    """
    w, s, e, n = bbox
    pts: list[tuple[float, float, dict[str, Any]]] = []
    for f in features:
        c = (f.get("geometry") or {}).get("coordinates") or []
        if len(c) < 2:
            continue
        lon, lat = float(c[0]), float(c[1])
        if w <= lon <= e and s <= lat <= n:
            pts.append((lon, lat, f))
    if not pts:
        return None

    cell_lat = r_km / 111.32
    # Widest longitude cell over the box, so a cell is never narrower than r_km.
    cell_lon = r_km / (111.32 * max(0.05, math.cos(math.radians(max(abs(s), abs(n))))))
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    keys = []
    for i, (lon, lat, _) in enumerate(pts):
        k = (math.floor(lon / cell_lon), math.floor(lat / cell_lat))
        grid[k].append(i)
        keys.append(k)

    def neighbours(i: int) -> list[int]:
        lon, lat, _ = pts[i]
        kx, ky = keys[i]
        return [
            j
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for j in grid.get((kx + dx, ky + dy), ())
            if haversine_km(lat, lon, pts[j][1], pts[j][0]) <= r_km
        ]

    best = max(range(len(pts)), key=lambda i: len(neighbours(i)))
    members = neighbours(best)
    clon = sum(pts[j][0] for j in members) / len(members)
    clat = sum(pts[j][1] for j in members) / len(members)
    return {
        "lon": clon,
        "lat": clat,
        "r_km": r_km,
        "n": len(members),
        "members": [pts[j][2] for j in members],
    }
