"""GET /api/firms?source=&days= — NASA FIRMS active fires.

Per research.md §6.5 / research_updated.md §2.18:
- MAP_KEY required (5000 transactions / 10 min rolling).
- URL: /api/area/csv/{MAP_KEY}/{source}/{world|bbox}/{day_range}[/{date}]
- We return GeoJSON. If MAP_KEY is unset we return an empty FeatureCollection
  with a `note` so the frontend can show the right empty state.
"""

from __future__ import annotations

import csv
import io
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import Settings, get_settings
from app.upstream import cache, get_client

router = APIRouter(tags=["firms"])

Source = Literal[
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
    "MODIS_NRT",
    "LANDSAT_NRT",
]


@router.get("/api/firms")
async def firms(
    source: Source = Query("VIIRS_SNPP_NRT"),
    days: int = Query(1, ge=1, le=10),
    settings: Settings = Depends(get_settings),
) -> dict[str, Any]:
    if not settings.firms_map_key:
        return {
            "type": "FeatureCollection",
            "features": [],
            "note": "FIRMS_MAP_KEY not configured — set in .env to enable fire detections",
        }

    key = f"firms:{source}:{days}"

    async def load() -> dict[str, Any]:
        url = (
            f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
            f"{settings.firms_map_key}/{source}/world/{days}"
        )
        r = await get_client().get(url)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"firms upstream {r.status_code}")
        return _csv_to_geojson(r.text)

    return await cache.get_or_fetch(key, 600.0, load)  # 10 min per plan


def _csv_to_geojson(text: str) -> dict[str, Any]:
    reader = csv.DictReader(io.StringIO(text))
    features: list[dict[str, Any]] = []
    for i, row in enumerate(reader):
        try:
            lat = float(row["latitude"])
            lon = float(row["longitude"])
        except (KeyError, ValueError):
            continue
        features.append(
            {
                "type": "Feature",
                "id": f"fire:{row.get('acq_date', '')}:{row.get('acq_time', '')}:{i}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "brightness": _float_or_none(row.get("brightness") or row.get("bright_ti4")),
                    "confidence": row.get("confidence"),
                    "frp": _float_or_none(row.get("frp")),
                    "satellite": row.get("satellite"),
                    "acq_date": row.get("acq_date"),
                    "acq_time": row.get("acq_time"),
                    "daynight": row.get("daynight"),
                    "kind": "fire",
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def _float_or_none(v: str | None) -> float | None:
    if v in (None, ""):
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
