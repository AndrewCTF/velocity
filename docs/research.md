# Building a Single-Analyst OSINT Geospatial Monitoring Platform: A Technical Architecture and Free-Data Field Manual

## TL;DR
- **Build it on CesiumJS** (3D globe, 4D timeline, 3D Tiles, SceneMode 2D fallback) backed by **Cesium ion's free tier** for terrain/OSM Buildings, with a Python (FastAPI) backend that proxies and caches data from a curated set of **truly-free** feeds — OpenSky (ADS-B, OAuth2), AISStream.io (AIS WebSocket), Global Fishing Watch v3 (SAR + AIS-gap), Copernicus Data Space Ecosystem (Sentinel-1/2/3/5P + OAuth2), NASA FIRMS, USGS, and ACLED — into a PostGIS + TimescaleDB store.
- **Be explicit about what "free" means.** Fully-free/open: OpenSky, ADSB.lol, airplanes.live, adsb.fi, AISStream, Digitraffic, Danish Maritime Authority, Copernicus Data Space (Sentinel data downloads), NASA Earthdata/FIRMS/GIBS, USGS, OpenStreetMap/Overpass, GPSJam.org. Freemium with hard credit limits you can hit in a day: Cesium ion (Community tier storage/streaming caps), Sentinel Hub on CDSE (10,000 Processing Units/month), Google Photorealistic 3D Tiles via Map Tiles API (billing required; under the March 2025 SKU model, Photorealistic 3D Tiles is in the Enterprise category with **1,000 free events/month** while 2D Map Tiles get 100,000 free events/month), Windy Webcams (free key, low-resolution images, 10-minute image-URL token validity in the free tier vs. 24 h in pro), MarineTraffic/VesselFinder (effectively rate-throttled marketing tiers).
- **Phase the build.** MVP in 1–2 weeks: a single Cesium viewport with OpenSky + AISStream + FIRMS + USGS overlays. Phase 2: add CZML-driven historical replay, Sentinel-1 SAR ship detection, GFW dark-vessel layer, GPSJam tile overlay. Phase 3: 3D-Tiles cityscapes (Cesium OSM Buildings, optionally Google Photorealistic), correlated alerting, and a 2D fallback for low-end clients.

---

## Key Findings

1. **Maritime OSINT is the single most accessible domain.** AISStream.io provides a free, registration-only, global AIS WebSocket; Digitraffic Finland and the Danish Maritime Authority publish open AIS without keys; Global Fishing Watch's v3 API provides both AIS-derived events and **SAR dark-vessel detections (dataset `public-global-sar-presence:latest`)** with `matched=false` to isolate dark ships. Paolo, Kroodsma, Raynor et al. (*Nature* vol. 625, pp. 85–91, 3 Jan 2024, DOI 10.1038/s41586-023-06825-8) — the paper underlying GFW's SAR layer — found that **72–76% of the world's industrial fishing vessels are not publicly tracked**, which is why an integrated AIS+SAR view materially changes situational awareness.
2. **Aviation is similarly open** through OpenSky (OAuth2 client-credentials, 4,000 credits/day for authenticated users, 8,000 if you feed) and the ADS-B aggregator constellation (ADSB.lol, adsb.fi, airplanes.live — all ~1 req/sec, no auth, ODbL or non-commercial).
3. **GPS jamming detection is reproducible at home** using ADS-B NACp/NIC fields per the GPSJam.org methodology — feed any of the public ADS-B firehoses through the same hex-binning algorithm, or simply overlay GPSJam's daily tiles.
4. **Satellite imagery is solved by Copernicus Data Space Ecosystem (CDSE) + NASA Earthdata + Microsoft Planetary Computer + USGS M2M.** Together these cover Sentinel-1 SAR, Sentinel-2/3/5P, Landsat 8/9, MODIS/VIIRS thermal, GEDI/ICESat-2 LiDAR, EMIT hyperspectral, Copernicus GLO-30 DEM, and Black Marble nightlights — all behind a free OAuth or Earthdata Login token, with STAC discovery.
5. **3D buildings are essentially free worldwide via Cesium OSM Buildings (Asset ID 96188)**; Google Photorealistic 3D Tiles add photogrammetry over **49 countries and 2,500+ cities** (per Google Maps Platform: *"Access photorealistic 3D Tiles in over 49 countries, and 2D Tiles in 250+ countries and territories"*) but are *not* free past the Enterprise-SKU monthly free cap and require Google Cloud billing — treat as a "money-on-file" component.
6. **CesiumJS is the unique platform** that natively supports 3D Tiles, CZML time-dynamic entities, a 4D clock/timeline widget, *and* a 2D-Columbus-2.5D-globe switch in a single viewer. MapLibre GL JS v5+ now has globe projection and 3D extrusions and is the recommended 2D-mode renderer if you need a Cesium-free fallback.

---

## Details

### 1. Maritime / AIS Vessel Tracking

