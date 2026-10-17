"""AIS pipeline routes — coverage, vessels, and open-ocean SAR dark detection.

  GET /api/maritime/pipeline/stats    health + measured coverage per source
  GET /api/maritime/coverage          5° global grid of live-vessel density
  GET /api/maritime/vessels           bbox query against the freshness-wins store
  GET /api/maritime/dark              keyless Sentinel-1 SAR scan over a box
  GET /api/maritime/satellite         unidentified satellite AIS positions (open ocean)

Every number these return is measured at request time. Nothing here reports a
"global coverage" claim without a live count behind it.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app import ais_pipeline
from app.ais_pipeline import sar_scan, vesselfinder
from app.ais_pipeline import stats as pipeline_stats
from app.ais_pipeline import vessels as vessel_store

router = APIRouter(tags=["maritime"])
log = logging.getLogger(__name__)


@router.get("/api/maritime/pipeline/stats")
async def pipeline() -> dict[str, Any]:
    """Per-source health, the vessel store's merge stats, and coverage honesty."""
    return pipeline_stats()


# Count buckets for the map form of the grid: (floor, label). The bucket index is
# part of the feature id on purpose — the globe's polygon path styles an entity
# once and never restyles it, so a cell that crosses a bucket must arrive as a
# NEW id (the old one is pruned as absent) for its shade to change.
_COVERAGE_BUCKETS = (
    (1, "1 to 9 vessels"),
    (10, "10 to 99 vessels"),
    (100, "100 to 999 vessels"),
    (1000, "1000 or more vessels"),
)


def coverage_geojson(cov: dict[str, Any]) -> dict[str, Any]:
    """One Polygon per OCCUPIED cell — an empty ocean cell is simply absent."""
    deg = cov["gridDeg"]
    feats: list[dict[str, Any]] = []
    for r, row in enumerate(cov["cells"]):
        for c, n in enumerate(row):
            if not n:
                continue
            bucket = sum(1 for floor, _ in _COVERAGE_BUCKETS if n >= floor) - 1
            # Keep the ring off the poles: two corners at ±90 are one point.
            lat0 = max(-90.0 + r * deg, -89.5)
            lat1 = min(-90.0 + (r + 1) * deg, 89.5)
            lon0 = -180.0 + c * deg
            lon1 = lon0 + deg
            ring = [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]]
            feats.append(
                {
                    "type": "Feature",
                    "id": f"aiscov:{r}:{c}:{bucket}",
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                    "properties": {
                        "kind": "coverage",
                        "bucket": bucket,
                        "count": n,
                        "name": f"AIS coverage · {_COVERAGE_BUCKETS[bucket][1]}",
                    },
                }
            )
    return {"type": "FeatureCollection", "features": feats}


@router.get("/api/maritime/coverage")
async def coverage(
    max_age_s: float = Query(3600.0, ge=0.0, le=604800.0),
    fmt: str | None = Query(None, alias="format", pattern="^geojson$"),
) -> dict[str, Any]:
    """Global 5° grid of live-vessel counts.

    The grid is dense (36×72 ints) so a client can render ocean emptiness
    directly rather than inferring it. `fresh` counts fixes inside `max_age_s`;
    `stale` counts the rest. `format=geojson` returns the occupied cells as
    polygons for the map layer.
    """
    cov = vessel_store.coverage(max_age_s=max_age_s)
    return coverage_geojson(cov) if fmt else cov


@router.get("/api/maritime/vessels")
async def vessels(
    bbox: str = Query(..., description="lon0,lat0,lon1,lat1"),
    max_age_s: float = Query(3600.0, ge=0.0, le=604800.0),
    limit: int = Query(5000, ge=1, le=50_000),
) -> dict[str, Any]:
    """Live vessels in a bbox from the freshness-wins store."""
    lon0, lat0, lon1, lat1 = _bbox(bbox)
    hits = vessel_store.in_bbox(lon0, lat0, lon1, lat1, max_age_s=max_age_s)
    hits.sort(key=lambda s: s.fix.t, reverse=True)
    return {
        "bbox": [lon0, lat0, lon1, lat1],
        "count": len(hits),
        "returned": min(len(hits), limit),
        "truncated": len(hits) > limit,
        "maxAgeS": max_age_s,
        "vessels": [s.to_json() for s in hits[:limit]],
    }


def _bbox(raw: str) -> tuple[float, float, float, float]:
    try:
        parts = [float(p) for p in raw.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be lon0,lat0,lon1,lat1") from None
    if len(parts) != 4:
        raise HTTPException(400, "bbox must be lon0,lat0,lon1,lat1")
    return parts[0], parts[1], parts[2], parts[3]


@router.get("/api/maritime/dark")
async def dark(
    bbox: str = Query(..., description="lon0,lat0,lon1,lat1"),
    days: int = Query(2, ge=1, le=30),
    limit: int = Query(3, ge=1, le=20),
    detect: bool = Query(False, description="run located detection (box <= 1 degree)"),
) -> dict[str, Any]:
    """Keyless Sentinel-1 SAR scan: scene inventory + dark-vessel candidates.

    Returns scene metadata by default. `detect=true` also runs bright-target
    detection on a georeferenced Sentinel-1 VV frame for a box up to one degree
    a side, and classifies each contact against the AIS store: `dark` only
    where enough AIS exists nearby for absence to mean something, otherwise
    `unknown`. That path needs the CDSE credentials; without them, or for a
    larger box, the answer stays an inventory and `note` says why.
    """
    return await sar_scan(_bbox(bbox), days=days, limit=limit, detect=detect)


@router.get("/api/maritime/satellite")
async def satellite(
    bbox: str | None = Query(None, description="lon0,lat0,lon1,lat1"),
) -> dict[str, Any]:
    """Unidentified satellite AIS positions, the only keyless open-ocean picture.

    These are VesselFinder's "Satellite Position" markers: a position, a type
    class and a heading step. They carry NO MMSI, NO name and NO age, so none
    is invented: features have no `t`, and `old` is the upstream's own stale
    flag. They are never merged into the identified vessel store.
    """
    sat = ais_pipeline.satellite
    rows = sat["positions"]
    if bbox is not None:
        lon0, lat0, lon1, lat1 = _bbox(bbox)
        wrap = lon0 > lon1
        rows = [
            r
            for r in rows
            if lat0 <= r["lat"] <= lat1
            and ((r["lon"] >= lon0 or r["lon"] <= lon1) if wrap else lon0 <= r["lon"] <= lon1)
        ]
    feats = [
        {
            "type": "Feature",
            "id": f"satpos:{r['lat']:.4f}:{r['lon']:.4f}",
            "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
            "properties": {
                "kind": "vessel",
                "name": "Satellite position · unidentified",
                "identified": False,
                "shipType": r["shipType"],
                "typeClass": vesselfinder.CLASS_LABEL[r["classIndex"]]
                if r["classIndex"] < len(vesselfinder.CLASS_LABEL)
                else None,
                "heading": r["heading"],
                "old": r["old"],
                "source": "vesselfinder-satellite",
            },
        }
        for r in rows
    ]
    fetched = sat["fetched_at"]
    return {
        "type": "FeatureCollection",
        "features": feats,
        "count": len(feats),
        "complete": sat["complete"],
        "fetchedAt": fetched or None,
        "note": (
            "Unidentified satellite AIS positions. No MMSI, name or position age "
            "is published for them, so none is shown."
        ),
    }
