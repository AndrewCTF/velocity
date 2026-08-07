"""Master source catalog (2026-08-06 mega-ledger wave).

``/api/sources/catalog`` — structured metadata for every data source the
platform knows about, including tile providers the frontend consumes directly,
S3 archives, SDR directories, and download-only datasets.

This is the "phone book" an MCP agent or the Sources panel reads to discover
what data is available and how to access it. Live feeds that the backend
proxies are listed too (with their ``/api/…`` route) so the catalog is
complete.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from app.routes import _feedgeo as fg

router = APIRouter(tags=["source_catalog"])

# ── The catalog ───────────────────────────────────────────────────────────

CATALOG: list[dict[str, Any]] = [
    # ── SATELLITE IMAGERY TILES (keyless, global) ─────────────────────────
    {
        "id": "google_sat",
        "category": "satellite_tiles",
        "name": "Google Satellite XYZ",
        "url_pattern": "https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        "subdomains": "0-3",
        "resolution": "15cm (cities)",
        "format": "JPEG 256×256",
        "auth": "none",
        "note": "s=0-3 for load balancing",
    },
    {
        "id": "bing_aerial",
        "category": "satellite_tiles",
        "name": "Bing Aerial Quadkey",
        "url_pattern": "https://ecn.t{s}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg?g=1",
        "subdomains": "0-3",
        "resolution": "15-30cm",
        "format": "JPEG",
        "auth": "none",
        "note": "Quadkey encoding (see Bing Maps tile system docs)",
    },
    {
        "id": "esri_world_imagery",
        "category": "satellite_tiles",
        "name": "ESRI World Imagery",
        "url_pattern": "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "resolution": "15cm (Maxar)",
        "format": "JPEG",
        "auth": "none",
        "note": "Already used by the platform for high-zoom sat tiles",
    },
    {
        "id": "yandex_sat",
        "category": "satellite_tiles",
        "name": "Yandex Satellite",
        "url_pattern": "https://core-sat.maps.yandex.net/tiles?l=sat&v=3.1266.0&x={x}&y={y}&z={z}&lang=en_US",
        "resolution": "30-50cm",
        "format": "JPEG",
        "auth": "none",
    },
    {
        "id": "esri_wayback",
        "category": "satellite_tiles",
        "name": "ESRI Wayback Time-Travel",
        "url_pattern": "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        "manifest": "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer?f=json",
        "api_route": "/api/imagery/wayback",
        "note": "80+ releases back to 2014, each a complete imagery version",
    },

    # ── NATIONAL ORTHO AGENCIES ───────────────────────────────────────────
    {
        "id": "france_ign",
        "category": "national_ortho",
        "name": "France IGN Orthophoto",
        "url_pattern": "https://data.geopf.fr/annexes/ressources/wmts/ortho.xml",
        "resolution": "20cm",
        "protocol": "WMTS",
        "auth": "none",
        "country": "FR",
    },
    {
        "id": "spain_pnoa",
        "category": "national_ortho",
        "name": "Spain PNOA",
        "url_pattern": "https://www.ign.es/wmts/pnoa-ma",
        "resolution": "25cm",
        "protocol": "WMTS",
        "auth": "none",
        "country": "ES",
    },
    {
        "id": "czech_cuzk",
        "category": "national_ortho",
        "name": "Czech Republic CUZK Ortho",
        "url_pattern": "https://ags.cuzk.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer",
        "resolution": "20cm",
        "protocol": "WMS",
        "auth": "none",
        "country": "CZ",
    },
    {
        "id": "australia_nsw",
        "category": "national_ortho",
        "name": "NSW Spatial (Australia)",
        "url_pattern": "https://maps1.six.nsw.gov.au/arcgis/rest/services/sixmaps/LPI_Imagery_Best/MapServer",
        "resolution": "5-10cm",
        "protocol": "ArcGIS REST",
        "auth": "none",
        "country": "AU",
    },
    {
        "id": "swiss_swisstopo",
        "category": "national_ortho",
        "name": "Swiss swisstopo SWISSIMAGE",
        "url_pattern": "https://wmts.geo.admin.ch/1.0.0/WMTSCapabilities.xml",
        "resolution": "10cm",
        "protocol": "WMTS",
        "auth": "none",
        "country": "CH",
    },
    {
        "id": "canada_nrcan",
        "category": "national_ortho",
        "name": "Canada NRCan",
        "url_pattern": "https://maps.geogratis.gc.ca/wms/canvec_en",
        "resolution": "50cm-2m",
        "protocol": "WMS",
        "auth": "none",
        "country": "CA",
    },
    {
        "id": "netherlands_pdok",
        "category": "national_ortho",
        "name": "Netherlands PDOK Luchtfoto",
        "url_pattern": "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0",
        "resolution": "8cm",
        "protocol": "WMTS",
        "auth": "none",
        "country": "NL",
    },
    {
        "id": "germany_nrw",
        "category": "national_ortho",
        "name": "Germany NRW DOP",
        "url_pattern": "https://www.wms.nrw.de/geobasis/wms_nw_dop",
        "resolution": "20cm",
        "protocol": "WMS",
        "auth": "none",
        "country": "DE",
        "note": "16 states each have own geoportal",
    },
    {
        "id": "japan_gsi",
        "category": "national_ortho",
        "name": "Japan GSI Seamless Photo",
        "url_pattern": "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
        "resolution": "25cm",
        "protocol": "XYZ",
        "auth": "none",
        "country": "JP",
    },
    {
        "id": "korea_vworld",
        "category": "national_ortho",
        "name": "Korea VWORLD Satellite",
        "url_pattern": "https://xdworld.vworld.kr/2d/Satellite/service/{z}/{x}/{y}.jpeg",
        "resolution": "25cm",
        "protocol": "XYZ",
        "auth": "none",
        "country": "KR",
        "note": "Intermittent 502s",
    },

    # ── SAR DATA CATALOGS ─────────────────────────────────────────────────
    {
        "id": "umbra_sar",
        "category": "sar",
        "name": "Umbra Open SAR Data",
        "url_pattern": "https://umbra-open-data-catalog.s3.amazonaws.com/",
        "resolution": "16cm spotlight",
        "format": "GeoTIFF on S3",
        "auth": "none",
    },
    {
        "id": "capella_sar",
        "category": "sar",
        "name": "Capella Open Data",
        "url_pattern": "https://capella-open-data.s3.amazonaws.com/",
        "resolution": "50cm",
        "format": "GeoTIFF on S3",
        "auth": "none",
    },
    {
        "id": "sentinel1_stac",
        "category": "sar",
        "name": "Sentinel-1 (Element84 STAC)",
        "url_pattern": "https://earth-search.aws.element84.com/v1/",
        "resolution": "5-20m",
        "format": "STAC + COG",
        "auth": "none",
        "note": "Global 6-day revisit",
    },
    {
        "id": "nisar",
        "category": "sar",
        "name": "NISAR (NASA-ISRO)",
        "url_pattern": "https://api.daac.asf.alaska.edu/services/search/param?platform=NISAR&output=json",
        "resolution": "5-10m L+S band",
        "format": "ASF DAAC",
        "auth": "none",
        "note": "New 2025, global coverage",
    },

    # ── BUILDINGS / 3D DATA ───────────────────────────────────────────────
    {
        "id": "ms_buildings",
        "category": "buildings",
        "name": "Microsoft Global Buildings",
        "url_pattern": "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv",
        "api_route": "/api/buildings/microsoft",
        "count": "1.3 billion footprints",
        "format": "GeoJSONL per quadkey",
        "auth": "none",
    },
    {
        "id": "google_buildings",
        "category": "buildings",
        "name": "Google Open Buildings",
        "url_pattern": "https://sites.research.google/gr/open-buildings/",
        "count": "1.8 billion buildings",
        "coverage": "Africa, Asia, Latin America",
        "format": "CSV + GeoJSON",
        "auth": "none",
    },
    {
        "id": "overture_maps",
        "category": "buildings",
        "name": "Overture Maps",
        "url_pattern": "https://overturemaps-us-west-2.s3.amazonaws.com/",
        "api_route": "/api/buildings/overture",
        "count": "2.3 billion buildings + places + roads",
        "format": "GeoParquet",
        "auth": "none",
    },
    {
        "id": "usgs_lidar",
        "category": "buildings",
        "name": "USGS/Entwine LiDAR",
        "url_pattern": "https://usgs.entwine.io/",
        "format": "Potree / EPT",
        "auth": "none",
        "note": "US point clouds, streamable",
    },
    {
        "id": "hobu_lidar",
        "category": "buildings",
        "name": "HOBU LiDAR S3 Samples",
        "url_pattern": "https://s3.amazonaws.com/hobu-lidar/",
        "format": "COPC / LAZ",
        "auth": "none",
    },
    {
        "id": "plateau_japan",
        "category": "buildings",
        "name": "PLATEAU Japan 3D Cities",
        "url_pattern": "https://www.geospatial.jp/ckan/dataset",
        "count": "495 datasets, 200+ cities",
        "format": "CityGML + 3D Tiles",
        "auth": "none",
        "country": "JP",
    },
    {
        "id": "3dbag_netherlands",
        "category": "buildings",
        "name": "3DBAG Netherlands",
        "url_pattern": "https://data.3dbag.nl/",
        "note": "LOD1.3 for every Dutch building",
        "format": "CityJSON / OBJ / GPKG",
        "auth": "none",
        "country": "NL",
    },

    # ── WEATHER SATELLITE IMAGERY ─────────────────────────────────────────
    {
        "id": "goes16_s3",
        "category": "weather_imagery",
        "name": "GOES-16 (East) S3",
        "url_pattern": "https://noaa-goes16.s3.amazonaws.com/",
        "cadence": "Full disk every 10 min",
        "format": "NetCDF4",
        "auth": "none",
    },
    {
        "id": "goes18_s3",
        "category": "weather_imagery",
        "name": "GOES-18 (West) S3",
        "url_pattern": "https://noaa-goes18.s3.amazonaws.com/",
        "cadence": "Full disk every 10 min",
        "format": "NetCDF4",
        "auth": "none",
    },
    {
        "id": "himawari9_s3",
        "category": "weather_imagery",
        "name": "Himawari-9 (Asia-Pacific) S3",
        "url_pattern": "https://noaa-himawari9.s3.amazonaws.com/",
        "cadence": "Every 10 min",
        "format": "NetCDF4",
        "auth": "none",
    },
    {
        "id": "nexrad_s3",
        "category": "weather_imagery",
        "name": "NEXRAD Level 2 S3",
        "url_pattern": "https://noaa-nexrad-level2.s3.amazonaws.com/",
        "note": "Per-key access works; root listing denied",
        "format": "Binary radar",
        "auth": "none (per-key path)",
    },

    # ── SDR / RADIO DIRECTORIES ───────────────────────────────────────────
    {
        "id": "kiwisdr",
        "category": "sdr",
        "name": "KiwiSDR Network",
        "url_pattern": "http://kiwisdr.com/public/",
        "count": "~200 public SDRs",
        "note": "Tune HF/VHF remotely, raw audio via WebSocket",
    },
    {
        "id": "websdr",
        "category": "sdr",
        "name": "WebSDR Network",
        "url_pattern": "http://websdr.org/",
        "count": "~90 servers",
        "note": "Some with military airband",
    },
    {
        "id": "openwebrx",
        "category": "sdr",
        "name": "OpenWebRX Directory",
        "url_pattern": "https://receiverbook.de/",
        "note": "Directory + map of public OpenWebRX receivers",
    },
    {
        "id": "rx_tx_info",
        "category": "sdr",
        "name": "rx-tx.info SDR Map",
        "url_pattern": "https://rx-tx.info/map-sdr-points",
        "note": "Global SDR points of presence",
    },
    {
        "id": "sigidwiki",
        "category": "sdr",
        "name": "Signal Identification Wiki",
        "url_pattern": "https://www.sigidwiki.com/",
        "note": "Signal identification database (MediaWiki API)",
    },
    {
        "id": "pskreporter",
        "category": "sdr",
        "name": "PSK Reporter",
        "url_pattern": "https://pskreporter.info/",
        "note": "Live HF propagation/signals map",
    },
    {
        "id": "wsprnet",
        "category": "sdr",
        "name": "WSPRnet",
        "url_pattern": "https://wsprnet.org/",
        "note": "Weak-signal propagation reporter spots",
    },

    # ── GAUSSIAN SPLAT SOURCES ────────────────────────────────────────────
    {
        "id": "sketchfab_splats",
        "category": "splats",
        "name": "Sketchfab 3DGS Models",
        "url_pattern": "https://api.sketchfab.com/v3/search?type=models&q=gaussian+splat&downloadable=true",
        "note": "Paginated, direct download for CC models",
        "auth": "none",
    },
    {
        "id": "huggingface_splats",
        "category": "splats",
        "name": "HuggingFace Splat Datasets",
        "url_pattern": "https://huggingface.co/api/datasets?search=gaussian+splatting",
        "note": "Downloadable repos",
        "auth": "none",
    },
    {
        "id": "supersplat",
        "category": "splats",
        "name": "SuperSplat (PlayCanvas)",
        "url_pattern": "https://superspl.at/",
        "note": "Editor + gallery; assets on S3",
    },
    {
        "id": "polycam",
        "category": "splats",
        "name": "Polycam Explore",
        "url_pattern": "https://poly.cam/explore",
        "note": "Internal API via Next.js data: api.poly.cam/v2/assets",
    },
    {
        "id": "luma_ai",
        "category": "splats",
        "name": "Luma AI Explore",
        "url_pattern": "https://lumalabs.ai/explore",
        "note": "Capture .ply from viewer network tab",
    },
    {
        "id": "scaniverse",
        "category": "splats",
        "name": "Scaniverse Map",
        "url_pattern": "https://scaniverse.com/",
        "note": "Community map with .ply/.splat per post",
    },

    # ── SIGINT / ATC ──────────────────────────────────────────────────────
    {
        "id": "liveatc",
        "category": "sigint",
        "name": "LiveATC",
        "url_pattern": "https://www.liveatc.net/",
        "count": "1,300+ feeds",
        "note": "CF turnstile protected — use camoufox or archive",
        "archive": "https://archive.liveatc.net/",
    },
    {
        "id": "skyheinz",
        "category": "sigint",
        "name": "skyheinz.com AI-Transcribed ATC",
        "url_pattern": "https://skyheinz.com/",
        "note": "Singapore ATC (WSSS), audio+text via Next.js internal API",
    },
    {
        "id": "airframes",
        "category": "sigint",
        "name": "airframes.io",
        "url_pattern": "https://airframes.io/",
        "api_route": "/api/acars",
        "note": "ACARS/VDL2/HFDL/SATCOM decoded messages (already wired via acars.py)",
    },

    # ── ARCHIVES / HISTORY ────────────────────────────────────────────────
    {
        "id": "adsblol_history",
        "category": "archive",
        "name": "adsb.lol Globe History",
        "url_pattern": "https://github.com/adsblol/globe_history_2026/releases",
        "note": "Daily global aircraft snapshots as split .tar, every day since 2023",
    },
    {
        "id": "common_crawl",
        "category": "archive",
        "name": "Common Crawl Index",
        "url_pattern": "https://index.commoncrawl.org/",
        "note": "Whole web, queryable CDX index",
    },
    {
        "id": "wayback_cdx",
        "category": "archive",
        "name": "Wayback Machine CDX",
        "url_pattern": "https://web.archive.org/cdx/search",
        "api_route": "/api/osint/investigate (type=domain/url)",
        "note": "Historical web page snapshots, already wired via OSINT investigate",
    },
    {
        "id": "archive_atc",
        "category": "archive",
        "name": "archive.org ATC Collections",
        "url_pattern": "https://archive.org/advancedsearch.php?q=liveatc",
        "note": "Historical ATC audio recordings",
    },

    # ── TELEGRAM OSINT CHANNELS ───────────────────────────────────────────
    {
        "id": "telegram_osint",
        "category": "telegram",
        "name": "Telegram War OSINT Channels",
        "api_route": "/api/news/telegram",
        "channels": [
            "PikudHaOref_all",
            "intelslava",
            "warmonitors",
            "clashreport",
            "sentdefender",
            "middleeast_spectator",
        ],
        "scrape_pattern": "GET https://t.me/s/{channel} → parse div.tgme_widget_message_text",
    },

    # ── REFERENCE DATASETS ───────────────────────────────────────────────
    {
        "id": "natural_earth",
        "category": "reference",
        "name": "Natural Earth",
        "url_pattern": "https://www.naturalearthdata.com/",
        "note": "Borders, admin boundaries, physical features",
    },
    {
        "id": "ourairports",
        "category": "reference",
        "name": "OurAirports",
        "url_pattern": "https://davidmegginson.github.io/ourairports-data/airports.csv",
        "count": "85,820 airports + navaids + runways + frequencies",
        "api_route": "/api/places/airports",
        "note": "Wired via static data files in places/",
    },
    {
        "id": "openflights",
        "category": "reference",
        "name": "OpenFlights",
        "url_pattern": "https://github.com/jpatokal/openflights/tree/master/data",
        "note": "Airport DB + routes",
    },
    {
        "id": "nga_wpi",
        "category": "reference",
        "name": "NGA World Port Index",
        "url_pattern": "https://msi.nga.mil/api/publications/download?type=view&key=16694622/SFH00000/UpdatedPub150.csv",
        "count": "3,818 ports",
        "api_route": "/api/places/ports",
        "note": "Wired via static data in places/; CSV endpoint 503s intermittently",
    },

    # ── STREAMING / WEBSOCKET ─────────────────────────────────────────────
    {
        "id": "aisstream",
        "category": "streaming",
        "name": "aisstream.io",
        "url_pattern": "wss://stream.aisstream.io/v0/stream",
        "auth": "free GitHub OAuth",
        "note": "Global AIS WebSocket; requires API key from GitHub login",
    },
    {
        "id": "datalastic",
        "category": "streaming",
        "name": "Datalastic AIS REST",
        "url_pattern": "https://api.datalastic.com/",
        "auth": "free tier key",
    },

    # ── MISC ──────────────────────────────────────────────────────────────
    {
        "id": "gem_tracker",
        "category": "infra",
        "name": "Global Energy Monitor",
        "url_pattern": "https://globalenergymonitor.org/",
        "note": "Oil/gas/coal/nuclear plants + pipelines trackers",
    },
    {
        "id": "google_3d",
        "category": "buildings",
        "name": "Google Photoreal 3D Tiles",
        "url_pattern": "https://tile.googleapis.com/v1/3dtiles/root.json",
        "auth": "API key required",
        "note": "Extractable from Maps JS API; key required",
    },
    {
        "id": "n2yo",
        "category": "space",
        "name": "N2YO Satellite Tracking",
        "url_pattern": "https://api.n2yo.com/",
        "auth": "free API key",
        "note": "Above/passes endpoints",
    },
]


@router.get("/api/sources/catalog")
async def source_catalog(
    category: str = Query("", max_length=32),
) -> dict[str, Any]:
    """Complete catalog of data sources the platform knows about."""
    items = CATALOG
    if category:
        items = [c for c in items if c.get("category") == category]
    categories = sorted({c["category"] for c in CATALOG})
    return {
        "total": len(items),
        "categories": categories,
        "sources": items,
    }


# ── SDR station search (live fetch from KiwiSDR public list) ─────────────
KIWISDR_URL = "http://kiwisdr.com/public/"


@router.get("/api/sdr/kiwisdr")
async def kiwisdr_stations() -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        import json
        import re

        try:
            html = await fg.fetch_text(KIWISDR_URL)
        except Exception:
            return {"stations": [], "count": 0}
        match = re.search(r"var\s+kiwi_public\s*=\s*(\[.*?\]);", html, re.DOTALL)
        if not match:
            return {"stations": [], "count": 0, "note": "Could not parse station list"}
        try:
            stations = json.loads(match.group(1))
        except Exception:
            return {"stations": [], "count": 0}
        out: list[fg.Feature] = []
        for s in stations:
            if not isinstance(s, dict):
                continue
            gps = s.get("gps")
            if not isinstance(gps, list) or len(gps) < 2:
                continue
            lat = fg.num(gps[0])
            lon = fg.num(gps[1])
            if lat is None or lon is None:
                continue
            sid = str(s.get("id") or s.get("url") or "")[:32]
            if not sid:
                continue
            out.append(
                fg.point(
                    f"kiwisdr:{sid}",
                    lon,
                    lat,
                    {
                        "kind": "sdr_station",
                        "name": s.get("name"),
                        "url": s.get("url"),
                        "bands": s.get("bands"),
                        "users": s.get("users"),
                        "users_max": s.get("users_max"),
                        "antenna": s.get("antenna"),
                    },
                )
            )
        return fg.fc(out)

    return await fg.cached("sdr:kiwisdr", 3600.0, load)


# ── Sketchfab splat search (live) ────────────────────────────────────────
SKETCHFAB_URL = "https://api.sketchfab.com/v3/search"


@router.get("/api/splats/search")
async def splat_search(
    q: str = Query("gaussian splat", max_length=100),
    limit: int = Query(24, ge=1, le=100),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(
                SKETCHFAB_URL,
                params={
                    "type": "models",
                    "q": q,
                    "downloadable": "true",
                    "count": str(limit),
                },
            )
        except Exception:
            return {"results": [], "count": 0}
        results = (raw or {}).get("results", [])
        return {
            "count": len(results),
            "results": [
                {
                    "uid": r.get("uid"),
                    "name": r.get("name"),
                    "uri": r.get("uri"),
                    "viewerUrl": r.get("viewerUrl"),
                    "thumbnails": (
                        (r.get("thumbnails") or {}).get("images", [{}])[0].get("url")
                        if r.get("thumbnails") else None
                    ),
                    "user": (r.get("user") or {}).get("displayName"),
                    "license": (r.get("license") or {}).get("label"),
                    "faceCount": r.get("faceCount"),
                    "vertexCount": r.get("vertexCount"),
                    "publishedAt": r.get("publishedAt"),
                }
                for r in results
            ],
        }

    return await fg.cached(f"splats:{q}:{limit}", 3600.0, load)


# ── HuggingFace splat datasets ───────────────────────────────────────────
HF_URL = "https://huggingface.co/api/datasets"


@router.get("/api/splats/huggingface")
async def hf_splat_datasets(
    q: str = Query("gaussian splatting", max_length=100),
) -> dict[str, Any]:
    async def load() -> dict[str, Any]:
        try:
            raw = await fg.fetch_json(HF_URL, params={"search": q, "limit": "30"})
        except Exception:
            return {"datasets": [], "count": 0}
        items = raw if isinstance(raw, list) else []
        return {
            "count": len(items),
            "datasets": [
                {
                    "id": d.get("id"),
                    "author": d.get("author"),
                    "downloads": d.get("downloads"),
                    "likes": d.get("likes"),
                    "tags": d.get("tags"),
                    "lastModified": d.get("lastModified"),
                }
                for d in items[:30]
            ],
        }

    return await fg.cached(f"hf_splats:{q}", 3600.0, load)
