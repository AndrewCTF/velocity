"""Per-entity pattern-of-life analytics — a *behavioral* baseline.

Where ``baseline.py`` answers "is this AREA normal?" (a rolling z-score over
area metrics — vessel/dark/jamming/military counts, no geometry), this module
answers "is this ENTITY behaving normally?" from its own movement history:

* **Recurring places** — a small self-contained DBSCAN over the track's fixes
  (projected to local metres) finds the spots the entity keeps returning to:
  home base, a patrol box, a loiter point, a port. Each cluster carries its
  centroid, how many separate *visits* it saw, and the dwell time accrued there.
* **Dwell / variance stats** — total dwell vs transit, the spread of each
  recurring place, the share of the track spent inside a known cluster.
* **Anomaly-vs-baseline score** — once a baseline of recurring places exists,
  the freshest fixes are scored against it: a fix far from every known cluster,
  or an unusually fast/long excursion, lifts the score. Low score = the entity
  is doing what it always does; high score = it broke pattern.

Everything is computed from ``app.history.query_tracks`` (read-only — this
module never writes the positions DB) plus an optional caller-supplied track,
so it is pure and unit-testable on synthetic fixes with no network.

DBSCAN here is deliberately tiny and self-contained (no scikit-learn): a single
ε-radius region-query over a numpy distance computation, O(n²) in the number of
fixes. A pattern-of-life track is bounded (``history`` caps points-per-id), so
n²–on-a-few-hundred-points is trivial and avoids pulling a heavy clustering dep
into a service whose only existing numeric dep is numpy.
"""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np

from app import history
from app.intel.geo import haversine_km

# ── tunable constants ──────────────────────────────────────────────────────────
# How far back we read the positions DB for one entity. Bounded by the DB's own
# retention (history_retention_hours) — this just says "give me what's kept".
_DB_LOOKBACK_S: float = 48.0 * 3600.0

# DBSCAN spatial parameters. ε is the neighbourhood radius in METRES (recurring
# places are co-located to within a few hundred m — a loiter box, a berth, a
# pattern hold), min_samples the density floor for a core point. A track sampled
# every few seconds dwelling at a place yields many fixes there, so a modest
# min_samples cleanly separates a real dwell from transit fixes passing through.
_EPS_M: float = 500.0
_MIN_SAMPLES: int = 4

# A run of consecutive in-cluster fixes is one "visit"; a gap longer than this
# (the entity left and came back) starts a new visit at the same place.
_VISIT_BREAK_S: float = 600.0  # 10 min

# Speed gating mirrors dossier.py so the two modules agree on what a real segment
# is (a sub-30s cross-source desync computes to a bogus >1000 kn).
_MIN_SEG_DT_S: float = 30.0
_MAX_PLAUSIBLE_KN: float = 1000.0
_KM_S_TO_KN: float = 1943.84

# Anomaly scoring: an excursion whose distance from the nearest known cluster
# exceeds this many cluster-radii reads as "off pattern". Kept in radii (not a
# fixed km) so a wide patrol box and a tight berth scale their own tolerance.
_OFF_PATTERN_RADII: float = 3.0
_MIN_FIXES: int = 8  # below this the track is too short to baseline honestly


# ── geometry helpers ────────────────────────────────────────────────────────────

def _project_m(
    lons: np.ndarray, lats: np.ndarray, lat0: float
) -> np.ndarray:
    """Equirectangular projection to local metres about ``lat0``.

    Pattern-of-life clusters span at most a chokepoint/patrol box (tens of km),
    where the flat-earth error of an equirectangular projection is negligible
    and it keeps DBSCAN's distance maths in cheap Euclidean metres. Returns an
    (n, 2) array of (east, north) metres.
    """
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * math.cos(math.radians(lat0))
    east = (lons - lons.mean()) * m_per_deg_lon
    north = (lats - lats.mean()) * m_per_deg_lat
    return np.column_stack([east, north])


def _mean_std(vals: list[float] | np.ndarray) -> tuple[float, float]:
    """Population mean + std, same convention as ``baseline.BaselineStore._stats``
    (divide by n, not n-1). Pattern-of-life and the area baseline both want the
    spread of the sample they actually hold, not an unbiased estimator of a
    larger population. Returns (0, 0) for an empty input."""
    a = np.asarray(vals, dtype=np.float64)
    if a.size == 0:
        return 0.0, 0.0
    mean = float(a.mean())
    return mean, float(math.sqrt(float(((a - mean) ** 2).mean())))


