# Commercial-licensing audit

Velocity ships as a paid SaaS, so every data source the **deployed** backend
touches must permit **commercial** use. This document records the per-source
licence verdict (researched, not assumed), the commercial-legal replacement, and
exactly what the code does about it.

The switch is `COMMERCIAL_MODE` (`Settings.commercial_mode`, default **False** so
local dev + tests keep the fuller non-commercial sources). The Cloudflare
Container sets `COMMERCIAL_MODE=1`. The gateway Worker also stamps each request
with `X-Velocity-Tier: paid|free`; `app/tier.py:resolve_commercial` turns that +
the deployment flag into a single "serve commercial-legal only?" boolean. A
paying customer is **always** served the commercial-legal set.

## Verdicts

| Source | Used for | Free licence | Commercial? | Action in `commercial_mode` |
|---|---|---|---|---|
| **OpenSky** `/states/all` | aircraft breadth (~13k) | research/NC; live-product use needs a written licence | ⚠️ operator-accepted | **KEPT, keyless/anonymous** — operator decision; see caveat below |
| **airplanes.live** `/v2/point` | dense aircraft overlay | non-commercial (paid tier exists) | ❌ | part of the union (NC) |
| **adsb.fi** | aircraft overlay | personal/non-commercial | ❌ | part of the union (NC) |
| **adsb.lol** | aircraft | **ODbL 1.0** | ✅ (attribution) | part of the union |
| theairtraffic / hpradar readsb | aircraft full-feed | community, licence unstated | ⚠️ unclear | part of the union |
| **CARTO** basemaps (cartocdn) | dark basemap | hosted tiles enterprise/non-profit only | ❌ | `COMMERCIAL_BASEMAP_URL` (OpenFreeMap/self-host); else client falls back to satellite |
| **EOX S2 cloudless** (tiles.maps.eox.at) | satellite z≤10 | CC BY-NC-SA 4.0 | ❌ | dropped → CDSE Sentinel-2 |
| **Esri** World Imagery | satellite z>10 | no commercial reuse w/o ArcGIS licence | ❌ | dropped (no sub-10 m hi-zoom) |
| **CDSE Sentinel-2** (Copernicus) | satellite | Copernicus open data | ✅ | **sole satellite source** (10 m), needs free CDSE OAuth client |
| **Maxar Open Data** | building imagery (VHR) | CC BY-NC 4.0 | ❌ | omitted from `/api/imagery/aoi`; Sentinel only |
| **Global Fishing Watch** | vessel identity enrich | CC BY-NC 4.0 | ❌ | disabled |
| **ACLED** | conflict events | NC; paid for commercial | ❌ | disabled → GDELT + EONET |
| **Open-Meteo** hosted | point weather | hosted endpoint is NC (data is CC BY) | ❌ | `/api/weather/openmeteo` 503; use NWS/SWPC or self-host |
| **Planespotters** | aircraft photos | photographer-copyright / NC API | ❌ | disabled |
| public **Overpass** / **Nominatim** | LOD1 buildings, geocode | OSM data ODbL ✅, but public instances forbid commercial/heavy use | ⚠️ | require `OVERPASS_URL` / `NOMINATIM_URL` self-host; else feature 503/empty |
| **CDSE**, **NASA** (FIRMS/GIBS/EONET), **NOAA** (SWPC/NWS), **USGS**, **Digitraffic FI** (CC BY), **Kystverket/Kystdatahuset NO** (NLOD), **GDELT**, **EMSC seismicportal**, **Celestrak**, **Wikipedia/Wikidata**, **Natural Earth**, **Cesium JS** (Apache-2.0) | various | open / public-domain / permissive | ✅ | kept |

Notes:
- **ADS-B is the full OpenSky-led union (keyless), even in `commercial_mode`** —
  an explicit operator decision to keep the ~13k breadth rather than fall back to
  adsb.lol-only. OpenSky's terms say live-product/commercial use needs a written
  licence and airplanes.live/adsb.fi are non-commercial, so this is a **known,
  accepted licensing risk** for the paid product; resolve it by obtaining an
  OpenSky commercial licence or running your own receivers. The
  `_do_global_fanout` source set is no longer gated by `commercial_mode`.
- CDSE serves satellite via the Process API (per-tile, rate-limited) — fine for
  light/AOI use; a busy global basemap may hit CDSE quotas, at which point add a
  paid raster provider. Sharp sub-metre imagery has no free commercial source.
- FIRMS needs a free `FIRMS_MAP_KEY`; CDSE needs a free OAuth client
  (`CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`).

## Operator follow-ups (cost / infra, not code)

1. **Satellite/basemap raster at scale** — set `COMMERCIAL_BASEMAP_URL` to an
   OpenFreeMap raster / self-hosted OSM render, or accept satellite-only. For
   sharp hi-zoom, add a paid provider (MapTiler/Mapbox/Bing).
2. **Self-host Overpass + Nominatim** — to keep LOD1 buildings + geocode in
   commercial mode (OSM data is ODbL; only the public instances are off-limits).
   Set `OVERPASS_URL` / `NOMINATIM_URL`.
3. **ADS-B licensing** — ADS-B keeps the keyless OpenSky-led union (~13k) by
   operator choice. To make it commercially clean, obtain an OpenSky commercial
   licence, run your own receivers, or licence adsbexchange / FlightAware.
4. **Attribution** — surface "© OpenStreetMap contributors / adsb.lol (ODbL)",
   "Contains modified Copernicus Sentinel data", Cesium, etc. in the UI footer.

## Sources

- [OpenSky terms](https://opensky-network.org/about/terms-of-use) ·
  [airplanes.live commercial](https://airplanes.live/commercial-use/) ·
  [adsb.lol licence (ODbL)](https://www.adsb.lol/privacy-license/) ·
  [adsb.fi opendata](https://github.com/adsbfi/opendata)
- [CARTO basemap licence](https://github.com/CartoDB/basemap-styles/blob/master/LICENSE.md) ·
  [OpenFreeMap (MIT)](https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md)
- [EOX S2 cloudless](https://s2maps.eu/) ·
  [Maxar Open Data (CC BY-NC)](https://www.maxar.com/open-data) ·
  [Esri terms](https://www.esri.com/en-us/legal/terms/web-site-service)
- [Global Fishing Watch commercial FAQ](https://globalfishingwatch.org/faqs/can-i-use-global-fishing-watch-apis-for-commercial-purposes/) ·
  [ACLED usage terms](https://acleddata.com/contentusage) ·
  [Open-Meteo licence](https://open-meteo.com/en/license)
