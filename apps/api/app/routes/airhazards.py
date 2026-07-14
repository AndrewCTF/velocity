"""Aviation hazard advisories (2026-07-14 data-layers wave).

``/api/aviation/sigmet`` — AWC AIRMET/SIGMET polygons (turbulence, icing, IFR,
volcanic ash, convective). Same keyless host as the existing METAR route. Hazard
areas that directly constrain the aircraft layer already on the globe. MultiPolygon
rings are exploded to one Polygon Feature each for the adapter's polygon path.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from app.routes import _feedgeo as fg

router = APIRouter(tags=["airhazards"])

SIGMET_URL = "https://aviationweather.gov/api/data/airsigmet"


@router.get("/api/aviation/sigmet")
async def sigmet() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(SIGMET_URL, params={"format": "geojson"})
        out: list[fg.Feature] = []
        for f in (raw or {}).get("features", []) or []:
            geom = f.get("geometry") or {}
            gtype = geom.get("type")
            coords = geom.get("coordinates")
            if not isinstance(coords, list):
                continue
            p = f.get("properties") or {}
            fid = str(f.get("id") or p.get("airSigmetId") or p.get("icaoId") or "sigmet")
            props = {
                "kind": "sigmet",
                "hazard": p.get("hazard"),
                "severity": p.get("severity"),
                "advisory_type": p.get("airSigmetType"),
                "from": p.get("validTimeFrom"),
                "to": p.get("validTimeTo"),
            }
            rings: list[list[list[float]]] = []
            if gtype == "Polygon" and coords and isinstance(coords[0], list):
                rings.append(coords[0])
            elif gtype == "MultiPolygon":
                for poly in coords:
                    if isinstance(poly, list) and poly and isinstance(poly[0], list):
                        rings.append(poly[0])
            for i, ring in enumerate(rings):
                clean = [c for c in ring if isinstance(c, list) and len(c) >= 2]
                if len(clean) >= 3:
                    out.append(fg.polygon(f"sigmet:{fid}:{i}", clean, props))
        return fg.fc(out)

    return await fg.cached("aviation:sigmet", 600.0, load)