# ── self-contained DBSCAN ────────────────────────────────────────────────────────

def _dbscan(points_m: np.ndarray, eps_m: float, min_samples: int) -> np.ndarray:
    """Density-based clustering. Returns an int label per point: -1 = noise,
    0..k-1 = cluster id.

    A textbook DBSCAN with an O(n²) region query (a full pairwise distance
    matrix). For the few-hundred-point tracks this serves that is instant; it
    avoids a scikit-learn dependency for one small routine. Deterministic: points
    are visited in index order, so the same input always yields the same labels.
    """
    n = points_m.shape[0]
    labels = np.full(n, -1, dtype=np.int64)
    if n == 0:
        return labels
    # Pairwise squared distances (symmetric); compare against eps² to avoid sqrt.
    diff = points_m[:, None, :] - points_m[None, :, :]
    d2 = np.einsum("ijk,ijk->ij", diff, diff)
    eps2 = eps_m * eps_m
    neighbours = d2 <= eps2  # (n, n) boolean adjacency

    visited = np.zeros(n, dtype=bool)
    cluster = 0
    for i in range(n):
        if visited[i]:
            continue
        visited[i] = True
        nbrs = np.flatnonzero(neighbours[i])
        if nbrs.size < min_samples:
            continue  # not a core point (yet) — leave as noise
        # Grow the cluster (BFS over density-reachable points).
        labels[i] = cluster
        seeds = list(nbrs)
        k = 0
        while k < len(seeds):
            j = int(seeds[k])
            k += 1
            if not visited[j]:
                visited[j] = True
                jn = np.flatnonzero(neighbours[j])
                if jn.size >= min_samples:
                    seeds.extend(int(x) for x in jn)
            if labels[j] == -1:
                labels[j] = cluster
        cluster += 1
    return labels


# ── track loading (read-only over history) ───────────────────────────────────────

def _track_sync(entity_id: str, t_from: float) -> list[tuple[float, float, float]]:
    """Read ONE entity's (t, lon, lat) fixes from the positions DB, time-ordered.

    ``history.query_tracks`` can only cap by a distinct-id count (it has no id
    filter), so for a single-entity lookup we run a tight id-scoped scan over
    history's own connection/schema (``history._connect``, hits the idx_id_t
    index) — reusing the DB plumbing read-only without touching any history
    signature. Sync; the caller wraps it for the event loop.
    """
    con = history._connect()
    try:
        rows = con.execute(
            "SELECT t, lon, lat FROM positions WHERE id = ? AND t >= ? ORDER BY t",
            (entity_id, t_from),
        ).fetchall()
    finally:
        con.close()
    return [(float(t), float(lon), float(lat)) for t, lon, lat in rows]


async def _load_track(entity_id: str) -> list[tuple[float, float, float]]:
    """Pull this entity's historical fixes from the SQLite positions DB.

    Returns [] when history is disabled, empty, or errors — the caller then
    reports an honest "insufficient track" rather than crashing.
    """
    if not history.stats().get("enabled"):
        return []
    try:
        import asyncio  # noqa: PLC0415 — local import keeps module import cheap

        return await asyncio.to_thread(
            _track_sync, entity_id, time.time() - _DB_LOOKBACK_S
        )
    except Exception:  # noqa: BLE001 — a DB hiccup must not break the analytic
        return []


# ── cluster / dwell summarisation ────────────────────────────────────────────────

