"""Civil-defense alert feeds — keyless, live, country-level (2026-08-06 mega-ledger wave).

- ``/api/alerts/ukraine``      alerts.com.ua — 25 oblasts, no key
- ``/api/alerts/ukraine-alt``  siren.pp.ua — same data, independent relay
- ``/api/alerts/meteoalarm``   meteoalarm.org — EU civil warnings via CAP feeds
- ``/api/alerts/fema``         FEMA disaster declarations
- ``/api/alerts/spc-storms``   SPC severe weather reports (tornado/wind/hail)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["civil_defense"])

# ── Ukraine — alerts.com.ua ────────────────────────────────────────────────
UA_ALERTS_URL = "https://alerts.com.ua/api/states"
# Oblast centroids (approximate), with an ASCII slug per oblast. The slug is
# the FEATURE ID: an id has to survive a URL and `/api/entity/<kind>:<id>`,
# which accepts ASCII only, so keying on the Cyrillic name gave every oblast a
# contact the dossier could not resolve.
_UA_OBLASTS: dict[str, tuple[float, float, str]] = {
    "Вінницька область": (49.23, 28.47, "vinnytska"),
    "Волинська область": (50.75, 25.33, "volynska"),
    "Дніпропетровська область": (48.46, 35.04, "dnipropetrovska"),
    "Донецька область": (48.01, 37.80, "donetska"),
    "Житомирська область": (50.25, 28.66, "zhytomyrska"),
    "Закарпатська область": (48.62, 22.29, "zakarpatska"),
    "Запорізька область": (47.84, 35.14, "zaporizka"),
    "Івано-Франківська область": (48.92, 24.71, "ivano-frankivska"),
    "Київська область": (50.45, 30.52, "kyivska"),
    "Кіровоградська область": (48.51, 32.26, "kirovohradska"),
    "Луганська область": (48.57, 39.31, "luhanska"),
    "Львівська область": (49.84, 24.03, "lvivska"),
    "Миколаївська область": (46.97, 32.00, "mykolaivska"),
    "Одеська область": (46.48, 30.73, "odeska"),
    "Полтавська область": (49.59, 34.55, "poltavska"),
    "Рівненська область": (50.62, 26.25, "rivnenska"),
    "Сумська область": (50.91, 34.80, "sumska"),
    "Тернопільська область": (49.55, 25.59, "ternopilska"),
    "Харківська область": (49.99, 36.23, "kharkivska"),
    "Херсонська область": (46.63, 32.62, "khersonska"),
    "Хмельницька область": (49.42, 27.00, "khmelnytska"),
    "Черкаська область": (49.44, 32.06, "cherkaska"),
    "Чернівецька область": (48.29, 25.94, "chernivetska"),
    "Чернігівська область": (51.49, 31.29, "chernihivska"),
    "м. Київ": (50.45, 30.52, "kyiv-city"),
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
            out.append(
                fg.point(
                    f"ua_alert:{coords[2]}",
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
# `/api/v1/states` is a 404 and `/api/states` sits behind Cloudflare; v3 answers
# a bare httpx GET. It reports only the regions with an ACTIVE alert, so a region
# absent from the response is a region that is clear — the opposite of the
# primary relay, which lists all 25 with a boolean.
UA_SIREN_URL = "https://siren.pp.ua/api/v3/alerts"


@router.get("/api/alerts/ukraine-alt")
async def ukraine_alerts_alt() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(UA_SIREN_URL)
        except Exception:
            # A second relay of the same alerts. If it is down the primary layer
            # still carries the picture, so this one goes quiet rather than
            # putting an error on a map that is not missing anything.
            return fg.fc([])
        states = raw if isinstance(raw, list) else (raw or {}).get("states", [])
        out: list[fg.Feature] = []
        for s in states if isinstance(states, list) else []:
            if not isinstance(s, dict):
                continue
            name = s.get("regionName") or s.get("name") or ""
            coords = _UA_OBLASTS.get(name)
            if not coords:
                continue
            active = s.get("activeAlerts")
            out.append(
                fg.point(
                    f"ua_siren:{coords[2]}",
                    coords[1],
                    coords[0],
                    {
                        "kind": "ua_alert",
                        "name": s.get("regionEngName") or name,
                        # Present in this response at all means alerting.
                        "alert": bool(active) if active is not None else True,
                        "alert_type": (active or [{}])[0].get("type") if active else None,
                        "changed": s.get("lastUpdate"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("alerts:ukraine_alt", 30.0, load)


# ── meteoalarm — EU civil warnings ─────────────────────────────────────────
# Meteoalarm publishes a per-country Atom feed of CAP warnings. There is no
# JSON widget feed (`/api/v1/warnings/feeds-fullcap` is a 404), and a warning
# here carries a NUTS3 geocode and an area NAME and no coordinates — so this is
# a list, not a map layer, and it is read in the Sources panel rather than
# plotted at a centroid the warning never claimed.
METEOALARM_FEED = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-{country}"
_CAP_NS = "{urn:oasis:names:tc:emergency:cap:1.2}"
_ATOM_NS = "{http://www.w3.org/2005/Atom}"


@router.get("/api/alerts/meteoalarm")
async def meteoalarm(country: str = Query("france", max_length=40)) -> dict[str, Any]:
    slug = country.strip().lower().replace(" ", "-")
    if not slug.replace("-", "").isalpha():
        raise HTTPException(400, "country must be a country name, e.g. 'france'")

    async def load() -> dict[str, Any]:
        import xml.etree.ElementTree as ET

        try:
            text = await fg.fetch_text(METEOALARM_FEED.format(country=slug))
            root = ET.fromstring(text)
        except Exception:
            return {"country": slug, "count": 0, "warnings": [], "note": "feed unavailable"}
        warnings: list[dict[str, Any]] = []
        for entry in root.iter(f"{_ATOM_NS}entry"):

            def cap(name: str, el: ET.Element = entry) -> str | None:
                node = el.find(f"{_CAP_NS}{name}")
                return node.text.strip() if node is not None and node.text else None

            title = entry.find(f"{_ATOM_NS}title")
            warnings.append(
                {
                    "id": cap("identifier"),
                    "title": title.text if title is not None else None,
                    "event": cap("event"),
                    "area": cap("areaDesc"),
                    "severity": cap("severity"),
                    "urgency": cap("urgency"),
                    "certainty": cap("certainty"),
                    "onset": cap("onset"),
                    "expires": cap("expires"),
                }
            )
        return {"country": slug, "count": len(warnings), "warnings": warnings[:500]}

    return await fg.cached(f"alerts:meteoalarm:{slug}", 600.0, load)


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
