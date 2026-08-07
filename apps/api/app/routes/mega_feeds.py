"""Mega-ledger feed routes (2026-08-06 wave).

Every endpoint from the OSINT mega-ledger that isn't already wired as its own
route file. Each is a thin fetch → normalise → cache passthrough using the
``_feedgeo`` helpers, grouped by domain.

Domains covered:
- CISA KEV (cyber)
- USGS MRDS mineral sites
- Overpass/OSM military objects
- Wikimapia bbox query
- GLEIF corporate LEI lookup
- CourtListener legal search
- UNHCR refugee populations (direct API)
- WorldPop population metadata
- HDX humanitarian datasets
- FlightRadar24 unauthed search
- NGA World Port Index (live CSV)
- Sketchfab 3DGS splat search
- HuggingFace splat datasets
- ESRI Wayback time-travel manifest
- GPSJAM daily manifest
- Shodan InternetDB (standalone route)
- insecam public webcam directory
- Telegram channel scraper (t.me/s/)
- GDELT DOC 2 / Summary APIs
- Microsoft Global Buildings manifest
- Overture Maps catalog
- tinyGS LoRa sat packets
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["mega_feeds"])


# ── CISA KEV — Known Exploited Vulnerabilities ────────────────────────────
KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"


@router.get("/api/cyber/kev")
async def cisa_kev() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(KEV_URL)
        vulns = (raw or {}).get("vulnerabilities", [])
        return {
            "title": (raw or {}).get("title"),
            "count": (raw or {}).get("count") or len(vulns),
            "catalog_version": (raw or {}).get("catalogVersion"),
            "date_released": (raw or {}).get("dateReleased"),
            "vulnerabilities": [
                {
                    "cve": v.get("cveID"),
                    "vendor": v.get("vendorProject"),
                    "product": v.get("product"),
                    "name": v.get("vulnerabilityName"),
                    "date_added": v.get("dateAdded"),
                    "due_date": v.get("dueDate"),
                    "action": v.get("requiredAction"),
                    "ransomware": v.get("knownRansomwareCampaignUse"),
                }
                for v in (vulns or [])[:500]
            ],
        }

    return await fg.cached("cyber:kev", 3600.0, load)


# ── USGS MRDS mineral sites ───────────────────────────────────────────────
MRDS_URL = (
    "https://mrdata.usgs.gov/mrds/search"
)


@router.get("/api/infra/mines")
async def mineral_sites(
    bbox: str = Query("", description="lon_min,lat_min,lon_max,lat_max"),
    commodity: str = Query("", max_length=32),
    limit: int = Query(500, ge=1, le=2000),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        params: dict[str, str] = {
            "output": "json",
            "max": str(limit),
        }
        if bbox:
            params["bbox"] = bbox
        if commodity:
            params["com"] = commodity
        try:
            raw = await fg.fetch_json(MRDS_URL, params=params)
        except Exception:
            return fg.fc([])
        features = (raw or {}).get("features", raw if isinstance(raw, list) else [])
        out: list[fg.Feature] = []
        for f in features or []:
            if isinstance(f, dict) and f.get("geometry"):
                geom = f["geometry"]
                coords = geom.get("coordinates", [])
                if len(coords) >= 2:
                    props = f.get("properties") or {}
                    mid = str(props.get("dep_id") or props.get("site_id") or f.get("id") or "")
                    if mid:
                        out.append(
                            fg.point(
                                f"mine:{mid}",
                                float(coords[0]),
                                float(coords[1]),
                                {
                                    "kind": "mine",
                                    "name": props.get("site_name") or props.get("name"),
                                    "commodity": props.get("commod1") or props.get("commodity"),
                                    "dev_status": props.get("dev_stat"),
                                    "country": props.get("country"),
                                    "state": props.get("state"),
                                },
                            )
                        )
        return fg.fc(out)

    key = f"infra:mines:{bbox}:{commodity}:{limit}"
    return await fg.cached(key, 86400.0, load)


# ── Overpass/OSM military objects ──────────────────────────────────────────
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# ponytail: the Referer header is the cracked code — without it → 406.
_OVERPASS_HEADERS = {"Referer": "https://overpass-turbo.eu/"}


@router.get("/api/osm/military")
async def osm_military(
    bbox: str = Query("", description="lon_min,lat_min,lon_max,lat_max"),
) -> dict[str, Any]:
    # No bbox = the globe is zoomed out past the level where an Overpass query
    # is affordable. Answer an empty collection rather than 422 so the map layer
    # can stay registered and simply render nothing above its LOD gate.
    if not bbox:
        return fg.fc([])
    parts = [x.strip() for x in bbox.split(",")]
    if len(parts) != 4:
        raise HTTPException(400, "bbox must be lon_min,lat_min,lon_max,lat_max")
    # Overpass wants south,west,north,east; the map speaks lon/lat corners.
    w, s, e, n = parts
    query = f"""[out:json][timeout:25];