| Source | What you get | Auth & registration | Endpoint | Free-tier limits |
|---|---|---|---|---|
| **AISStream.io** | Global AIS WebSocket stream (PositionReport, ShipStaticData, base-station, SAR-aircraft) | GitHub/Google login → API Keys page → generate key | `wss://stream.aisstream.io/v0/stream` | 1 subscription update/sec; unlimited messages; bbox + MMSI (≤50) + message-type filters; beta API may change |
| **Global Fishing Watch v3** | AIS apparent fishing, vessel ID, encounters, loitering, port visits, **SAR detections (incl. dark/unmatched)** | Register at globalfishingwatch.org → request API token (non-commercial) | `https://gateway.api.globalfishingwatch.org/v3/...` (Bearer token) | Non-commercial; SAR tileset `public-global-sar-presence:latest` |
| **Digitraffic Finland (Fintraffic)** | Baltic AIS positions + metadata; HTTP & MQTT-over-WSS | No key; identify with `Digitraffic-User: AppName/version` header | REST: `https://meri.digitraffic.fi/api/ais/v1/locations`, `…/vessels`; MQTT: `meri.digitraffic.fi:443` (TLS WebSockets, topic `vessels-v2/#`) | CC BY 4.0; class-A only; fishing vessels (type 30) filtered out |
| **Danish Maritime Authority (DMA)** | Historical bulk AIS (Baltic/North Sea) | None | `http://web.ais.dk/aisdata/` (daily CSV, ~1.5–2.6 GB/day; archive to 2006) | Free reuse under Danish PSI Act (act 596); attribute DMA |
| **BarentsWatch / Kystverket** | Norwegian coastal AIS | Free account at barentswatch.no → request API access; OAuth2 client credentials | `https://www.barentswatch.no/bwapi/` | Rate-limited; some sub-services require approval |
| **aprs.fi (AIS via APRS)** | AIS positions visible to APRS gateways | Free aprs.fi account | `https://api.aprs.fi/api/get` (params: `name`, `apikey`) | 1 req/5 s; ~20 stations per query |
| **MarineTraffic (REST)** | Vessel positions / port calls / events | Account → "API Services" → trial key | `https://services.marinetraffic.com/api/...` | Effectively paid; trial credits only — flag as **not free** |
| **VesselFinder** | Positions, vessel master data | Account → API plan request | `https://api.vesselfinder.com/` | No usable free tier; marketing trial only |
| **Spire Maritime** | Historical & live AIS | Enterprise contact only | n/a | **No public free tier** — list for completeness, do not depend on it |

**Registration walkthrough — AISStream.io:**
1. Go to `https://aisstream.io/authenticate`, sign in with GitHub.
2. Navigate to **API Keys** → **Create Key** → copy the token.
3. Connect to `wss://stream.aisstream.io/v0/stream` and within 3 seconds send a JSON subscription object containing `APIKey`, one or more `BoundingBoxes`, optional `FiltersShipMMSI` (≤50), and optional `FilterMessageTypes`. Failure to send within 3 s closes the socket.

```javascript
const ws = new WebSocket("wss://stream.aisstream.io/v0/stream");
ws.onopen = () => ws.send(JSON.stringify({
  APIKey: process.env.AISSTREAM_KEY,
  BoundingBoxes: [[[-90,-180],[90,180]]],
  FilterMessageTypes: ["PositionReport","ShipStaticData"]
}));
ws.onmessage = e => handle(JSON.parse(e.data));
```

**Registration walkthrough — Global Fishing Watch:**
1. Sign up at `https://globalfishingwatch.org/our-apis/tokens` (Google/Facebook/email).
2. Accept the non-commercial terms; describe your use case (1 working day approval).
3. Generate an API Access Token (JWT) and pass it as `Authorization: Bearer <TOKEN>`.
4. For SAR dark-vessel queries, hit the 4Wings API with the dataset `public-global-sar-presence:latest` and filter on `matched=false`.

### 2. Dark Ship / Dark Vessel Detection

Four complementary techniques:

- **AIS-gap analysis**: detect MMSIs whose positions stop reporting for >N hours while last position is in an AOI. Implement directly in your TimescaleDB ingest (window function over `gap_ms`).
- **SAR vessel detection (Sentinel-1)**: GRD IW VV/VH dual-pol products give all-weather, day/night ship detection at ~20 m. Workflows:
  - **ESA SNAP S-1 Toolbox** (free desktop): Apply Orbit File → Calibration → Land/Sea Mask → CFAR detector.
  - **SUMO (JRC, open source)** — Search for Unidentified Maritime Objects, the JRC reference detector (Greidanus et al.).
  - **Allen Institute / Ai2 `allenai/vessel-detection-sentinels`** — production model behind the free **Skylight** platform (`https://allenai.org/skylight`); runs on Sentinel-1 GRD and Sentinel-2 EO/IR. Repo description: *"tools that can be used to detect vessels in synthetic aperture radar (SAR) imagery produced by the Sentinel-1 satellite constellation, and electro-optical (EO) and infrared (IR) imagery produced by the Sentinel-2 satellite constellation."*
  - **`MJCruickshank/SARfish`** — single-script PyTorch detector with GeoJSON output and onshore-filter shapefile.
- **Optical "dark" detection**: Sentinel-2 / Landsat 9 visual confirmation. NASA VIIRS Boat Detection product (VBD) flags nighttime fishing lights.
- **RF emitter geolocation from space** (HawkEye 360, Spire, Kleos, Unseenlabs): **no general free tier**. Best free proxy: cross-reference AISStream "base-station" reports with at-known-anchorages logic; supplement with KiwiSDR / WebSDR ground networks.
- **GFW as the integrating layer**: GFW publishes SAR detections matched/unmatched to AIS via the 4Wings API — easiest path to a "dark vessel" overlay without building your own detector. Underlying scientific basis: Paolo et al., *Nature* 625:85–91 (3 Jan 2024), DOI 10.1038/s41586-023-06825-8.
- **NISAR (NASA–ISRO) L-band SAR**: NISAR launched 30 July 2025 aboard ISRO's GSLV-F16 from Satish Dhawan Space Centre, was declared fully operational on 7 November 2025, entered science operations in early January 2026, and **released over 100,000 Level-1 to Level-3 L-band data products through the Alaska Satellite Facility DAAC in late February 2026** (per NASA Earthdata and ASF). Free with Earthdata Login; expect L-band complements C-band Sentinel-1 for ship detection in foliage/coastal regimes.

### 3. Aviation / ADS-B Flight Tracking

| Source | Auth | Endpoint | Limits |
|---|---|---|---|
| **OpenSky Network** | OAuth2 client_credentials (mandatory since 18 Mar 2026; new accounts since mid-Mar 2025) | `https://opensky-network.org/api/states/all` (token from `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`) | Anonymous 400 credits/day; authenticated 4,000/day; **active feeder 8,000/day**. Access token expires every 30 min. |
| **ADSB.lol** | None | `https://api.adsb.lol/v2/` (ADSBExchange-compatible) | Dynamic per environment load; respect 4xx; ODbL 1.0 |
| **adsb.fi** | None | `https://opendata.adsb.fi/api/v2/` | **1 req/sec public, 1 req/30 s feeder endpoint**; non-commercial only |
| **airplanes.live** | None | `https://api.airplanes.live/v2/` (`/hex/{hex}`, `/callsign/{cs}`, `/reg/{r}`, `/type/{t}`, `/squawk/{s}`, `/mil`, `/ladd`, `/pia`, `/point/{lat}/{lon}/{radius_nm≤250}`) | **1 request per second**; non-commercial |
| **tar1090 / dump1090** | Local | RTL-SDR receiver, port 30005 (BEAST), `/data/aircraft.json` | Self-hosted; antenna line-of-sight only |
| **ADS-B Exchange** | RapidAPI key | `https://adsbexchange-com1.p.rapidapi.com/` | Feeder access free; public RapidAPI tier paid |

