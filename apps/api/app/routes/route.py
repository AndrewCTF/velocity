"""GET /api/route/* — operator navigation (Velocity Ops).

- /api/route/road    — fastest on-road route (public OSRM demo, keyless, online).
- /api/route/offroad — war-zone off-road path over a keyless DEM (A* slope cost).
- /api/route/fastest — on-road if reachable, else fall back to off-road.

Honesty: the on-road route is real OSRM. The off-road path is a trafficability
ESTIMATE over slope + water only (see app.intel.offroad). Public OSRM is
rate-limited + online-only; an offline/edge deploy points OSRM_URL at a
self-hosted regional extract.
"""

from __future__ import annotations

import math
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.intel import offroad
from app.upstream import cache, get_client

router = APIRouter(tags=["route"])

# ── Threat-aware routing (Gotham "Asset EMI Resistance" / least-risk, image 24) ─
# Score a candidate route by how much of it passes through the live GPS-jamming
# heat cells. Higher risk = more exposure to a jammer; EMI resistance = 100-risk.
_SEV_WEIGHT = {"low": 1, "medium": 2, "high": 3}
_SEV_BY_WEIGHT = {0: "none", 1: "low", 2: "medium", 3: "high"}


def _haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def score_route_risk(
    route: list[list[float]],
    threats: list[dict[str, Any]],
) -> dict[str, Any]:
    """Score one route [[lon,lat],…] against jamming threats.

    Pure (no I/O) so it unit-tests. For each route vertex, take the worst-severity
    threat whose ring it falls inside; risk is the severity-weighted average
    exposure across all vertices, normalised to 0-100 (a route entirely inside a
    HIGH cell = 100). emi_resistance = 100 - risk. Empty route or no threats → 0.
    """
    if not route:
        return {
            "risk": 0.0, "emi_resistance": 100.0, "exposed_pts": 0, "total_pts": 0,
            "worst_severity": "none",
        }
    tot_w = 0
    exposed = 0
    worst_w = 0
    for pt in route:
        lon, lat = float(pt[0]), float(pt[1])
        best = 0
        for t in threats:
            if _haversine_km(lon, lat, t["lon"], t["lat"]) <= t["radius_km"]:
                best = max(best, _SEV_WEIGHT.get(t["severity"], 0))
        if best:
            exposed += 1
            tot_w += best
            worst_w = max(worst_w, best)
    risk = round(100.0 * tot_w / (len(route) * 3), 1)
    return {
        "risk": risk,
        "emi_resistance": round(100.0 - risk, 1),
        "exposed_pts": exposed,
        "total_pts": len(route),
        "worst_severity": _SEV_BY_WEIGHT[worst_w],
    }


async def _jamming_threats() -> list[dict[str, Any]]:
    """Live GPS-jamming cells as scoring threats: centroid + severity + radius_km.

    Reuses the jamming aggregation over the plain snapshot (never the adsb_global
    route handler — its Query defaults 500 in-process). Keeps only medium/high
    cells (low is too noisy to route around) so the threat rings stay meaningful.
    """
    from app.routes.adsb import global_snapshot  # noqa: PLC0415
    from app.routes.jamming import HEX_SIZE, _aggregate_jamming  # noqa: PLC0415

    fc = await global_snapshot()
    cells = _aggregate_jamming(list(fc.get("features") or []))
    radius_km = HEX_SIZE * 111.0  # hex circumradius° → km
    out: list[dict[str, Any]] = []
    for f in cells.get("features") or []:
        props = f.get("properties") or {}
        sev = props.get("severity")
        if sev not in ("medium", "high"):
            continue
        ring = ((f.get("geometry") or {}).get("coordinates") or [[]])[0]
        if not ring:
            continue
        clon = sum(p[0] for p in ring) / len(ring)
        clat = sum(p[1] for p in ring) / len(ring)
        out.append({"lon": clon, "lat": clat, "severity": sev, "radius_km": radius_km})
    return out

# Public OSRM demo. Overridable for a self-hosted/offline extract.
_OSRM_BASE = "https://router.project-osrm.org"
_OSRM_TIMEOUT = httpx.Timeout(10.0, connect=4.0)


