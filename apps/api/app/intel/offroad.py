"""Off-road trafficability pathfinder — A* over a slope cost-surface.

War-zone use: when roads are broken or blocked, find the lowest-effort path
across open terrain. The cost surface is built from a KEYLESS global DEM (AWS
Terrain Tiles / Mapzen terrarium PNGs, Linux Foundation open data) — no key, no
account.

Honesty: this is a TRAFFICABILITY ESTIMATE, not a survey route. It keys off
slope + water only; it does not know surface (mud/sand/rubble), vegetation, or
real obstacles. The A* core here is pure and unit-tested; the tile fetch +
stitch is the network half.

ponytail: bbox- and grid-capped, 8-connected A*. Upgrade path = add landcover /
road-damage layers to the per-cell cost, and a finer grid, if the estimate is
too coarse.
"""

from __future__ import annotations

import heapq
import io
import math
from typing import Any

import numpy as np

# Terrarium decode: elevation_m = (R*256 + G + B/256) - 32768.
_TERRARIUM_OFFSET = 32768.0

# Grid + slope ceilings.
_MAX_GRID = 200  # A* cells per side (caps the 8-connected search)
_MAX_TILES_PER_SIDE = 4  # at most 4x4 terrarium tiles fetched per request
_DEFAULT_MAX_SLOPE = 0.6  # rise/run above this is impassable (~31°)
_SEA_LEVEL = 0.0  # cells strictly below this (negative bathymetry) are water


def decode_terrarium(png_bytes: bytes) -> np.ndarray:
    """Decode one terrarium PNG tile to a float32 elevation array (metres)."""
    from PIL import Image  # noqa: PLC0415 — heavy import, keep local

    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    arr = np.asarray(img, dtype=np.float32)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    return (r * 256.0 + g + b / 256.0) - _TERRARIUM_OFFSET


def _subsample(elev: np.ndarray, max_side: int = _MAX_GRID) -> np.ndarray:
    """Downsample an elevation grid so the longest side <= max_side (stride)."""
    h, w = elev.shape
    step = max(1, math.ceil(max(h, w) / max_side))
    return elev[::step, ::step]


def astar_grid(
    elev: np.ndarray,
    start_rc: tuple[int, int],
    goal_rc: tuple[int, int],
    meters_per_cell: float,
    *,
    max_slope: float = _DEFAULT_MAX_SLOPE,
    slope_weight: float = 6.0,
    allow_water: bool = False,
) -> tuple[list[tuple[int, int]], dict[str, Any]]:
    """8-connected A* over an elevation cost-surface (PURE — unit-tested).

    Cost to step from a→b = horizontal_distance * (1 + slope_weight*slope), with
    a hard block when slope exceeds max_slope or b is water. Returns (path_cells,
    stats); path is empty if no route exists.
    """
    h, w = elev.shape
    sr, sc = start_rc
    gr, gc = goal_rc

    def passable(r: int, c: int) -> bool:
        return not (not allow_water and elev[r, c] < _SEA_LEVEL)

    def heuristic(r: int, c: int) -> float:
        # Admissible: straight-line metres at the minimum per-metre cost (1.0).
        return math.hypot(r - gr, c - gc) * meters_per_cell

    open_heap: list[tuple[float, int, int]] = [(heuristic(sr, sc), sr, sc)]
    came: dict[tuple[int, int], tuple[int, int]] = {}
    gcost = np.full((h, w), np.inf, dtype=np.float64)
    gcost[sr, sc] = 0.0
    closed = np.zeros((h, w), dtype=bool)
    neighbors = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    expanded = 0

    while open_heap:
        _, r, c = heapq.heappop(open_heap)
        if closed[r, c]:
            continue
        closed[r, c] = True
        expanded += 1
        if (r, c) == (gr, gc):
            break
        for dr, dc in neighbors:
            nr, nc = r + dr, c + dc
            if nr < 0 or nr >= h or nc < 0 or nc >= w or closed[nr, nc]:
                continue
            if not passable(nr, nc):
                continue
            horiz = meters_per_cell * (math.sqrt(2) if dr and dc else 1.0)
            dz = float(elev[nr, nc] - elev[r, c])
            slope = abs(dz) / horiz
            if slope > max_slope:
                continue
            step = horiz * (1.0 + slope_weight * slope)
            ng = gcost[r, c] + step
            if ng < gcost[nr, nc]:
                gcost[nr, nc] = ng
                came[(nr, nc)] = (r, c)
                heapq.heappush(open_heap, (ng + heuristic(nr, nc), nr, nc))

    if not math.isfinite(gcost[gr, gc]):
        return [], {"expanded": expanded, "reachable": False}

    # Reconstruct.
    path: list[tuple[int, int]] = [(gr, gc)]
    cur = (gr, gc)
    while cur != (sr, sc):
        cur = came[cur]
        path.append(cur)
    path.reverse()

    climb = 0.0
    for (r0, c0), (r1, c1) in zip(path, path[1:], strict=False):
        dz = float(elev[r1, c1] - elev[r0, c0])
        if dz > 0:
            climb += dz
    return path, {
        "expanded": expanded,
        "reachable": True,
        "cost": float(gcost[gr, gc]),
        "climb_m": round(climb, 1),
        "cells": len(path),
    }


