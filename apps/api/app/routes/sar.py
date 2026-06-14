"""SAR-derived intelligence routes (dark-vessel detection)."""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.imagery import cdse
from app.intel import lod1, sar_vessels

router = APIRouter(tags=["intel-sar"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@router.get("/api/intel/dark-vessels/sar")
async def dark_vessels_sar(
    aoi: str = Query("hormuz"),
    date: str | None = Query(None, description="YYYY-MM-DD; defaults to today"),
) -> dict[str, Any]:
    if aoi not in sar_vessels.AOIS:
        raise HTTPException(404, f"unknown aoi (have: {sorted(sar_vessels.AOIS)})")
    if date is not None and not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    if not cdse.available():
        raise HTTPException(503, "cdse credentials not configured")
    result = await sar_vessels.detect_dark_vessels(aoi=aoi, date=date)
    # Strip internal verification payloads (raw bytes / arrays) from the API body.
    return {k: v for k, v in result.items() if not k.startswith("_")}


@router.get("/api/intel/lod1")
async def lod1_buildings(aoi: str = Query("beirut-dahieh")) -> dict[str, Any]:
    """LOD1 building GeoJSON (footprints + height + SAR-damage flag) for the
    globe to extrude. Cached 12h (Overpass + SAR fetch is slow)."""
    if not cdse.available():
        raise HTTPException(503, "cdse credentials not configured")
    try:
        return await lod1.build(aoi)
    except KeyError:
        raise HTTPException(404, f"unknown aoi (have {sorted(lod1.DAMAGE_DATES)})") from None
