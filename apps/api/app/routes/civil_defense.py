"""Civil-defense alert feeds — keyless, live, country-level (2026-08-06 mega-ledger wave).

- ``/api/alerts/ukraine``      alerts.com.ua — 25 oblasts, no key
- ``/api/alerts/ukraine-alt``  siren.pp.ua — same data, independent relay
- ``/api/alerts/meteoalarm``   meteoalarm.org — EU civil warnings via CAP feeds
- ``/api/alerts/fema``         FEMA disaster declarations
- ``/api/alerts/spc-storms``   SPC severe weather reports (tornado/wind/hail)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["civil_defense"])

# ── Ukraine — alerts.com.ua ────────────────────────────────────────────────
UA_ALERTS_URL = "https://alerts.com.ua/api/states"
# Oblast centroids (approximate) for mapping alert state to a point.
_UA_OBLASTS: dict[str, tuple[float, float]] = {
    "Вінницька область": (49.23, 28.47),
    "Волинська область": (50.75, 25.33),
    "Дніпропетровська область": (48.46, 35.04),
    "Донецька область": (48.01, 37.80),
    "Житомирська область": (50.25, 28.66),
    "Закарпатська область": (48.62, 22.29),
    "Запорізька область": (47.84, 35.14),
    "Івано-Франківська область": (48.92, 24.71),
    "Київська область": (50.45, 30.52),
    "Кіровоградська область": (48.51, 32.26),
    "Луганська область": (48.57, 39.31),
    "Львівська область": (49.84, 24.03),
    "Миколаївська область": (46.97, 32.00),
    "Одеська область": (46.48, 30.73),
    "Полтавська область": (49.59, 34.55),
    "Рівненська область": (50.62, 26.25),
    "Сумська область": (50.91, 34.80),
    "Тернопільська область": (49.55, 25.59),
    "Харківська область": (49.99, 36.23),
    "Херсонська область": (46.63, 32.62),
    "Хмельницька область": (49.42, 27.00),
    "Черкаська область": (49.44, 32.06),
    "Чернівецька область": (48.29, 25.94),
    "Чернігівська область": (51.49, 31.29),
    "м. Київ": (50.45, 30.52),
}


@router.get("/api/alerts/ukraine")
async def ukraine_alerts() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(UA_ALERTS_URL)
        states = raw if isinstance(raw, list) else (raw or {}).get("states", raw) or []
        if isinstance(states, dict):
            states = states.get("states", [])
        out: list[fg.Feature] = []
        for s in states if isinstance(states, list) else []:
            name = s.get("name") or s.get("name_en") or ""
            alert = s.get("alert") or s.get("enabled") or False
            coords = _UA_OBLASTS.get(name)
            if not coords:
                continue
            sid = name.replace(" ", "_")[:20]
            out.append(
                fg.point(
                    f"ua_alert:{sid}",
                    coords[1],
                    coords[0],
                    {
                        "kind": "ua_alert",
                        "name": name,
                        "alert": bool(alert),
                        "changed": s.get("changed_at") or s.get("changed"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("alerts:ukraine", 30.0, load)


# ── Ukraine alt — siren.pp.ua ──────────────────────────────────────────────
UA_SIREN_URL = "https://siren.pp.ua/api/v1/states"


@router.get("/api/alerts/ukraine-alt")
async def ukraine_alerts_alt() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(UA_SIREN_URL)
        states = raw if isinstance(raw, list) else (raw or {}).get("states", [])
        out: list[fg.Feature] = []
        for s in states if isinstance(states, list) else []:
            name = s.get("name") or ""
            coords = _UA_OBLASTS.get(name)
            if not coords:
                continue
            sid = name.replace(" ", "_")[:20]
            out.append(
                fg.point(
                    f"ua_siren:{sid}",
                    coords[1],
                    coords[0],
                    {
                        "kind": "ua_alert",
                        "name": name,
                        "alert": bool(s.get("alert") or s.get("enabled")),
                        "changed": s.get("changed_at") or s.get("changed"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("alerts:ukraine_alt", 30.0, load)


# ── meteoalarm — EU civil warnings ─────────────────────────────────────────
# The meteoalarm.org CAP feed is an Atom/RSS feed of weather warnings.
# We fetch the JSON widget feed which is lighter.
METEOALARM_URL = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-fullcap"


@router.get("/api/alerts/meteoalarm")
async def meteoalarm(country: str = Query("", max_length=2)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        url = METEOALARM_URL
        params: dict[str, str] = {}
        if country:
            params["country"] = country.upper()
        try:
            raw = await fg.fetch_json(url, params=params or None)
        except Exception:
            return fg.fc([])
        entries = raw if isinstance(raw, list) else (raw or {}).get("warnings", [])
        out: list[fg.Feature] = []
        for w in (entries or [])[:500]:
            if not isinstance(w, dict):
                continue
            lat = fg.num(w.get("lat") or (w.get("geocode", {}) or {}).get("lat"))
            lon = fg.num(w.get("lon") or (w.get("geocode", {}) or {}).get("lon"))
            wid = str(w.get("id") or w.get("identifier") or "")
            if lat is None or lon is None or not wid:
                continue
            out.append(
                fg.point(
                    f"meteoalarm:{wid}",
                    lon,
                    lat,
                    {
                        "kind": "meteoalarm",
                        "event": w.get("event") or w.get("awareness_type"),
                        "severity": w.get("severity"),
                        "urgency": w.get("urgency"),
                        "certainty": w.get("certainty"),
                        "country": w.get("country"),
                        "area": w.get("areaDesc") or w.get("area"),
                        "onset": w.get("onset"),
                        "expires": w.get("expires"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"alerts:meteoalarm:{country}", 600.0, load)


# ── FEMA disaster declarations ─────────────────────────────────────────────
FEMA_URL = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"

# US state centroids for geo-mapping FEMA declarations.
_US_STATE_COORDS: dict[str, tuple[float, float]] = {
    "AL": (32.8, -86.8), "AK": (64.2, -152.5), "AZ": (34.3, -111.7),
    "AR": (34.8, -92.2), "CA": (36.8, -119.4), "CO": (39.1, -105.4),
    "CT": (41.6, -72.7), "DE": (39.0, -75.5), "FL": (28.1, -81.6),
    "GA": (33.0, -83.5), "HI": (21.1, -157.5), "ID": (44.2, -114.5),
    "IL": (40.3, -89.0), "IN": (39.8, -86.2), "IA": (41.9, -93.1),
    "KS": (38.5, -98.3), "KY": (37.8, -84.3), "LA": (31.2, -91.9),
    "ME": (45.4, -69.2), "MD": (39.0, -76.8), "MA": (42.2, -71.5),
    "MI": (43.3, -84.5), "MN": (45.7, -93.9), "MS": (32.7, -89.7),
    "MO": (38.5, -92.3), "MT": (46.8, -110.4), "NE": (41.1, -98.3),
    "NV": (38.8, -117.0), "NH": (43.5, -71.6), "NJ": (40.3, -74.5),
    "NM": (34.8, -106.2), "NY": (42.2, -74.9), "NC": (35.6, -79.8),
    "ND": (47.5, -99.8), "OH": (40.4, -82.8), "OK": (35.6, -96.9),
    "OR": (44.6, -120.5), "PA": (41.2, -77.2), "RI": (41.7, -71.5),
    "SC": (33.9, -80.9), "SD": (44.3, -99.4), "TN": (35.7, -86.6),
    "TX": (31.1, -97.6), "UT": (39.3, -111.1), "VT": (44.0, -72.7),
    "VA": (37.8, -78.2), "WA": (47.4, -120.7), "WV": (38.5, -80.5),
    "WI": (44.3, -89.6), "WY": (42.8, -107.3), "DC": (38.9, -77.0),
    "PR": (18.2, -66.4), "VI": (17.7, -64.8), "GU": (13.4, 144.7),
    "AS": (-14.3, -170.7), "MP": (15.2, 145.7),
}


@router.get("/api/alerts/fema")
async def fema_disasters(limit: int = Query(100, ge=1, le=500)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            FEMA_URL,
            params={
                "$orderby": "declarationDate desc",
                "$top": str(limit),
                "$select": (
                    "disasterNumber,state,declarationTitle,declarationType,"
                    "declarationDate,incidentType,fyDeclared"
                ),
            },
        )
        rows = (raw or {}).get("DisasterDeclarationsSummaries", [])
        out: list[fg.Feature] = []
        for r in rows or []:
            st = (r.get("state") or "").upper()
            coords = _US_STATE_COORDS.get(st)
            if not coords:
                continue
            did = str(r.get("disasterNumber") or "")
            if not did:
                continue
            out.append(
                fg.point(
                    f"fema:{did}",
                    coords[1],
                    coords[0],
                    {
                        "kind": "fema",
                        "name": r.get("declarationTitle"),
                        "state": st,
                        "type": r.get("incidentType"),
                        "declaration_type": r.get("declarationType"),
                        "date": r.get("declarationDate"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"alerts:fema:{limit}", 3600.0, load)


# ── SPC severe weather reports (tornado/wind/hail) ─────────────────────────
SPC_URL = "https://www.spc.noaa.gov/climo/reports/today.csv"


@router.get("/api/alerts/spc-storms")
async def spc_storms() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        import csv
        import io

        text = await fg.fetch_text(SPC_URL)
        out: list[fg.Feature] = []
        reader = csv.reader(io.StringIO(text))
        header: list[str] = []
        for i, row in enumerate(reader):
            if i == 0:
                header = [c.strip().lower() for c in row]
                continue
            if len(row) < len(header):
                continue
            rec = dict(zip(header, row, strict=False))
            lat = fg.num(rec.get("lat"))
            lon = fg.num(rec.get("lon"))
            if lat is None or lon is None:
                continue
            out.append(
                fg.point(
                    f"spc:{i}",
                    lon,
                    lat,
                    {
                        "kind": "spc_storm",
                        "time": rec.get("time"),
                        "event": rec.get("f_scale") or rec.get("speed") or rec.get("size"),
                        "location": rec.get("location"),
                        "county": rec.get("county"),
                        "state": rec.get("state" if "state" in rec else "st"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("alerts:spc_storms", 600.0, load)