**OpenSky registration (current — OAuth2 mandatory since 18 March 2026):** Per the official `openskynetwork/opensky-api` README: *"Since March 18, 2026, basic authentication with username and password is no longer supported. Authentication now uses the OAuth2 client credentials flow."*
1. Create account at `https://opensky-network.org/`.
2. Account page → **API Clients** → Create → name → copy `client_id` and download `credentials.json` (contains `client_secret`; **shown only once**).
3. Token exchange:
```bash
curl -X POST "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CID" -d "client_secret=$CSECRET"
```
4. Use returned `access_token` as `Authorization: Bearer …` against `/api/states/all?lamin=…&lomin=…&lamax=…&lomax=…`. Token is valid 30 min — cache and refresh.

### 4. Dark Flight Detection

ADS-B is voluntary outside specific airspaces; primary detection of non-transmitting aircraft is hard from open sources. Practical OSINT options:
- **MLAT** (multilateration) — OpenSky and ADSB.lol both publish MLAT-derived positions for Mode-S-only aircraft (transponder on but no GPS broadcast). In OpenSky state vectors, field 16 (`position_source`) = 2 indicates MLAT.
- **Primary radar gaps** — no civilian open feed; Flightradar24 publishes some derived "estimated" tracks but its data is licensed and **not free for redistribution**.
- **Indirect indicators**:
  - **Squawk codes** (7500 hijack / 7600 radio-failure / 7700 emergency) visible in ADSB.lol `/squawk/{code}`.
  - **Military/blocked PIA/LADD**: `https://api.airplanes.live/v2/mil`, `/ladd`, `/pia` aggregate FAA-blocked and military hex ranges.
  - **NIC=0 / NACp=0 events** without RFI context — possible spoofing or transponder fault.