def _summarise_clusters(
    pts: list[tuple[float, float, float]], labels: np.ndarray
) -> list[dict[str, Any]]:
    """Roll each DBSCAN cluster up into a recurring-place record: centroid,
    spatial spread (radius), separate visits, and dwell time accrued there.

    A *visit* is a maximal run of consecutive in-cluster fixes; a time gap >
    ``_VISIT_BREAK_S`` (the entity left and returned) splits one place's fixes
    into multiple visits. Dwell is the summed span of each visit.
    """
    by_cluster: dict[int, list[int]] = {}
    for idx, lab in enumerate(labels):
        if lab >= 0:
            by_cluster.setdefault(int(lab), []).append(idx)

    out: list[dict[str, Any]] = []
    for idxs in by_cluster.values():
        idxs.sort()  # chronological (pts is time-ordered)
        lons = np.array([pts[i][1] for i in idxs])
        lats = np.array([pts[i][2] for i in idxs])
        c_lon, c_lat = float(lons.mean()), float(lats.mean())
        # Spread = RMS distance of member fixes from the centroid (km), and the
        # max member distance (the place's effective radius).
        dists_km = [haversine_km(c_lon, c_lat, lo, la) for lo, la in zip(lons, lats, strict=False)]
        rms_km = float(math.sqrt(sum(d * d for d in dists_km) / len(dists_km))) if dists_km else 0.0
        radius_km = max(dists_km) if dists_km else 0.0

        # Split into visits on time gaps and sum dwell.
        visits: list[tuple[float, float]] = []  # (start_t, end_t)
        run_start = pts[idxs[0]][0]
        prev_t = run_start
        for i in idxs[1:]:
            t = pts[i][0]
            if t - prev_t > _VISIT_BREAK_S:
                visits.append((run_start, prev_t))
                run_start = t
            prev_t = t
        visits.append((run_start, prev_t))
        dwell_s = sum(e - s for s, e in visits)

        out.append(
            {
                "centroid": {"lon": round(c_lon, 4), "lat": round(c_lat, 4)},
                "fixes": len(idxs),
                "visits": len(visits),
                "dwell_minutes": round(dwell_s / 60.0, 1),
                "radius_km": round(radius_km, 3),
                "spread_km": round(rms_km, 3),
                "first_seen": int(pts[idxs[0]][0]),
                "last_seen": int(pts[idxs[-1]][0]),
            }
        )
    # Rank recurring places by how much the entity uses them (visits, then dwell).
    out.sort(key=lambda c: (c["visits"], c["dwell_minutes"]), reverse=True)
    return out


def _segment_speeds_kn(pts: list[tuple[float, float, float]]) -> list[float]:
    """Per-segment ground speeds (kn) over time-ordered consecutive fixes, gated
    like ``dossier.py``: drop sub-30s deltas (cross-source desync) and physically
    impossible (>1000 kn) jumps so a single spoof can't define the profile."""
    speeds: list[float] = []
    for (ta, lo_a, la_a), (tb, lo_b, la_b) in zip(pts, pts[1:], strict=False):
        dt = tb - ta
        if dt < _MIN_SEG_DT_S:
            continue
        d_km = haversine_km(lo_a, la_a, lo_b, la_b)
        spd = (d_km / dt) * _KM_S_TO_KN
        if spd <= _MAX_PLAUSIBLE_KN:
            speeds.append(spd)
    return speeds


def _anomaly(
    pts: list[tuple[float, float, float]],
    labels: np.ndarray,
    clusters: list[dict[str, Any]],
) -> dict[str, Any]:
    """Score how far the recent behaviour departs from the recurring-place
    baseline. 0 = fully on-pattern; → 1 = strongly off-pattern.

    Two signals, combined (max — the worse one drives the score):
    * **Off-pattern share** — the fraction of fixes that DBSCAN left as noise
      (i.e. not inside any recurring place). A track that suddenly spends time
      somewhere new raises this.
    * **Excursion distance** — the newest fix's distance from the nearest known
      cluster, expressed in that cluster's own radii (so a wide patrol box and a
      tight berth each scale their own tolerance). Beyond ``_OFF_PATTERN_RADII``
      reads as a full break.
    """
    n = len(pts)
    noise = int(np.count_nonzero(labels < 0))
    off_share = noise / n if n else 0.0

    excursion_radii = 0.0
    if clusters:
        last_lon, last_lat = pts[-1][1], pts[-1][2]
        nearest_km = min(
            haversine_km(last_lon, last_lat, c["centroid"]["lon"], c["centroid"]["lat"])
            for c in clusters
        )
        # Tolerance = the matching cluster's radius (floored so a near-point
        # cluster still has a sane envelope), in radii.
        nearest = min(
            clusters,
            key=lambda c: haversine_km(
                last_lon, last_lat, c["centroid"]["lon"], c["centroid"]["lat"]
            ),
        )
        tol_km = max(nearest["radius_km"], _EPS_M / 1000.0)
        excursion_radii = nearest_km / tol_km

    excursion_score = min(1.0, excursion_radii / _OFF_PATTERN_RADII) if clusters else off_share
    score = max(off_share, excursion_score)

    if score >= 0.66:
        state = "off-pattern"
    elif score >= 0.33:
        state = "elevated"
    else:
        state = "on-pattern"
    return {
        "score": round(score, 2),
        "state": state,
        "off_pattern_share": round(off_share, 2),
        "excursion_radii": round(excursion_radii, 2),
    }