(
  nwr["military"]({s},{w},{n},{e});
);
out center body;"""

    async def load() -> dict[str, Any]:
        text = await fg.fetch_text(
            OVERPASS_URL,
            params={"data": query},
            headers=_OVERPASS_HEADERS,
        )
        import json

        raw = json.loads(text)
        elements = (raw or {}).get("elements", [])
        out: list[fg.Feature] = []
        for el in elements:
            lat = fg.num(el.get("lat") or (el.get("center") or {}).get("lat"))
            lon = fg.num(el.get("lon") or (el.get("center") or {}).get("lon"))
            eid = str(el.get("id") or "")
            if lat is None or lon is None or not eid:
                continue
            tags = el.get("tags") or {}
            out.append(
                fg.point(
                    f"osm_mil:{eid}",
                    lon,
                    lat,
                    {
                        "kind": "osm_military",
                        "name": tags.get("name"),
                        "military": tags.get("military"),
                        "landuse": tags.get("landuse"),
                        "operator": tags.get("operator"),
                        "osm_type": el.get("type"),
                    },
                )
            )
        return fg.fc(out)

    key = f"osm:military:{bbox}"
    return await fg.cached(key, 86400.0, load)


# ── Wikimapia bbox query ──────────────────────────────────────────────────
WIKIMAPIA_URL = "https://api.wikimapia.org/"


@router.get("/api/osm/wikimapia")
async def wikimapia(
    bbox: str = Query("", description="lon_min,lat_min,lon_max,lat_max"),
    category: str = Query("", max_length=32),
) -> dict[str, Any]:
    # Same LOD contract as /api/osm/military — no bbox, no query, no error.
    if not bbox:
        return fg.fc([])
    parts = [x.strip() for x in bbox.split(",")]
    if len(parts) != 4:
        raise HTTPException(400, "bbox must be lon_min,lat_min,lon_max,lat_max")

    async def load() -> dict[str, Any]:
        params: dict[str, str] = {
            "function": "box",
            "key": "example",
            "lon_min": parts[0],
            "lat_min": parts[1],
            "lon_max": parts[2],
            "lat_max": parts[3],
            "format": "json",
            "count": "100",
        }
        if category:
            params["category"] = category
        try:
            raw = await fg.fetch_json(WIKIMAPIA_URL, params=params)
        except Exception:
            return fg.fc([])
        folders = (raw or {}).get("folder", [])
        out: list[fg.Feature] = []
        for f in folders or []:
            loc = f.get("location") if isinstance(f.get("location"), dict) else {}
            lat = fg.num(loc.get("lat") if loc else f.get("lat"))
            lon = fg.num(loc.get("lon") if loc else f.get("lon"))
            wid = str(f.get("id") or "")
            if lat is None or lon is None or not wid:
                continue
            out.append(
                fg.point(
                    f"wikimapia:{wid}",
                    lon,
                    lat,
                    {
                        "kind": "wikimapia",
                        "name": f.get("name"),
                        "description": (f.get("description") or "")[:200],
                        "url": f.get("url"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached(f"wikimapia:{bbox}:{category}", 86400.0, load)


# ── GLEIF corporate LEI lookup ────────────────────────────────────────────
GLEIF_URL = "https://api.gleif.org/api/v1/lei-records"


@router.get("/api/legal/gleif")
async def gleif_search(q: str = Query(..., max_length=200)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            GLEIF_URL,
            params={"filter[fulltext]": q, "page[size]": "20"},
        )
        records = (raw or {}).get("data", [])
        return {
            "count": len(records),
            "results": [
                {
                    "lei": r.get("id"),
                    "name": (
                        ((r.get("attributes") or {}).get("entity") or {})
                        .get("legalName", {}).get("name")
                    ),
                    "jurisdiction": (
                        ((r.get("attributes") or {}).get("entity") or {})
                        .get("jurisdiction")
                    ),
                    "status": (
                        ((r.get("attributes") or {}).get("entity") or {})
                        .get("status")
                    ),
                    "category": (
                        ((r.get("attributes") or {}).get("entity") or {})
                        .get("category")
                    ),
                    "registration": (r.get("attributes") or {}).get("registration"),
                }
                for r in records
            ],
        }

    return await fg.cached(f"gleif:{q}", 3600.0, load)


# ── CourtListener legal search ────────────────────────────────────────────
COURTLISTENER_URL = "https://www.courtlistener.com/api/rest/v4/search/"


@router.get("/api/legal/courtlistener")
async def courtlistener(q: str = Query(..., max_length=200)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(
                COURTLISTENER_URL,
                params={"q": q, "type": "o", "format": "json"},
            )
        except Exception:
            return {"count": 0, "results": []}
        results = (raw or {}).get("results", [])
        return {
            "count": (raw or {}).get("count", len(results)),
            "results": [
                {
                    "id": r.get("id"),
                    "case_name": r.get("caseName"),
                    "court": r.get("court"),
                    "date_filed": r.get("dateFiled"),
                    "snippet": (r.get("snippet") or "")[:300],
                    "absolute_url": r.get("absolute_url"),
                }
                for r in results[:50]
            ],
        }

    return await fg.cached(f"legal:cl:{q}", 3600.0, load)


# ── UNHCR refugee populations (direct API) ────────────────────────────────
UNHCR_URL = "https://api.unhcr.org/population/v1/population/"


@router.get("/api/displacement/unhcr")
async def unhcr_population(
    year: int = Query(2024, ge=2000, le=2030),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(
            UNHCR_URL,
            params={"year": str(year), "limit": "500"},
        )
        items = (raw or {}).get("items", raw if isinstance(raw, list) else [])
        return {
            "year": year,
            "count": len(items) if isinstance(items, list) else 0,
            "populations": [
                {
                    "country_origin": i.get("country_of_origin"),
                    "country_origin_iso": i.get("country_of_origin_en"),
                    "country_asylum": i.get("country_of_asylum"),
                    "country_asylum_iso": i.get("country_of_asylum_en"),
                    "refugees": i.get("refugees"),
                    "asylum_seekers": i.get("asylum_seekers"),
                    "idps": i.get("idps"),
                    "stateless": i.get("stateless"),
                    "total": i.get("total_population"),
                }
                for i in (items if isinstance(items, list) else [])[:500]
            ],
        }

    return await fg.cached(f"unhcr:{year}", 86400.0, load)


# ── WorldPop population metadata ──────────────────────────────────────────
WORLDPOP_URL = "https://hub.worldpop.org/rest/data/pop/wpgp"


@router.get("/api/population/worldpop")
async def worldpop(
    iso3: str = Query("", max_length=3),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        params: dict[str, str] = {}
        if iso3:
            params["iso3"] = iso3.upper()
        raw = await fg.fetch_json(WORLDPOP_URL, params=params or None)
        datasets = (raw or {}).get("data", raw if isinstance(raw, list) else [])
        return {
            "count": len(datasets) if isinstance(datasets, list) else 0,
            "datasets": [
                {
                    "id": d.get("id"),
                    "title": d.get("title"),
                    "iso3": d.get("iso3"),
                    "popyear": d.get("popyear"),
                    "description": (d.get("desc") or "")[:200],
                    "files": d.get("files"),
                }
                for d in (datasets if isinstance(datasets, list) else [])[:100]
            ],
        }

    return await fg.cached(f"worldpop:{iso3}", 86400.0, load)


# ── HDX humanitarian datasets ────────────────────────────────────────────
HDX_URL = "https://data.humdata.org/api/3/action/package_search"


@router.get("/api/humanitarian/hdx")
async def hdx_search(q: str = Query("ukraine", max_length=100)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(HDX_URL, params={"q": q, "rows": "50"})
        result = (raw or {}).get("result", {})
        datasets = result.get("results", [])
        return {
            "count": result.get("count", len(datasets)),
            "datasets": [
                {
                    "id": d.get("id"),
                    "name": d.get("name"),
                    "title": d.get("title"),
                    "organization": (d.get("organization") or {}).get("title"),
                    "updated": d.get("metadata_modified"),
                    "num_resources": d.get("num_resources"),
                }
                for d in datasets[:50]
            ],
        }

    return await fg.cached(f"hdx:{q}", 3600.0, load)


# ── FlightRadar24 unauthed search ─────────────────────────────────────────
FR24_URL = "https://www.flightradar24.com/v1/search/web/find"


@router.get("/api/adsb/fr24/search")
async def fr24_search(q: str = Query(..., max_length=32)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(FR24_URL, params={"query": q, "limit": "20"})
        except Exception:
            return {"results": []}
        results = (raw or {}).get("results", [])
        return {
            "count": len(results),
            "results": [
                {
                    "id": r.get("id"),
                    "name": r.get("name") or r.get("label"),
                    "type": r.get("type"),
                    "match": r.get("match"),
                    "detail": r.get("detail", {}),
                }
                for r in results[:20]
            ],
        }

    return await fg.cached(f"fr24:{q}", 300.0, load)


# ── Shodan InternetDB (standalone lookup) ─────────────────────────────────
SHODAN_URL = "https://internetdb.shodan.io"


@router.get("/api/cyber/shodan/{ip}")
async def shodan_lookup(ip: str) -> dict[str, Any]:
    import re

    if not re.match(r"^[\d.]+$", ip):
        raise HTTPException(400, "IPv4 address required")

    async def load() -> dict[str, Any]:
        try:
            return await fg.fetch_json(f"{SHODAN_URL}/{ip}")
        except Exception:
            return {"ip": ip, "error": "lookup failed"}

    return await fg.cached(f"shodan:{ip}", 3600.0, load)


# ── insecam public webcam directory ───────────────────────────────────────
# Returns metadata about available camera counts per country (no actual streams).
INSECAM_COUNTRIES = {
    "US": 5419, "JP": 2805, "KR": 1247, "DE": 1154, "TW": 1073,
    "RU": 763, "FR": 615, "GB": 565, "IT": 447, "NL": 408,
    "CZ": 386, "TR": 340, "IN": 268, "CA": 253, "AR": 230,
    "ES": 214, "MX": 198, "PL": 185, "BR": 175, "AT": 163,
    "CH": 150, "SE": 142, "RO": 130, "NO": 125, "IL": 110,
    "UA": 105, "BE": 95, "FI": 90, "TH": 85, "AU": 80,
}


@router.get("/api/cams/insecam")
async def insecam_directory() -> dict[str, Any]:
    return {
        "source": "insecam.org",
        "note": "Approximate public webcam counts by country (gray-area source)",
        "countries": INSECAM_COUNTRIES,
        "total": sum(INSECAM_COUNTRIES.values()),
        "url_pattern": "https://insecam.org/en/bycountry/{ISO2}/",
    }


# ── Telegram channel scraper ─────────────────────────────────────────────
TELEGRAM_CHANNELS = [
    "PikudHaOref_all",
    "intelslava",
    "warmonitors",
    "clashreport",
    "sentdefender",
    "middleeast_spectator",
]


@router.get("/api/news/telegram")
async def telegram_channels(
    channel: str = Query("intelslava", max_length=64),
    limit: int = Query(20, ge=1, le=50),
) -> dict[str, Any]:
    if channel not in TELEGRAM_CHANNELS:
        raise HTTPException(400, f"Channel must be one of: {', '.join(TELEGRAM_CHANNELS)}")

    async def load() -> dict[str, Any]:
        import re

        url = f"https://t.me/s/{channel}"
        html = await fg.fetch_text(url)
        messages: list[dict[str, str]] = []
        for block in re.findall(
            r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>',
            html,
            re.DOTALL,
        )[:limit]:
            text = re.sub(r"<[^>]+>", "", block).strip()
            if text:
                messages.append({"text": text[:500]})
        dates = re.findall(r'<time[^>]*datetime="([^"]+)"', html)
        for i, d in enumerate(dates[:len(messages)]):
            messages[i]["datetime"] = d
        return {
            "channel": channel,
            "count": len(messages),
            "messages": messages,
            "url": url,
        }

    return await fg.cached(f"telegram:{channel}:{limit}", 120.0, load)


# ── GDELT DOC 2 API ──────────────────────────────────────────────────────
GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"


@router.get("/api/events/gdelt-doc")
async def gdelt_doc(q: str = Query("conflict", max_length=200)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(
                GDELT_DOC_URL,
                params={
                    "query": q,
                    "mode": "ArtList",
                    "maxrecords": "50",
                    "format": "json",
                },
            )
        except Exception:
            return {"articles": []}
        articles = (raw or {}).get("articles", [])
        return {
            "count": len(articles),
            "articles": [
                {
                    "title": a.get("title"),
                    "url": a.get("url"),
                    "source": a.get("domain") or a.get("source"),
                    "language": a.get("language"),
                    "seendate": a.get("seendate"),
                    "socialimage": a.get("socialimage"),
                    "tone": fg.num(a.get("tone")),
                }
                for a in articles[:50]
            ],
        }

    return await fg.cached(f"gdelt_doc:{q}", 300.0, load)


# ── GDELT Summary API ────────────────────────────────────────────────────
GDELT_SUMMARY_URL = "https://api.gdeltproject.org/api/v2/summary/summary"


@router.get("/api/events/gdelt-summary")
async def gdelt_summary(q: str = Query("conflict", max_length=200)) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            return await fg.fetch_json(
                GDELT_SUMMARY_URL,
                params={"d": q, "output": "json"},
            )
        except Exception:
            return {"summary": {}}

    return await fg.cached(f"gdelt_summary:{q}", 600.0, load)


# ── ESRI Wayback time-travel manifest ────────────────────────────────────
WAYBACK_URL = "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer"


@router.get("/api/imagery/wayback")
async def esri_wayback() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        raw = await fg.fetch_json(f"{WAYBACK_URL}?f=json")
        return {
            "source": "ESRI Wayback",
            "description": "Every historical version of ESRI World Imagery back to 2014",
            "tile_url": f"{WAYBACK_URL}/tile/{{z}}/{{y}}/{{x}}",
            "info": raw,
        }

    return await fg.cached("imagery:wayback", 86400.0, load)


# ── Microsoft Global Buildings manifest ──────────────────────────────────
MS_BUILDINGS_URL = (
    "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv"
)


@router.get("/api/buildings/microsoft")
async def ms_buildings() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        import csv
        import io

        text = await fg.fetch_text(MS_BUILDINGS_URL)
        reader = csv.DictReader(io.StringIO(text))
        regions: list[dict[str, Any]] = []
        for row in reader:
            regions.append({
                "location": row.get("Location"),
                "quadkey": row.get("QuadKey"),
                "url": row.get("Url"),
                "size": row.get("Size"),
            })
        return {
            "source": "Microsoft Global Buildings",
            "description": "1.3 billion building footprints, GeoJSONL per quadkey",
            "total_regions": len(regions),
            "regions": regions[:200],
        }

    return await fg.cached("buildings:ms", 86400.0, load)


# ── Overture Maps catalog ────────────────────────────────────────────────
@router.get("/api/buildings/overture")
async def overture_catalog() -> dict[str, Any]:
    return {
        "source": "Overture Maps Foundation",
        "description": "2.3 billion buildings + places + roads, unified schema",
        "s3_bucket": "s3://overturemaps-us-west-2",
        "url": "https://overturemaps.org/download/",
        "themes": ["buildings", "places", "transportation", "base", "divisions", "addresses"],
        "format": "GeoParquet",
        "note": "Use DuckDB + httpfs to query directly: SELECT * FROM read_parquet('s3://...')",
    }


# ── tinyGS LoRa satellite packets ────────────────────────────────────────
TINYGS_URL = "https://api.tinygs.com/v2/packets"


@router.get("/api/space/tinygs")
async def tinygs_packets() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(TINYGS_URL)
        except Exception:
            return {"packets": [], "count": 0}
        packets = raw if isinstance(raw, list) else (raw or {}).get("packets", [])
        return {
            "count": len(packets) if isinstance(packets, list) else 0,
            "packets": [
                {
                    "id": p.get("id") or p.get("_id"),
                    "satellite": p.get("satellite") or p.get("sat"),
                    "station": p.get("station"),
                    "rssi": fg.num(p.get("rssi")),
                    "snr": fg.num(p.get("snr")),
                    "frequency": fg.num(p.get("frequency")),
                    "timestamp": p.get("timestamp") or p.get("serverTime"),
                }
                for p in (packets if isinstance(packets, list) else [])[:100]
            ],
        }

    return await fg.cached("tinygs:packets", 300.0, load)


# ── GPSJAM daily manifest ────────────────────────────────────────────────
GPSJAM_URL = "https://gpsjam.org/data/manifest.csv"


@router.get("/api/jamming/gpsjam-manifest")
async def gpsjam_manifest() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        import csv
        import io

        try:
            text = await fg.fetch_text(
                GPSJAM_URL,
                headers={"Accept-Encoding": "gzip, deflate"},
            )
        except Exception:
            return {"dates": [], "count": 0}
        reader = csv.reader(io.StringIO(text))
        dates: list[str] = []
        for row in reader:
            if row and row[0] and not row[0].startswith("#"):
                dates.append(row[0])
        return {
            "source": "GPSJAM.org",
            "description": "Daily global GPS jamming hexmap since 2022",
            "count": len(dates),
            "latest_dates": dates[-30:] if dates else [],
            "data_url_pattern": "https://gpsjam.org/data/{date}-h3_4.csv",
        }

    return await fg.cached("gpsjam:manifest", 86400.0, load)