- **NOTAMs/airspace closures** as a corroborating layer (FAA NOTAM Search API is public for federal NOTAMs; for ICAO global use Eurocontrol's NM B2B requires accreditation — not free).

### 5. GPS/GNSS Jamming and Spoofing Detection

**GPSJam.org methodology** (replicable): Every ADS-B position message carries `NACp` (Navigation Accuracy Category – position) and the operational-status message carries `NIC` (Navigation Integrity Category). FAA-compliant operation requires `NACp ≥ 8` and `NIC ≥ 7`; values below indicate the on-board GNSS is degraded. GPSJam.org bins position reports into H3 hexagons using `percent_bad = 100 × (bad - 1) / (good + bad)` and renders daily PNGs. To replicate:

1. Subscribe to OpenSky `states/all` (field 16 = position source) and to ADSB.lol `/v2/` (provides `nac_p`, `nic`, `sil`, `nac_v`).
2. Bin into H3 res-4 cells over 24-hour windows.
3. Compute and visualize as a heat-layer in Cesium.

Other open sources:
- **GPSJam tiles** (https://gpsjam.org/) are free to view; the maintainer does not currently publish a documented tile-API but the daily PNGs are stable enough to overlay as a custom imagery provider.
- **University of Texas / Stanford GPS Lab / Inside GNSS** publish papers and occasional event datasets (no live API).
- **Flightradar24 GPS jamming map** (flightradar24.com/data/gps-jamming) — visualization only, not a redistributable feed.
- **SkAI Data Services / community spoofing trackers** — informal, no formal API.

### 6. Satellite Imagery and Advanced Sensing

#### 6.1 Optical / Multispectral (EO)

| Provider | What | Auth | Endpoint | Free tier |
|---|---|---|---|---|
| **Copernicus Data Space Ecosystem** (Sentinel-1/2/3/5P + Landsat + Copernicus DEM + WorldCover) | Full archives | Keycloak account → OAuth2 client (`/auth/realms/CDSE/protocol/openid-connect/token`) | OData `https://catalogue.dataspace.copernicus.eu/odata/v1/`; STAC `https://stac.dataspace.copernicus.eu/v1`; Sentinel Hub `https://sh.dataspace.copernicus.eu/process/v1` | Downloads: 12 TB rolling 30-day, 4 concurrent, 20 MB/s/connection; Sentinel Hub processing **10,000 PU/month + 10,000 req/month (300 PU/min, 300 req/min)** per the official CDSE Quotas page |
| **USGS EarthExplorer / M2M API** | Landsat 4–9, ASTER, declassified imagery | NASA EROS account + M2M-API token request | `https://m2m.cr.usgs.gov/api/api/json/stable/` | Free; ≤3 concurrent downloads; ≤15 GB queued |
| **NASA Worldview / GIBS** | Pre-rendered tiles (MODIS, VIIRS, etc.) | None | WMTS: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{Layer}/default/{Time}/{TileMatrixSet}/{z}/{y}/{x}.{ext}` | Public; no key |
| **Element84 Earth Search (STAC)** | Sentinel-2 L2A COGs on AWS | None for search | `https://earth-search.aws.element84.com/v1` | Free STAC search; data on `s3://sentinel-cogs` (open) |
| **Microsoft Planetary Computer STAC** | 100+ collections, signed SAS tokens | Optional Subscription Key (free) | `https://planetarycomputer.microsoft.com/api/stac/v1` + `…/sas/v1/token/{collection}` | Anonymous works; key gives higher rate-limits |
| **Google Earth Engine** | Petabyte catalog, server-side compute | Earth Engine sign-up → non-commercial approval | Python `ee` / JS Code Editor / REST `https://earthengine.googleapis.com/` | Free for non-commercial; rate-limited concurrent tasks |
| **Sentinel Hub commercial** | Same APIs as CDSE Sentinel Hub | Sentinel Hub account | `https://services.sentinel-hub.com` | 30-day trial only; thereafter paid |

**CDSE registration walkthrough (most important single account for this build):**
1. Go to `https://dataspace.copernicus.eu` → REGISTER → confirm email → 2FA via TOTP recommended.
2. Dashboard → **User Settings → OAuth clients → Create**, give a name and expiry → copy `client_id` and `client_secret` (secret shown once).
3. Token:
```bash
curl -X POST \
  https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token \
  -d 'grant_type=client_credentials' -d "client_id=$CID" --data-urlencode "client_secret=$CSEC"
```
4. Use the returned `access_token` for STAC, OData, Sentinel Hub Process API, and openEO.

#### 6.2 SAR (Synthetic Aperture Radar)

- **Sentinel-1** via CDSE (above) and **Alaska Satellite Facility (ASF) Vertex** (`https://search.asf.alaska.edu`) — free Earthdata Login. **HyP3** (`https://hyp3-api.asf.alaska.edu/`) provides cloud-side RTC, InSAR coherence, and change-detection products on demand (free, with monthly job quota).
- **NISAR** (NASA–ISRO) L-band — launched 30 July 2025; in science operations since early Jan 2026; >100,000 L1–L3 products released via ASF DAAC in late February 2026.
- **Capella Space / ICEYE** — sample/community datasets occasionally available; no general free production API.
- Use cases: dark-vessel detection, change-detection over ports, InSAR for subsidence/military earthworks, all-weather AOI monitoring.

#### 6.3 Spaceborne LiDAR / Altimetry

- **ICESat-2 ATLAS** (ATL03 photon, ATL06 land/ice, ATL08 vegetation, ATL13 inland water) via NSIDC DAAC and **OpenAltimetry** (`https://openaltimetry.earthdatacloud.nasa.gov`). Auth: NASA Earthdata Login.
- **GEDI** L1B/L2A/L2B/L4A via LP DAAC / ORNL DAAC; same Earthdata Login. Use `earthaccess`:
```python
import earthaccess
auth = earthaccess.login(persist=True)         # prompts once, stores .netrc
results = earthaccess.search_data(short_name="GEDI02_A", bounding_box=bbox, temporal=("2023-01-01","2023-12-31"))
files = earthaccess.download(results, "./gedi")
```

#### 6.4 Hyperspectral

- **EMIT** (NASA ISS, VSWIR 60 m) — data via LP DAAC / Earthdata Search; Earthdata Login.
- **PRISMA** (ASI, Italy) — register at `https://prisma.asi.it`; free for science use, manual approval.
- **EnMAP** (DLR, Germany) — register at `https://planning.enmap.org`, free for science; requires proposal-like form.

#### 6.5 Thermal / Infrared

- **NASA FIRMS** — active fire from MODIS Terra/Aqua (MCD14DL), VIIRS S-NPP/NOAA-20/-21 (375 m). REST CSV: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{bbox|world}/{day_range}[/{date}]`. **MAP_KEY limit: 5,000 transactions per 10-minute rolling window.** Register: `https://firms.modaps.eosdis.nasa.gov/api/map_key/`.
- **Landsat TIRS, MODIS LST, VIIRS LST, ECOSTRESS** — Earthdata + STAC; ECOSTRESS via LP DAAC (`ECO_L2T_LSTE` etc.).

#### 6.6 RF Geolocation from Space

- HawkEye 360, Spire RF, Kleos, Unseenlabs — **no general free tier**. Mention for completeness; substitute with ground-based feeds (KiwiSDR network, WebSDR, the SDR.hu archive).

#### 6.7 Elevation / DEM

- **OpenTopography Global DEM REST API** — register at `https://portal.opentopography.org` → MyOpenTopo dashboard → request free API key. Endpoint:
`https://portal.opentopography.org/API/globaldem?demtype=COP30&south=...&north=...&west=...&east=...&outputFormat=GTiff&API_Key=...`
**Free quota: 200 calls / 24 hours (academic), 50 calls / 24 hours (non-academic); per-call area caps up to 4,050,000 km² for SRTMGL3/COP90, smaller for higher-resolution.** Supported `demtype` values: `SRTMGL3`, `SRTMGL1`, `SRTMGL1_E`, `COP30`, `COP90`, `NASADEM`, `AW3D30`, `EU_DTM`, `GEDI_L3`.
- **Copernicus GLO-30** also free via CDSE STAC and AWS Open Data (`s3://copernicus-dem-30m/`).
- **SRTM, ASTER GDEM** via Earthdata.

#### 6.8 Weather / Atmospheric

- **NOAA NWS API** (free, no key, attribute) `https://api.weather.gov`.
- **NASA GIBS** for cloud cover and aerosol layers (no key).
- **Copernicus CAMS / ERA5** via CDS API (free Climate Data Store account).
- **Open-Meteo** `https://api.open-meteo.com/v1/forecast` — no key, generous limits.

### 7. Open Public CCTV & Webcams

Use **only intentionally public** feeds.

- **Windy Webcams API v3** — `https://api.windy.com/webcams/api/v3/`. Header `x-windy-api-key: <KEY>`. **Free tier: low-resolution images only; image URL tokens expire after 10 minutes** (24 h in pro); listing offset capped at 1,000 (10,000 pro); the `all-webcams` bulk endpoint is pro-only. Register: `https://api.windy.com/keys`. **Cannot redistribute the images.**
- **State/Federal DOT camera APIs** (free, no key in most US states): California Caltrans `https://cwwp2.dot.ca.gov/data/d*/cctv/cctvStatusD*.json`; Washington WSDOT `https://wsdot.com/Traffic/api/`; NYSDOT 511NY (key on request); UK Highways England HALO API (open).
- **Public transit operator feeds**: TfL Open Data, MTA Bus Time, BART (no key or free key).
- Avoid Insecam-style aggregators that scrape unintentional public exposures — legal and ethical risk; **do not include in the build**.
- Many feeds are **HLS or MJPEG**; embed via `<video>` or `hls.js`. RTSP feeds need server-side transcoding (FFmpeg → HLS on the backend).

### 8. Other Valuable Free OSINT Layers

| Layer | Source | Endpoint | Auth |
|---|---|---|---|
| Fires (active hotspots) | NASA FIRMS | `https://firms.modaps.eosdis.nasa.gov/api/area/...` | MAP_KEY (5,000 / 10 min) |
| Earthquakes (real-time) | USGS | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` (and `/all_day`, `/significant_*`) + FDSN `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` | None |
| Lightning | Blitzortung (community) | `wss://ws*.blitzortung.org/` | None |
| Weather radar | NOAA MRMS / NEXRAD via Iowa State (IEM) `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi` | WMS | None |
| OSM | OpenStreetMap | Vector tiles via OpenFreeMap `https://tiles.openfreemap.org/`; Overpass API `https://overpass-api.de/api/interpreter` | None (be polite; ≤1 r/s) |
| Ship ports / anchorages | WPI / OSM / GFW anchorages dataset | various | None |
| NOTAMs | FAA NOTAM Search | `https://external-api.faa.gov/notamapi/v1/notams` | Free key via `faa.gov/api` |
| Conflict events | **ACLED** | `https://acleddata.com/api/acled/read` (OAuth password grant → 24 h access + 14 d refresh token; client_id `acled`) | Free non-commercial; institutional email required; default 5,000 rows/page |
| Nightlights | NASA Black Marble (VNP46) via GIBS WMTS or LP DAAC | GIBS for tiles, LP DAAC for source HDF5 | None / Earthdata for source |
| AIS-derived anomalies | GFW Events API (encounters, loitering, port visits) | `https://gateway.api.globalfishingwatch.org/v3/events` | Bearer token |

### 9. 3D Globe Engine — Comparison and Recommendation

| Engine | Globe | 3D Tiles | CZML / 4D time | 2D mode | Free | Best for |
|---|---|---|---|---|---|---|
| **CesiumJS** | ✅ true ellipsoidal | ✅ native | ✅ native Clock/Timeline | ✅ `SceneMode.SCENE2D` and `COLUMBUS_VIEW` (2.5D) | Open source (Apache 2.0); ion is freemium | **Recommended primary** |
| MapLibre GL JS v5+ | ✅ globe projection | Via plugins (deck.gl) | Manual | ✅ native | Open source | Lightweight 2D fallback / mobile |
| deck.gl | Via MapLibre | ✅ Tile3DLayer | Time via TripsLayer | ✅ | Open source | Big-data layers atop MapLibre |
| Globe.gl / Three.js | ✅ (custom) | Manual | Manual | ❌ | Open source | Demos, point art |
| NASA WorldWind Web | ✅ | Limited 3D Tiles | Limited | ✅ | Open source | Legacy projects |

**Recommendation:** CesiumJS for the primary canvas. Use MapLibre GL JS v5 with `setProjection({type:'globe'})` as a fallback at `/2d` for low-GPU clients (and as a backup if Cesium ion is unreachable).

```javascript
// minimal Cesium boot
Cesium.Ion.defaultAccessToken = ION_TOKEN;
const viewer = new Cesium.Viewer("cesiumContainer", {
  terrain: Cesium.Terrain.fromWorldTerrain(),     // Cesium World Terrain (ion)
  timeline: true, animation: true,
  baseLayerPicker: false, geocoder: false, sceneModePicker: true
});
// 2D switch:
viewer.scene.mode = Cesium.SceneMode.SCENE2D;     // or SCENE3D / COLUMBUS_VIEW
```

### 10. 3D Buildings

- **Cesium OSM Buildings (Asset 96188)** — global OSM-derived extrusions as 3D Tiles, **free with Cesium ion Community account**:
```javascript
const osmBuildings = await Cesium.createOsmBuildingsAsync();
viewer.scene.primitives.add(osmBuildings);
```
- **Google Photorealistic 3D Tiles** via Map Tiles API — high-fidelity photogrammetry over 49 countries / 2,500+ cities. **Freemium / requires GCP billing**. Under the **March 1, 2025 Google Maps Platform pricing model** (official "Google Maps Platform March 2025 changes" page: *"The previous $200 monthly credit is replaced with free usage thresholds for each Core Services SKU based on the selected tier"*), Photorealistic 3D Tiles is in the **Enterprise SKU category with 1,000 free events per month** (Essentials get 10,000, Pro 5,000). A single root tileset request supports at least three hours of subsequent tile fetches. Enable Map Tiles API and create an API key in Google Cloud Console; load via `Cesium.createGooglePhotorealistic3DTilesetAsync()` (CesiumJS ≥ 1.124) or
```javascript
const tileset = new Cesium.Cesium3DTileset({
  url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GMAP_KEY}`,
  showCreditsOnScreen: true
});
viewer.scene.primitives.add(tileset);
viewer.scene.globe.show = false;   // photoreal already covers globe
```
- **MapLibre extruded OSM** in 2D mode: in OpenFreeMap `bright` style the `building` layer with `fill-extrusion-height` / `fill-extrusion-base` properties gives free 3D buildings with no key.
- **deck.gl Tile3DLayer** can also load Cesium OSM Buildings or Google 3D Tiles outside CesiumJS.

### 11. Terrain

- **Cesium World Terrain** (quantized-mesh) — free via ion default token. `Cesium.Terrain.fromWorldTerrain()` above.
- **Copernicus GLO-30 / AWS Open Data** — tile it yourself (e.g., `cesium-terrain-builder` Docker) and self-host as static `.terrain` tiles if you want to avoid the ion quota.
- **MapTiler / Maptiler-derived demtiles** — not free at scale; avoid.

### 12. 4D Temporal Replay (CZML + Cesium Clock)

CesiumJS exposes a JulianDate clock and timeline widget; bind any entity's `position` to a `SampledPositionProperty` and Cesium interpolates and animates over the timeline. For larger datasets, emit CZML.

**Storage model (TimescaleDB hypertable):**
```sql
CREATE TABLE positions (
  ts        TIMESTAMPTZ NOT NULL,
  entity_id TEXT        NOT NULL,
  kind      TEXT        NOT NULL,   -- 'vessel'|'aircraft'|'sar_det'|'sat'
  lon       DOUBLE PRECISION,
  lat       DOUBLE PRECISION,
  alt       REAL,
  course    REAL,
  speed     REAL,
  raw       JSONB
);
SELECT create_hypertable('positions','ts');
CREATE INDEX ON positions (entity_id, ts DESC);
```

**Stream → CZML packet:**
```json
[
  {"id":"document","name":"replay","version":"1.0",
   "clock":{"interval":"2026-05-20T00:00:00Z/2026-05-20T23:59:59Z",
            "currentTime":"2026-05-20T00:00:00Z","multiplier":60,"range":"CLAMPED","step":"SYSTEM_CLOCK_MULTIPLIER"}},
  {"id":"ais:367719770","name":"M/V EXAMPLE",
   "availability":"2026-05-20T00:00:00Z/2026-05-20T23:59:59Z",
   "billboard":{"image":"/icons/ship.svg","scale":0.6},
   "label":{"text":"EXAMPLE","font":"11px sans-serif"},
   "position":{
     "epoch":"2026-05-20T00:00:00Z",
     "interpolationAlgorithm":"LAGRANGE",
     "interpolationDegree":2,
     "cartographicDegrees":[0,-80.21,25.83,0, 30,-80.20,25.82,0, 60,-80.19,25.81,0]
   }
  }
]
```

Programmatic equivalent (no CZML):
```javascript
const sp = new Cesium.SampledPositionProperty();
samples.forEach(s => sp.addSample(
  Cesium.JulianDate.fromIso8601(s.ts),
  Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt ?? 0)));