# ── tile math + orchestration (network half) ─────────────────────────────────


def _lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def _tile_to_lonlat(x: float, y: float, z: int) -> tuple[float, float]:
    n = 2**z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def _pick_zoom(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> int:
    """Largest zoom whose tile span over the bbox stays <= _MAX_TILES_PER_SIDE."""
    for z in range(13, 5, -1):
        x0, y0 = _lonlat_to_tile(min_lon, max_lat, z)
        x1, y1 = _lonlat_to_tile(max_lon, min_lat, z)
        if (abs(x1 - x0) + 1) <= _MAX_TILES_PER_SIDE and (abs(y1 - y0) + 1) <= _MAX_TILES_PER_SIDE:
            return z
    return 6


async def plan_offroad(
    from_lat: float,
    from_lon: float,
    to_lat: float,
    to_lon: float,
) -> dict[str, Any]:
    """Plan an off-road path between two points over the keyless DEM.

    Returns a GeoJSON-ish dict {route: LineString coords, distance_km, climb_m,
    grid, source}. Raises ValueError if the points are too far apart for the
    capped grid (keep it tactical, not continental).
    """
    from app.upstream import get_client  # noqa: PLC0415

    min_lon, max_lon = min(from_lon, to_lon), max(from_lon, to_lon)
    min_lat, max_lat = min(from_lat, to_lat), max(from_lat, to_lat)
    # Pad ~20% so the path can bow outside the straight-line corridor.
    pad_lon = max(0.02, (max_lon - min_lon) * 0.2)
    pad_lat = max(0.02, (max_lat - min_lat) * 0.2)
    min_lon -= pad_lon
    max_lon += pad_lon
    min_lat -= pad_lat
    max_lat += pad_lat

    z = _pick_zoom(min_lon, min_lat, max_lon, max_lat)
    x0, y0 = _lonlat_to_tile(min_lon, max_lat, z)
    x1, y1 = _lonlat_to_tile(max_lon, min_lat, z)
    xs = list(range(min(x0, x1), max(x0, x1) + 1))
    ys = list(range(min(y0, y1), max(y0, y1) + 1))
    if len(xs) > _MAX_TILES_PER_SIDE or len(ys) > _MAX_TILES_PER_SIDE:
        raise ValueError("points too far apart for off-road planning (tactical range only)")

    client = get_client()
    rows: list[np.ndarray] = []
    for ty in ys:
        cols: list[np.ndarray] = []
        for tx in xs:
            url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png"
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                raise ValueError(f"DEM tile {z}/{tx}/{ty} -> {r.status_code}")
            cols.append(decode_terrarium(r.content))
        rows.append(np.hstack(cols))
    elev = np.vstack(rows)
    elev = _subsample(elev)

    # Geo extents of the stitched mosaic (NW corner of first tile → SE of last).
    nw_lon, nw_lat = _tile_to_lonlat(xs[0], ys[0], z)
    se_lon, se_lat = _tile_to_lonlat(xs[-1] + 1, ys[-1] + 1, z)
    h, w = elev.shape

    def to_rc(lat: float, lon: float) -> tuple[int, int]:
        fc = (lon - nw_lon) / (se_lon - nw_lon)
        fr = (lat - nw_lat) / (se_lat - nw_lat)
        c = int(min(w - 1, max(0, round(fc * (w - 1)))))
        r = int(min(h - 1, max(0, round(fr * (h - 1)))))
        return r, c

    def to_lonlat(r: int, c: int) -> tuple[float, float]:
        lon = nw_lon + (c / (w - 1)) * (se_lon - nw_lon)
        lat = nw_lat + (r / (h - 1)) * (se_lat - nw_lat)
        return lon, lat

    # Metres per cell from the mosaic's mid-latitude span.
    mid_lat = (nw_lat + se_lat) / 2
    span_m = abs(se_lat - nw_lat) * 110_574
    meters_per_cell = span_m / max(1, h)

    start = to_rc(from_lat, from_lon)
    goal = to_rc(to_lat, to_lon)
    path, stats = astar_grid(elev, start, goal, meters_per_cell)
    if not path:
        return {
            "route": [], "reachable": False, "grid": [h, w],
            "source": "AWS Terrain Tiles (terrarium)",
        }

    coords = [list(to_lonlat(r, c)) for r, c in path]
    # Path length in metres (haversine-ish on the small mosaic).
    dist_m = 0.0
    for (lo0, la0), (lo1, la1) in zip(coords, coords[1:], strict=False):
        dlat = (la1 - la0) * 110_574
        dlon = (lo1 - lo0) * 111_320 * math.cos(math.radians(mid_lat))
        dist_m += math.hypot(dlat, dlon)
    return {
        "route": coords,
        "reachable": True,
        "distance_km": round(dist_m / 1000, 2),
        "climb_m": stats.get("climb_m", 0.0),
        "grid": [h, w],
        "zoom": z,
        "source": "AWS Terrain Tiles (terrarium, keyless)",
        "note": "Trafficability estimate from slope + water only — not a surveyed route.",
    }
