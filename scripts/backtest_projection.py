#!/usr/bin/env python3
"""Backtest for app.intel.project — measures the cone's real hit-rate.

Run this with the API DOWN. It opens ``data/history.db`` directly through the
same ``app.history`` module the API uses; a long-running reader held open
alongside a live writer is exactly the failure mode docs/decisions.md records
at the 2026-07-16 entry ("The coverage scan pinned the WAL: 49.6 GB of it") —
one open read transaction let the WAL grow to 49.6 GB for 15 GB of data.

Sampling is BOUNDED on purpose: candidate ids come from a single random
1-hour window inside the last ``--hours-back`` hours via
``history.query_tracks(kind=..., t_from, t_to, limit_ids=n)`` (an idx_t range
scan), never a ``SELECT DISTINCT id`` over the whole positions table
(docs/decisions.md:1776 records a 49.6 GB WAL from one long read). Each
candidate's own track is then a per-id idx_id_t range scan
(``history.query_track_by_id``), bounded to ``[cut - window_s, cut + horizon_s
+ 120]``.

For each candidate id: cut its track at a random ``cut`` inside the sampled
window, project() the pre-cut portion forward ``horizon_s``, and check whether
the real fix nearest ``cut + horizon_s`` (within +/-120s) falls inside the
projected cone. Prints a hit-rate table. No LLM anywhere in this path.

Usage (from the repo root, with the api venv, API stopped)::

    apps/api/.venv/bin/python scripts/backtest_projection.py \\
        --kind vessel --horizon 1800 --n 200 [--hours-back 24]
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import random
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))
os.environ.setdefault("OSINT_DISABLE_BACKGROUND", "1")

from app import history  # noqa: E402
from app.intel.geo import NM_TO_KM, haversine_km  # noqa: E402
from app.intel.project import _bearing_deg, project  # noqa: E402

# query_track_by_id's default LIMIT truncates the NEWEST fixes first (it's
# ORDER BY t ASC), so a per-id pull uses the same generous cap the route does.
_TRACK_LIMIT = 20_000
_CANDIDATE_WINDOW_S = 3600.0  # the "random 1-hour window" the brief specifies
_TRUTH_TOLERANCE_S = 120.0

try:
    from shapely.geometry import Point as _ShapelyPoint
    from shapely.geometry import Polygon as _ShapelyPolygon

    _HAVE_SHAPELY = True
except ImportError:  # pragma: no cover - environment-dependent
    _HAVE_SHAPELY = False


def _point_in_polygon_raycast(lon: float, lat: float, ring: list[list[float]]) -> bool:
    """Standard ray-cast point-in-polygon fallback when shapely isn't installed."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_at = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_at:
                inside = not inside
        j = i
    return inside


def _in_cone(lon: float, lat: float, cone: dict) -> bool:
    ring = cone["coordinates"][0]
    if _HAVE_SHAPELY:
        return _ShapelyPolygon(ring).contains(_ShapelyPoint(lon, lat))
    return _point_in_polygon_raycast(lon, lat, ring)


def _cross_track_nm(origin_lon: float, origin_lat: float, course_deg: float, lon: float, lat: float) -> float:
    """Perpendicular distance (nm) of (lon,lat) from the great-circle path
    starting at (origin_lon,origin_lat) on bearing ``course_deg`` — the
    standard aviation-formulary cross-track-distance formula."""
    r_km = 6371.0088
    d13 = haversine_km(origin_lon, origin_lat, lon, lat) / r_km  # angular distance, radians
    if d13 == 0:
        return 0.0
    bearing13 = math.radians(_bearing_deg(origin_lon, origin_lat, lon, lat))
    bearing12 = math.radians(course_deg)
    xtd_rad = math.asin(min(1.0, max(-1.0, math.sin(d13) * math.sin(bearing13 - bearing12))))
    return abs(xtd_rad * r_km) / NM_TO_KM


async def _newest_ts() -> float | None:
    """MAX(t) over the whole archive via the idx_t index — a single cheap
    aggregate lookup, not a scan."""
    loop = asyncio.get_running_loop()

    def q() -> float | None:
        con = history._read_connect()
        try:
            row = con.execute("SELECT MAX(t) FROM positions").fetchone()
        finally:
            con.close()
        return float(row[0]) if row and row[0] is not None else None

    return await loop.run_in_executor(None, q)