sp.setInterpolationOptions({ interpolationDegree:2, interpolationAlgorithm: Cesium.LagrangePolynomialApproximation });
sp.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
viewer.entities.add({ id, position: sp, path: { width:1, leadTime:0, trailTime:600 }, point:{ pixelSize:6 } });
```

Recommendations:
- Use **LINEAR** for AIS/ADS-B; **LAGRANGE degree 2–5** for satellites; **HERMITE** if you have velocity samples.
- For >5,000 simultaneous entities, batch into `Cesium.PointPrimitiveCollection` instead of entities, and update positions in a `viewer.clock.onTick` handler.
- For very long replays, segment by `TimeIntervalCollectionPositionProperty` so Cesium can discard unused intervals.

### 13. 2D Mode

Two implementations:
1. **In Cesium**: `viewer.scene.mode = Cesium.SceneMode.SCENE2D` — same data sources, same CZML, no code path divergence. Best when the analyst occasionally needs flat map for measurement or printing.
2. **MapLibre GL JS** at `/2d/` — recommended for mobile/low-end. Shared GeoJSON/protobuf endpoints; OpenFreeMap basemap; identical layer toggle config consumed differently. When to prefer 2D: dense point clusters (heatmaps), regulatory mapping, screenshots, slow GPUs.

```javascript
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/bright',
  center: [0,0], zoom: 2, pitch: 45, bearing: -17.6
});
map.on('style.load', () => map.setProjection({ type: 'globe' }));   // optional MapLibre globe
```

### 14. Overall Architecture

```
┌──────────── BROWSER (single analyst) ────────────┐
│  CesiumJS viewport  +  React control panel       │
│  - Layer toggles   - Timeline (Cesium Clock)     │
│  - Entity info     - Drawing/measurement         │
│  - 2D/3D switch    - Alert pop-overs             │
└──────────────────┬───────────────────────────────┘
                   │ HTTPS / WSS
