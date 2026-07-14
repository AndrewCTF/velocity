"""Energy-infrastructure feed (2026-07-14 data-layers wave).

``/api/infra/powerplants`` — WRI Global Power Plant Database (keyless CSV on GitHub),
filtered to larger plants so the payload stays bounded. Static targets to correlate
kinetic events against (strikes, outages). Each Feature reuses the existing
``facility`` map style via ``props.category`` (``power`` / ``nuclear``).
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["infra"])

WRI_URL = (
    "https://raw.githubusercontent.com/wri/global-power-plant-database/master/"
    "output_database/global_power_plant_database.csv"
)


@router.get("/api/infra/powerplants")
async def powerplants(
    min_mw: float = Query(200.0, ge=0, le=100000),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        text = await fg.fetch_text(WRI_URL)
        out: list[fg.Feature] = []
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            lat = fg.num(row.get("latitude"))
            lon = fg.num(row.get("longitude"))
            cap = fg.num(row.get("capacity_mw"))
            pid = (row.get("gppd_idnr") or "").strip()
            if lat is None or lon is None or not pid:
                continue
            if cap is not None and cap < min_mw:
                continue
            fuel = (row.get("primary_fuel") or "").strip()
            out.append(
                fg.point(
                    f"powerplant:{pid}",
                    lon,
                    lat,
                    {
                        "kind": "powerplant",
                        # Map style: reuse the facility tile; flag nuclear for the trefoil.
                        "category": "nuclear" if fuel.lower() == "nuclear" else "power",
                        "name": row.get("name"),
                        "fuel": fuel,
                        "capacity_mw": cap,
                        "country": row.get("country_long") or row.get("country"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"infra:powerplants:{min_mw}", 24 * 3600.0, load)