def _insufficient(entity_id: str, fixes: int) -> dict[str, Any]:
    return {
        "id": entity_id,
        "found": fixes > 0,
        "sufficient": False,
        "fixes": fixes,
        "note": (
            f"Only {fixes} fix(es) in the positions DB (need ≥{_MIN_FIXES}); "
            "too short to baseline a pattern of life. Baseline matures as the "
            "entity is tracked — it is not synthesised."
        ),
        "recurring_places": [],
        "dwell": {},
        "anomaly": {"score": 0.0, "state": "insufficient"},
    }


# ── public analytic ──────────────────────────────────────────────────────────────

def analyze_track(
    entity_id: str,
    pts: list[tuple[float, float, float]],
    *,
    eps_m: float = _EPS_M,
    min_samples: int = _MIN_SAMPLES,
) -> dict[str, Any]:
    """Compute the pattern-of-life summary for a pre-loaded ``(t, lon, lat)``
    track. Pure — no I/O — so tests drive it directly on synthetic fixes.

    Returns recurring places (clustered dwell points), dwell/variance stats, a
    movement profile, and an anomaly-vs-baseline score. Honest about short
    tracks: below ``_MIN_FIXES`` it reports ``sufficient: false`` rather than
    inventing a baseline from noise.
    """
    pts = sorted(pts, key=lambda p: p[0])
    if len(pts) < _MIN_FIXES:
        return _insufficient(entity_id, len(pts))

    lons = np.array([p[1] for p in pts], dtype=np.float64)
    lats = np.array([p[2] for p in pts], dtype=np.float64)
    lat0 = float(lats.mean())
    proj = _project_m(lons, lats, lat0)
    labels = _dbscan(proj, eps_m, min_samples)
    clusters = _summarise_clusters(pts, labels)

    # Dwell vs transit: dwell = time inside any recurring place; transit = the
    # rest of the observed span.
    total_s = pts[-1][0] - pts[0][0]
    dwell_s = sum(c["dwell_minutes"] for c in clusters) * 60.0
    dwell_s = min(dwell_s, total_s)  # clusters can overlap in time across visits
    transit_s = max(0.0, total_s - dwell_s)

    speeds = _segment_speeds_kn(pts)
    spd_mean, spd_std = _mean_std(speeds)
    # Net displacement speed (straight-line endpoints / span) — immune to the
    # path-length inflation per-fix GPS jitter causes, same as dossier.py.
    disp_km = haversine_km(pts[0][1], pts[0][2], pts[-1][1], pts[-1][2])
    net_kn = (disp_km / total_s) * _KM_S_TO_KN if total_s > 0 else 0.0
    max_kn = max(speeds) if speeds else net_kn

    dwell_frac = dwell_s / total_s if total_s > 0 else 0.0
    if dwell_frac >= 0.6 and net_kn < 5:
        profile = "anchored / station-keeping"
    elif clusters and dwell_frac >= 0.25:
        profile = "patrol / recurring-orbit"
    elif net_kn >= 5 and dwell_frac < 0.2:
        profile = "transiting"
    else:
        profile = "mixed"

    anomaly = _anomaly(pts, labels, clusters)

    return {
        "id": entity_id,
        "found": True,
        "sufficient": True,
        "fixes": len(pts),
        "track_minutes": round(total_s / 60.0, 1),
        "first_seen": int(pts[0][0]),
        "last_seen": int(pts[-1][0]),
        "recurring_places": clusters,
        "place_count": len(clusters),
        "dwell": {
            "dwell_minutes": round(dwell_s / 60.0, 1),
            "transit_minutes": round(transit_s / 60.0, 1),
            "dwell_fraction": round(dwell_frac, 2),
        },
        "speed_kn": {
            "net": round(net_kn, 1),
            "max": round(max_kn, 1),
            "mean": round(spd_mean, 1),
            "std": round(spd_std, 2),
        },
        "profile": profile,
        "anomaly": anomaly,
        "params": {"eps_m": eps_m, "min_samples": min_samples},
        "window_note": (
            "Baseline is computed from this entity's own fixes in the positions "
            "DB (up to ~48h, self-capped). It matures as the entity is tracked; "
            "short windows report 'insufficient' rather than a synthesised norm."
        ),
    }


async def pattern_of_life(entity_id: str) -> dict[str, Any]:
    """Load one entity's track from the positions DB and return its
    pattern-of-life baseline + anomaly score. ``entity_id`` is the canonical id
    (``aircraft:<icao24>`` / ``vessel:<mmsi>``)."""
    pts = await _load_track(entity_id)
    return analyze_track(entity_id, pts)
