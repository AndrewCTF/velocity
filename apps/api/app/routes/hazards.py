"""Keyless global-hazard feeds (2026-07-14 data-layers wave).

Six event/observation layers that were absent from the platform, each a thin
fetch → normalise → cache passthrough over a keyless upstream:

- ``/api/hazards/gdacs``           GDACS severity-scored disaster alerts
- ``/api/hazards/fire-perimeters`` NIFC/WFIGS current wildfire perimeters (polygons)
- ``/api/hazards/cyclones``        NHC active tropical cyclones + forecast cones
- ``/api/hazards/volcanoes``       Smithsonian GVP Holocene volcanoes / recent activity
- ``/api/hazards/radiation``       Safecast crowd radiation measurements
- ``/api/hazards/reliefweb``       ReliefWeb active humanitarian disasters

Every Feature id is ``<kind>:<rawid>`` with ``properties.kind`` set to match, so the
objects resolve at ``/api/entity`` and link through correlations + the ontology graph.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["hazards"])

# ── GDACS — Global Disaster Alert and Coordination System ────────────────────
# Returns a GeoJSON FeatureCollection of current events across six hazard types
# (EQ/TC/FL/VO/DR/WF) each scored Green/Orange/Red by modelled impact. Keyless.
GDACS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP"
_GDACS_TYPE = {
    "EQ": "earthquake",
    "TC": "cyclone",
    "FL": "flood",
    "VO": "volcano",
    "DR": "drought",
    "WF": "wildfire",
}


@router.get("/api/hazards/gdacs")
async def gdacs() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(GDACS_URL)
        out: list[fg.Feature] = []
        for f in (raw or {}).get("features", []) or []:
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates")
            if geom.get("type") != "Point" or not isinstance(coords, list) or len(coords) < 2:
                continue
            p = f.get("properties") or {}
            eid = str(p.get("eventid") or p.get("eventname") or "")
            etype = str(p.get("eventtype") or "").upper()
            if not eid:
                continue
            out.append(
                fg.point(
                    f"disaster:{etype}{eid}",
                    fg.num(coords[0]) or 0.0,
                    fg.num(coords[1]) or 0.0,
                    {
                        "kind": "disaster",
                        "event_type": _GDACS_TYPE.get(etype, etype or "event"),
                        "alert": str(p.get("alertlevel") or "").lower(),
                        "name": p.get("name") or p.get("description"),
                        "country": p.get("country"),
                        "from": p.get("fromdate"),
                        "to": p.get("todate"),
                        "severity": (p.get("severitydata") or {}).get("severity"),
                        "url": p.get("url", {}).get("report")
                        if isinstance(p.get("url"), dict)
                        else None,
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("hazards:gdacs", 600.0, load)


# ── NIFC / WFIGS current wildfire perimeters (polygons) ──────────────────────
# ArcGIS FeatureServer, GeoJSON out. FIRMS gives hotspot POINTS; this gives the
# actual burn AREA. MultiPolygon rings are exploded to one Polygon Feature each
# because the globe adapter's polygon path renders a single outer ring.
FIRE_PERIM_URL = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/"
    "WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)


@router.get("/api/hazards/fire-perimeters")
async def fire_perimeters() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            FIRE_PERIM_URL,
            params={
                "where": "1=1",
                "outFields": (
                    "poly_IncidentName,attr_IncidentSize,"
                    "attr_FireDiscoveryDateTime,irwin_POOState"
                ),
                "outSR": "4326",
                "f": "geojson",
                "resultRecordCount": "2000",
            },
        )
        out: list[fg.Feature] = []
        for f in (raw or {}).get("features", []) or []:
            geom = f.get("geometry") or {}
            gtype = geom.get("type")
            coords = geom.get("coordinates")
            if not isinstance(coords, list):
                continue
            p = f.get("properties") or {}
            base = str(p.get("poly_IncidentName") or f.get("id") or "fire").strip() or "fire"
            props = {
                "kind": "fireperim",
                "name": p.get("poly_IncidentName"),
                "size_acres": fg.num(p.get("attr_IncidentSize")),
                "discovered": p.get("attr_FireDiscoveryDateTime"),
                "state": p.get("irwin_POOState"),
            }
            # Normalise Polygon vs MultiPolygon into one Feature per outer ring.
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
                    out.append(fg.polygon(f"fireperim:{base}:{i}", clean, props))
        return fg.fc(out)

    return await fg.cached("hazards:fireperim", 1800.0, load)


# ── NHC active tropical cyclones + forecast cones ────────────────────────────
# CurrentStorms.json lists active storms with a center fix; render the center as
# a point (cone GIS is a separate heavier fetch we skip for now).
NHC_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json"


@router.get("/api/hazards/cyclones")
async def cyclones() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(NHC_STORMS_URL)
        out: list[fg.Feature] = []
        for s in (raw or {}).get("activeStorms", []) or []:
            lat = fg.num(s.get("latitudeNumeric"))
            lon = fg.num(s.get("longitudeNumeric"))
            sid = str(s.get("id") or s.get("binNumber") or "")
            if lat is None or lon is None or not sid:
                continue
            out.append(
                fg.point(
                    f"cyclone:{sid}",
                    lon,
                    lat,
                    {
                        "kind": "cyclone",
                        "name": s.get("name"),
                        "classification": s.get("classification"),
                        "intensity_kt": fg.num(s.get("intensity")),
                        "pressure_mb": fg.num(s.get("pressure")),
                        "movement": s.get("movementDir"),
                        "basin": s.get("basinId"),
                        "last_update": s.get("lastUpdate"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("hazards:cyclones", 900.0, load)


# ── Smithsonian GVP volcanoes (WFS GeoJSON) ──────────────────────────────────
GVP_URL = "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows"


@router.get("/api/hazards/volcanoes")
async def volcanoes() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            GVP_URL,
            params={
                "service": "WFS",
                "version": "2.0.0",
                "request": "GetFeature",
                "typeName": "GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes",
                "outputFormat": "application/json",
                "count": "1500",
            },
        )
        out: list[fg.Feature] = []
        for f in (raw or {}).get("features", []) or []:
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates")
            if geom.get("type") != "Point" or not isinstance(coords, list) or len(coords) < 2:
                continue
            p = f.get("properties") or {}
            vnum = str(p.get("Volcano_Number") or f.get("id") or "")
            if not vnum:
                continue
            out.append(
                fg.point(
                    f"volcano:{vnum}",
                    fg.num(coords[0]) or 0.0,
                    fg.num(coords[1]) or 0.0,
                    {
                        "kind": "volcano",
                        "name": p.get("Volcano_Name"),
                        "vtype": p.get("Primary_Volcano_Type"),
                        "country": p.get("Country"),
                        "elevation_m": fg.num(p.get("Elevation")),
                        "last_eruption": p.get("Last_Eruption_Year"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("hazards:volcanoes", 24 * 3600.0, load)


# ── Safecast radiation measurements ──────────────────────────────────────────
SAFECAST_URL = "https://api.safecast.org/measurements.json"


@router.get("/api/hazards/radiation")
async def radiation(
    limit: int = Query(1000, ge=1, le=2000),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            SAFECAST_URL, params={"order": "captured_at desc", "per_page": str(limit)}
        )
        rows = raw if isinstance(raw, list) else (raw or {}).get("measurements", [])
        out: list[fg.Feature] = []
        for m in rows or []:
            lat = fg.num(m.get("latitude"))
            lon = fg.num(m.get("longitude"))
            mid = str(m.get("id") or "")
            if lat is None or lon is None or not mid:
                continue
            out.append(
                fg.point(
                    f"radiation:{mid}",
                    lon,
                    lat,
                    {
                        "kind": "radiation",
                        "value": fg.num(m.get("value")),
                        "unit": m.get("unit"),
                        "captured_at": m.get("captured_at"),
                        "device": m.get("device_id"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"hazards:radiation:{limit}", 600.0, load)


# ── ReliefWeb active disasters (humanitarian) ────────────────────────────────
RELIEFWEB_URL = "https://api.reliefweb.int/v1/disasters"


@router.get("/api/hazards/reliefweb")
async def reliefweb() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            RELIEFWEB_URL,
            params={
                "appname": "velocity-osint",
                "profile": "full",
                "preset": "latest",
                "filter[field]": "status",
                "filter[value]": "current",
                "limit": "200",
            },
        )
        out: list[fg.Feature] = []
        for d in (raw or {}).get("data", []) or []:
            fields = d.get("fields") or {}
            countries = fields.get("country") or []
            country0 = countries[0] if countries and isinstance(countries[0], dict) else {}
            loc = country0.get("location")
            if not isinstance(loc, dict):
                continue
            lat = fg.num(loc.get("lat"))
            lon = fg.num(loc.get("lon"))
            did = str(d.get("id") or fields.get("id") or "")
            if lat is None or lon is None or not did:
                continue
            types = fields.get("type") or []
            dtype = types[0].get("name") if types and isinstance(types[0], dict) else None
            out.append(
                fg.point(
                    f"relief:{did}",
                    lon,
                    lat,
                    {
                        "kind": "relief",
                        "name": fields.get("name"),
                        "status": fields.get("status"),
                        "disaster_type": dtype,
                        "country": country0.get("name"),
                        "date": (fields.get("date") or {}).get("created"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("hazards:reliefweb", 1800.0, load)