async def _osrm_route(
    from_lat: float, from_lon: float, to_lat: float, to_lon: float, profile: str
) -> dict[str, Any]:
    url = (
        f"{_OSRM_BASE}/route/v1/{profile}/"
        f"{from_lon},{from_lat};{to_lon},{to_lat}"
    )
    try:
        r = await get_client().get(
            url,
            params={"overview": "full", "geometries": "geojson", "steps": "true"},
            timeout=_OSRM_TIMEOUT,
            headers={"User-Agent": "Mozilla/5.0"},
        )
    except httpx.HTTPError as e:
        return {"reachable": False, "unavailable": True, "note": f"osrm transport: {e}"}
    if r.status_code != 200:
        return {"reachable": False, "unavailable": True, "note": f"osrm upstream {r.status_code}"}
    j = r.json()
    routes = j.get("routes") or []
    if not routes:
        return {"reachable": False, "note": "no route"}
    top = routes[0]
    steps = [
        {
            "name": s.get("name") or "",
            "distance_m": s.get("distance"),
            "maneuver": (s.get("maneuver") or {}).get("type"),
        }
        for leg in top.get("legs", [])
        for s in leg.get("steps", [])
    ]
    return {
        "reachable": True,
        "mode": "road",
        "profile": profile,
        "route": (top.get("geometry") or {}).get("coordinates") or [],
        "distance_km": round((top.get("distance") or 0) / 1000, 2),
        "duration_min": round((top.get("duration") or 0) / 60, 1),
        "steps": steps[:60],
        "source": "OSRM (project-osrm.org demo)",
    }


@router.get("/api/route/road")
async def route_road(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
    mode: str = Query("driving", pattern="^(driving|walking|cycling)$"),
) -> dict[str, Any]:
    key = f"route:road:{mode}:{from_lat:.4f},{from_lon:.4f}:{to_lat:.4f},{to_lon:.4f}"
    return await cache.get_or_fetch(
        key, 300.0, lambda: _osrm_route(from_lat, from_lon, to_lat, to_lon, mode)
    )


@router.get("/api/route/offroad")
async def route_offroad(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
) -> dict[str, Any]:
    key = f"route:offroad:{from_lat:.4f},{from_lon:.4f}:{to_lat:.4f},{to_lon:.4f}"

    async def load() -> dict[str, Any]:
        try:
            return {
                "mode": "offroad",
                **await offroad.plan_offroad(from_lat, from_lon, to_lat, to_lon),
            }
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    return await cache.get_or_fetch(key, 6 * 3600.0, load)


@router.get("/api/route/fastest")
async def route_fastest(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
) -> dict[str, Any]:
    """On-road if OSRM can route it, else fall back to the off-road estimate."""
    road = await _osrm_route(from_lat, from_lon, to_lat, to_lon, "driving")
    if road.get("reachable"):
        return road
    try:
        return {"mode": "offroad", "road_failed": road.get("note"), **await offroad.plan_offroad(
            from_lat, from_lon, to_lat, to_lon
        )}
    except ValueError as e:
        return {"reachable": False, "note": f"road unavailable; off-road: {e}"}


@router.get("/api/route/candidates")
async def route_candidates(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
) -> dict[str, Any]:
    """Generate route options + score each against live GPS-jamming (image 24).

    Returns reachable road + off-road candidates, each carrying risk /
    emi_resistance from score_route_risk, tagged least-risk / shortest / fastest,
    plus the threat cells so the client can draw threat rings on the map.
    """
    threats = await _jamming_threats()

    async def _one(label: str, coro: Any) -> dict[str, Any] | None:
        try:
            res = await coro
        except (ValueError, httpx.HTTPError):
            return None
        route = res.get("route") or []
        if not res.get("reachable") or not route:
            return None
        return {"key": label, "label": label, **res, **score_route_risk(route, threats)}

    generated = [
        await _one("On-road", _osrm_route(from_lat, from_lon, to_lat, to_lon, "driving")),
        await _one("Off-road", offroad.plan_offroad(from_lat, from_lon, to_lat, to_lon)),
    ]
    cands = [c for c in generated if c]

    # Tag least-risk / shortest / fastest across the reachable set.
    def _tag(pred_key: str, values: list[tuple[str, float]]) -> None:
        if not values:
            return
        best = min(values, key=lambda kv: kv[1])[0]
        for c in cands:
            if c["key"] == best and "tag" not in c:
                c["tag"] = pred_key

    _tag("Least risk", [(c["key"], c["risk"]) for c in cands])
    _tag(
        "Shortest distance",
        [(c["key"], c["distance_km"]) for c in cands if c.get("distance_km") is not None],
    )
    _tag(
        "Fastest",
        [(c["key"], c["duration_min"]) for c in cands if c.get("duration_min") is not None],
    )

    return {"candidates": cands, "threats": threats}