async def run(args: argparse.Namespace) -> None:
    newest = await _newest_ts()
    if newest is None:
        print("positions table is empty (or the DB path is wrong); nothing to backtest.")
        return

    hours_back_s = args.hours_back * 3600.0
    lo = max(0.0, newest - hours_back_s)
    hi = max(lo, newest - _CANDIDATE_WINDOW_S)
    rng = random.Random(args.seed)
    win_start = rng.uniform(lo, hi) if hi > lo else lo
    win_end = win_start + _CANDIDATE_WINDOW_S

    def fmt(t: float) -> str:
        return time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(t))

    print(f"newest recorded fix: {fmt(newest)}")
    print(f"candidate window:    {fmt(win_start)} .. {fmt(win_end)}  (kind={args.kind})")

    candidates = await history.query_tracks(
        kind=args.kind, bbox=None, t_from=win_start, t_to=win_end, limit_ids=args.n
    )
    ids = [t["id"] for t in candidates.get("tracks", [])]
    print(f"candidate ids in window: {len(ids)} (asked for up to {args.n})")
    if candidates.get("degraded"):
        print("warning: candidate query reported degraded=True (a DB error, not an empty window).")

    n_tested = 0
    n_insufficient = 0
    n_no_truth = 0
    n_hit = 0
    n_truncated = 0
    cross_track_nm: list[float] = []

    for eid in ids:
        cut = rng.uniform(win_start, win_end)
        t_from = cut - args.window_s
        t_to = cut + args.horizon + _TRUTH_TOLERANCE_S
        result = await history.query_track_by_id(eid, t_from=t_from, t_to=t_to, limit=_TRACK_LIMIT)
        pts_all = result["tracks"][0]["points"] if result.get("tracks") else []
        if len(pts_all) == _TRACK_LIMIT:
            n_truncated += 1

        pre = [(lon, lat, t) for lon, lat, t, _track in pts_all if t <= cut]
        target_t = cut + args.horizon
        truth_candidates = [
            (lon, lat, t) for lon, lat, t, _track in pts_all if abs(t - target_t) <= _TRUTH_TOLERANCE_S
        ]
        if not truth_candidates:
            n_no_truth += 1
            continue
        truth_lon, truth_lat, _truth_t = min(truth_candidates, key=lambda p: abs(p[2] - target_t))

        proj = project(pre, args.horizon)
        n_tested += 1
        if proj["status"] == "insufficient":
            n_insufficient += 1
            continue
        if _in_cone(truth_lon, truth_lat, proj["cone"]):
            n_hit += 1
        origin_lon, origin_lat, _origin_t = proj["origin"]
        cross_track_nm.append(_cross_track_nm(origin_lon, origin_lat, proj["mean_hdg"], truth_lon, truth_lat))

    scored = n_tested - n_insufficient
    hit_rate = (n_hit / scored) if scored else float("nan")
    median_cte = statistics.median(cross_track_nm) if cross_track_nm else float("nan")

    print()
    header = f"{'kind':<10}{'horizon_s':<11}{'n_tested':<10}{'n_insufficient':<16}{'n_no_truth':<12}{'hit_rate':<10}{'median_cte_nm':<14}"
    print(header)
    print(
        f"{args.kind:<10}{args.horizon:<11}{n_tested:<10}{n_insufficient:<16}"
        f"{n_no_truth:<12}{hit_rate:<10.3f}{median_cte:<14.2f}"
    )
    if n_truncated:
        print(
            f"warning: {n_truncated} track(s) hit the {_TRACK_LIMIT}-point per-id cap; "
            "a busy contact's window may have been cut short — shrink --window-s if this matters."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kind", choices=["vessel", "aircraft"], required=True)
    parser.add_argument("--horizon", type=int, default=1800, help="Projection horizon, seconds")
    parser.add_argument("--n", type=int, default=200, help="Candidate ids to sample from the 1h window")
    parser.add_argument("--hours-back", type=float, default=24.0, help="Look back this many hours from the newest fix")
    parser.add_argument(
        "--window-s", type=int, default=21_600, help="History window fed to project(), matches the route's default"
    )
    parser.add_argument("--seed", type=int, default=1234, help="RNG seed, for a reproducible sample")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