┌──────────────────▼───────────────────────────────┐
│  FastAPI backend (uvicorn) — single VM/container │
│   ├─ /api/aviation/states          (cached OpenSky)
│   ├─ /api/ais/stream  (proxy WS → AISStream)     │
│   ├─ /api/sar/dark    (GFW v3)                   │
│   ├─ /api/firms       (NASA FIRMS)               │
│   ├─ /api/eq          (USGS GeoJSON)             │
│   ├─ /api/sentinel/process  (CDSE Sentinel Hub)  │
│   ├─ /api/czml/replay (entity_id, t0, t1)        │
│   └─ /api/tiles/*     (proxy + cache, hides keys)│
│   Workers (APScheduler / Celery beat):           │
│     - opensky_poller  every 10–15 s              │
│     - aisstream_consumer (long-running WSS)      │
│     - firms_poller    every 10 min               │
│     - gfw_dark_fetch  every 1 h                  │
│     - sentinel1_aoi_check daily                  │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│  PostgreSQL 16 + PostGIS 3.4 + TimescaleDB 2.x   │
│   - positions (hypertable, partitioned by week)  │
│   - events (FIRMS, eq, ACLED, anomalies)         │
│   - vessels, aircraft, sar_detections            │
│   - aois (PostGIS polygons)                      │
│   Redis (LRU cache for tiles & state vectors)    │
└───────────────────────────────────────────────────┘

Tile serving: pg_tileserv (vector) + titiler-pgstac (raster COGs).
Static assets: nginx (also handles CORS and key-hiding proxy).
```

**Stack:** Python 3.12 / FastAPI / SQLAlchemy / asyncpg / httpx / paho-mqtt / websockets / aiokafka (optional) / Celery+Redis / PostgreSQL+PostGIS+TimescaleDB / pg_tileserv / titiler. Frontend: TypeScript + Vite + CesiumJS + MapLibre GL JS + Tailwind.

**Sample backend OpenSky poller (with token cache):**
```python
import httpx, asyncio, time
TOKEN = {"value": None, "exp": 0}
async def token():
    if TOKEN["exp"] - 60 > time.time(): return TOKEN["value"]
    r = await httpx.AsyncClient().post(
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
        data={"grant_type":"client_credentials","client_id":CID,"client_secret":CSEC})
    j = r.json(); TOKEN["value"] = j["access_token"]
    TOKEN["exp"] = time.time() + j["expires_in"]; return TOKEN["value"]
async def poll(bbox):
    while True:
        t = await token()
        r = await httpx.AsyncClient().get(
            "https://opensky-network.org/api/states/all",
            params={"lamin":bbox[1],"lomin":bbox[0],"lamax":bbox[3],"lomax":bbox[2]},
            headers={"Authorization":f"Bearer {t}"})
        await ingest(r.json())
        await asyncio.sleep(15)
```

**Sample tile proxy (hides ion / Google keys, adds CORS):**
```python
@app.get("/tiles/google3d/{path:path}")
async def google3d(path: str, request: Request):
    upstream = f"https://tile.googleapis.com/v1/3dtiles/{path}"
    params = dict(request.query_params); params["key"] = GMAPS_KEY
    r = await client.get(upstream, params=params)
    return Response(r.content, media_type=r.headers["content-type"],
                    headers={"Access-Control-Allow-Origin":"*",
                             "Cache-Control":"public, max-age=86400"})
```

### 15. Interface / UX

- **Layer toggles**: collapsible left panel grouped by domain (Maritime, Aviation, Imagery, Hazards, Infrastructure). Per-layer opacity slider, temporal-range override, and "follow timeline" checkbox.
- **Timeline scrubber**: native Cesium `animation` + `timeline` widgets. Add a custom `<input type=range>` for slow scrub at 0.01× speed when correlating events.
- **Entity selection**: `viewer.selectedEntity` + a right-panel info card; render last-N positions as a sparkline; if AIS, query GFW `/v3/vessels/{id}` for enrichment.
- **Search**: combined ICAO24 / MMSI / IMO / callsign / vessel name. Backend hits PostGIS first, then the source API as fallback.
- **Drawing/annotation**: Cesium `EntityCollection` with `Polygon`/`PolylineGraphics` (or `terra-draw` if you use MapLibre); persist as PostGIS geometries.
- **Multi-feed correlation**: a `correlations` worker scans the last-N minutes for: (a) AIS gap > X hours + GFW SAR detection within Y km in the same window → mark "dark vessel candidate"; (b) NACp drop on ≥M aircraft in same H3 cell within 30 min → mark "GPS interference cluster"; (c) FIRMS thermal anomaly within Z km of a manufactured anchorage → flag.
- **Alerting**: WebSocket push to the UI + optional webhook (Slack/Matrix/Mastodon).
- **Performance**: limit `viewer.entities` to ≲5,000 visible; use Cesium 3D Tiles for huge static datasets (ports, infrastructure). Throttle CZML updates to ≥250 ms per batch. Use `requestRenderMode: true` to lower idle CPU.

### 16. Practical Implementation Notes

- **CORS**: most data sources do not send `Access-Control-Allow-Origin: *`. Run a backend proxy and cache responses.
- **Key security**: never ship Cesium ion, Google Maps, FIRMS MAP_KEY, or AISStream keys in client JS. Inject via backend, or use Cesium ion's "domain-restricted" tokens (configure in the ion dashboard).
- **Rate limits — operational ceilings to respect** (conservative):
  - OpenSky: ≤1 request / 5 s authenticated, ≤1 / 10 s anonymous.
  - AISStream: ≤1 subscription update / s (messages are unlimited).
  - FIRMS: ≤500 transactions / minute (5,000 / 10 min budget).
  - ADSB.lol / airplanes.live / adsb.fi public: 1 req / s; adsb.fi feeder endpoint: 1 req / 30 s.
  - CDSE Sentinel Hub: 300 PU/min, 300 req/min.
  - OpenTopography: 200 calls/day academic / 50/day non-academic.
- **Data licensing — what you may redistribute**:
  - Fully redistributable with attribution: Sentinel data (CDSE), Landsat (USGS), NASA data, USGS earthquakes, OSM (ODbL), Digitraffic (CC BY 4.0), Danish AIS (PSI Act + attribution), ADSB.lol (ODbL).
  - Attribution + non-commercial: OpenSky, ACLED, GFW, adsb.fi, airplanes.live, NASA FIRMS (CC0 / generally free; cite).
  - **Do NOT redistribute imagery/positions from**: Cesium ion premium assets, Google Photorealistic 3D Tiles (display-only, no caching beyond session), MarineTraffic/VesselFinder, Windy Webcams images, Flightradar24.

#### Phased build roadmap

| Phase | Scope | Effort |
|---|---|---|
| **MVP (Week 1–2)** | CesiumJS + ion default token; OpenSky poller; AISStream consumer; FIRMS layer; USGS earthquake layer; PostGIS only (no Timescale yet); 2D toggle. | 1 dev, 2 weeks |
| **Phase 2 (Week 3–6)** | TimescaleDB hypertable; CZML historical replay endpoint; GFW dark-vessel layer; Sentinel-1 SAR pull via CDSE + on-demand SARfish detection; Cesium OSM Buildings; OpenTopography terrain insets; layer panel & search. | 1 dev, 4 weeks |
| **Phase 3 (Week 7–10)** | GPSJam-style NACp aggregation from OpenSky+ADSB.lol; ACLED + NOTAM overlays; correlation engine; alerting; MapLibre `/2d` route; drawing/annotation; Google Photorealistic 3D Tiles toggle (opt-in, billing). | 1 dev, 4 weeks |
| **Phase 4 (Week 11+)** | InSAR change-detection pipeline (HyP3); EMIT hyperspectral AOI; AI-assisted SAR ship classifier (Ai2 model); multi-analyst auth. | open-ended |

### Consolidated API Registration Table

| Source | Registration URL | Auth | Truly free? |
|---|---|---|---|
| AISStream.io | https://aisstream.io | API key (GitHub login) | ✅ |
| Global Fishing Watch | https://globalfishingwatch.org/our-apis/tokens | Bearer JWT | ✅ (non-commercial) |
| Digitraffic Finland | none — identify via header | none | ✅ |
| Danish Maritime Authority | http://web.ais.dk/aisdata/ | none | ✅ |
| BarentsWatch | https://www.barentswatch.no/minside/ | OAuth2 | ✅ on request |
| OpenSky Network | https://opensky-network.org → Account → API Clients | OAuth2 client_credentials | ✅ (4k/8k credits/day) |
| ADSB.lol | none | none | ✅ |
| adsb.fi | none | none | ✅ (NC) |
| airplanes.live | none | none | ✅ (NC) |
| GPSJam | https://gpsjam.org | none (tile overlay) | ✅ |
| Copernicus Data Space (CDSE) | https://dataspace.copernicus.eu → Register → OAuth client | OAuth2 client_credentials | ✅ (with quotas) |
| Sentinel Hub on CDSE | same as CDSE | OAuth2 | ⚠️ 10,000 PU + 10,000 req/month |
| USGS EarthExplorer / M2M | https://ers.cr.usgs.gov/register + M2M access request | Token | ✅ |
| NASA Earthdata Login | https://urs.earthdata.nasa.gov | Token / .netrc | ✅ |
| NASA FIRMS | https://firms.modaps.eosdis.nasa.gov/api/map_key/ | MAP_KEY | ✅ (5,000/10 min) |
| NASA Worldview / GIBS | none | none | ✅ |
| Microsoft Planetary Computer | https://planetarycomputer.microsoft.com/account/request (optional) | Optional subscription key | ✅ |
| Google Earth Engine | https://earthengine.google.com/signup/ | OAuth | ✅ (non-commercial) |
| Element84 Earth Search STAC | none | none | ✅ |
| OpenTopography | https://portal.opentopography.org → MyOpenTopo | API_Key | ⚠️ 200/day academic, 50/day non-academic |
| ASF Vertex / HyP3 | https://urs.earthdata.nasa.gov | Earthdata | ✅ |
| USGS Earthquake | none | none | ✅ |
| ACLED | https://acleddata.com/register | OAuth password grant | ✅ (NC, institutional email) |
| Windy Webcams | https://api.windy.com/keys | API key header | ⚠️ low-res only, 10-min image URLs |
| Cesium ion | https://ion.cesium.com/signup | token | ⚠️ Community storage/streaming caps |
| Google Map Tiles API (Photorealistic 3D) | https://console.cloud.google.com → enable Map Tiles API + billing | API key/OAuth | ⚠️ 1,000 free Enterprise SKU events/month (post-March 2025 model) |
| FAA NOTAM | https://api.faa.gov | API key | ✅ |
| NOAA NWS | none | none | ✅ |
| Open-Meteo | none | none | ✅ |
| Blitzortung lightning | community | none | ✅ |

---

## Recommendations

1. **Start with the recommended stack**: CesiumJS + FastAPI + PostGIS/TimescaleDB + Redis + nginx. Do not introduce Kubernetes; this is a single-analyst tool. A single 4-vCPU / 8 GB VM handles all polling, ingest, and serving for one analyst.
2. **Open three accounts on day one** and treat them as the foundation: Cesium ion (visual stack), Copernicus Data Space Ecosystem (imagery + SAR), and NASA Earthdata Login (LiDAR, hyperspectral, thermal, nightlights). Add OpenSky, AISStream, GFW, FIRMS, OpenTopography, ACLED as you reach each phase.
3. **Hide every key behind your backend** and apply per-route caching with TTLs matched to upstream cadence: 5 s for ADS-B states, 30 s for AIS aggregates, 10 min for FIRMS, 6 h for SAR tilesets, 24 h for terrain tiles.
4. **Prefer fully-open sources first; treat freemium as opt-in features**. If you switch on Google Photorealistic 3D Tiles, gate it behind a single environment flag and put a daily-spend alarm in Google Cloud at $5 so you never get billed by accident.
5. **Implement the correlation engine early** — its existence is the entire reason for choosing a unified platform over running each tool separately. Even a basic rule set ("AIS gap + SAR detect = dark candidate") delivers immediate analytical value, especially given Paolo et al.'s finding that the majority of industrial fishing vessels are unobserved on AIS alone.
6. **Threshold for paying for data**: only consider commercial AIS (Spire) or RF (HawkEye 360) if your AOI proves that GFW's SAR + AIS-gap layer misses >30% of vessels for two consecutive monthly evaluations.

---

## Caveats

- **API surfaces change.** OpenSky removed basic-auth entirely on 18 March 2026 in favor of OAuth2 client-credentials (per the upstream `openskynetwork/opensky-api` README); AISStream describes itself as beta with mutable object models; Google Maps Platform replaced the unified $200 credit with per-SKU free monthly caps effective 1 March 2025 (Essentials 10,000 / Pro 5,000 / Enterprise 1,000 events per SKU per month). Re-validate quotas quarterly.
- **GFW SAR detections lag by ~5 days** ("industrial vessels between 2017 to 5 days ago") — they are not real-time. For near-real-time dark-vessel work you must run your own Sentinel-1 detector on the latest GRD acquisitions (typically <3 h after sensing for IW over Europe via CDSE).
- **GPSJam.org has no documented redistribution API.** Overlay daily PNGs at your own risk; replicating the algorithm from ADS-B feeds you already ingest is legally and operationally cleaner.
- **Google Photorealistic 3D Tiles attribution is mandatory** and the renderer must display the credits string; this is enforced by the tile metadata and is a Map Tiles API ToS condition.
- **Webcam aggregators (especially "Insecam"-style)** scrape unintentionally-public CCTV. Even though indexes are technically public, redistributing or actively searching them carries legal (CFAA-equivalent) and ethical risk; restrict the build to Windy Webcams, official DOT camera APIs, and explicit operator feeds.
- **The Copernicus Data Space Ecosystem free tier is generous but enforced.** Hitting the 10,000 PU/month Sentinel Hub cap on an over-eager Process API loop will silently break Sentinel-2 panels mid-month. Pre-render expected tiles into your own COG/MBTiles where possible.
- **OpenSky's "non-profit/personal" clause** technically excludes for-profit internal evaluation beyond testing; if you are inside a company, contact OpenSky for a license once you move beyond prototyping.
- **Spire / Capella / ICEYE / HawkEye 360 / Kleos / Unseenlabs** are listed in the task brief; verify their current sample-data programs at acquisition time, but plan as if **none has a usable free production tier today**.
- **NISAR maturity**: although NISAR has released >100,000 L1–L3 products through ASF in late February 2026, downstream tools and best-practice workflows are still maturing — expect breaking schema changes in the first 6–12 months and design ingest with versioned STAC item validation.