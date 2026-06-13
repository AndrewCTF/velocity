# Building a Free/Open OSINT Geospatial Monitoring Platform — Deep Technical Expansion (Part II)

## TL;DR

- Treat the platform as a **layer registry of ~60 toggle-able sources**, each described by a uniform metadata schema (auth, endpoint, format, refresh, license) and rendered via CesiumJS 1.x primitives with a MapLibre GL JS v5.24 2D fallback (the "final release for version 5" per the MapLibre April 2026 newsletter); ingest 4D-tagged data through a small set of normalizers (GeoJSON, CZML, vector tiles/PMTiles, COG/STAC, WebSocket).
- The single most important 2025–2026 breaking changes you must integrate now are: **OpenSky's mandatory OAuth2 client-credentials** flow (basic auth deprecated, full cutover "required from March 18, 2026" per the official Python bindings); **Space-Track's 9-digit catalog rollover** (~12 July 2026, GP/GP_History classes replace TLE/TLE_LATEST/TLE_PUBLISH); **CDS legacy decommission of 26 Sep 2024** (`https://cds.climate.copernicus.eu/api`, token-only `.cdsapirc`); **OpenAQ v1/v2 retired 31 Jan 2025** (v3 + `X-API-Key` only); and **ReliefWeb's pre-approved `appname` requirement** from 1 Nov 2025.
- A correlation/fusion engine is what turns the platform from a map into intelligence: implement it as a streaming rules engine over a unified `Observation{source,time,geom,attrs}` schema, with built-in detectors for AIS-gap+SAR-detection, ADS-B NACp-drop clusters≈GPS jamming, RF-emitter near dark vessel, BGP/IODA outage + Cloudflare Radar drop, and seismic+infrasound coincidence.

---

## 1. Architecture overview: layer registry, 4D handling, fusion

### 1.1 The Layer Registry pattern

Define every data source — base map, raster, vector, entity stream, model output — as a `LayerDescriptor` JSON object handed to a central registry at startup:

```ts
// src/registry/types.ts
export interface LayerDescriptor {
  id: string;                           // 'maritime.ais.aisstream'
  group: 'maritime'|'aviation'|'space'|'rf'|'env'|'cyber'|'seismic'|'infra'|'news'|'imagery'|'reference';
  title: string;                        // 'AIS — AISStream live'
  kind: 'tile-raster'|'tile-vector'|'wms'|'wmts'|'geojson'|'czml'|'websocket'|'stac'|'cog'|'3dtiles';
  auth: 'none'|'apikey'|'bearer'|'oauth2-cc'|'netrc'|'earthdata';
  endpoint: string;                     // base URL or template
  refresh: { mode:'pull'|'push'|'static'; ttlSec?: number };
  time: { temporal: boolean; from?: string; to?: string; step?: string };
  crs: 'EPSG:4326'|'EPSG:3857'|'CRS:84'|'ECI'|'ECEF';
  license: string;                      // 'CC0'|'CC-BY-4.0'|...
  opacity: number; visibleByDefault: boolean;
  emits?: ('vessel'|'aircraft'|'emitter'|'event'|'outage'|'detection')[];
}
```

The registry exposes `register(d)`, `enable(id)`, `disable(id)`, `setOpacity(id,a)`, `setTimeWindow(id,from,to)`, and emits an event bus consumed by both Cesium (`Viewer.dataSources` / `Viewer.scene.primitives`) and MapLibre (`map.addSource`/`addLayer`). Group + tag + free-text search over `LayerDescriptor` produces the side-panel UI.

### 1.2 4D handling

Use **CZML** for any entity stream that has a real trajectory (vessels, aircraft, satellites): CZML's `interpolationAlgorithm:"LAGRANGE"` + epoch-relative time arrays let Cesium animate thousands of objects against `viewer.clock` without per-tick JS. For non-trajectory time series (TROPOMI NO2, GIBS daily mosaics, weather radar) drive an `ImageryLayer` set whose `show` flips on the clock's `onTick`.

### 1.3 Fusion / correlation engine

Normalize every emitting layer into:
```ts
type Observation = { id:string; source:string; t:number;
  geom:{type:'Point'|'LineString'|'Polygon', coordinates:any};
  attrs: Record<string,any>; emitsKind:'vessel'|'aircraft'|'emitter'|...; };
```
Push these into a sliding-window store (DuckDB-WASM in-browser is sufficient up to ~1M observations; otherwise PostgreSQL+PostGIS server side). Rules then run as periodic SQL or streaming joins. Concrete starter rules:

| Rule name | Inputs | Trigger |
|---|---|---|
| `ais_gap_sar` | AIS tracks + Sentinel-1 GFW SAR dark detections | dark vessel within 5 km / 30 min of any vessel that switched off AIS for ≥1 h |
| `gps_jam_cluster` | ADS-B NACp/NIC drop bucket + GPSJam tiles | ≥3 aircraft with NACp<8 in a 100×100 km / 1 h cell |
| `rf_emitter_overlap` | KiwiSDR/PSKReporter spots + AIS dark + AIS gap | high-power emitter localization within 25 km of AIS-gap vessel |
| `cyber_outage_geo` | IODA events + Cloudflare Radar traffic anomalies + RIPE Atlas probe disconnects | concurrent country/AS outage in ≥2 of 3 sources |
| `quake_infrasound` | USGS/EMSC FDSN + GDACS + Raspberry Shake | M≥4.5 within 60 s of community-station detection in same region |

---

## 2. Mandate A — Deeper API technical detail (existing + new)

### 2.1 OpenSky Network — OAuth2 client-credentials (BREAKING)

- **Token endpoint:** `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`
- **Grant:** `client_credentials`; create client in Account → API clients (the client ID ends in `-api-client`).
- **TTL:** access tokens are valid 30 minutes (typical Keycloak default; the Laravel binding's documented practice caches for 25 min — refresh at ≤5 min remaining).
- **REST base:** `https://opensky-network.org/api`. Header: `Authorization: Bearer <token>`.
- **Cutover:** "Basic authentication is no longer accepted" for accounts created since mid-March 2025; the official Python bindings README states OAuth2 will be "required from March 18, 2026".
- **Endpoints (selected):**
  - `GET /states/all?lamin&lomin&lamax&lomax&icao24&time&extended=1` — current state vectors; bounding box in WGS84 decimal degrees; `time` Unix seconds; anonymous time resolution 10 s, OpenSky users 5 s, max `t<now-3600` for non-anonymous (the docs note "If the time parameter has a value t<now-3600 the API will return 400 Bad Request" for OpenSky users).
  - `GET /flights/all?begin=&end=` — max 2-hour window; arrivals/departures by airport via `/flights/arrival` / `/flights/departure` (same-UTC-day constraint).
  - `GET /tracks/all?icao24=&time=` — experimental trajectory.
- **Rate-limit behavior:** HTTP `429 Too Many Requests`; Go binding surfaces `RateLimitError{RetryAfterSeconds, Remaining}`. Anonymous users have far stricter limits than authenticated.
- **Python binding:** v1.4.0 — `OpenSkyApi(token_manager=TokenManager.from_json_file("credentials.json"))`. Library docs explicitly recommend the context-manager pattern.

### 2.2 Space-Track.org — 9-digit catalog migration

- **Base URL:** `https://www.space-track.org/`. Auth: cookie-session POST to `https://www.space-track.org/ajaxauth/login` with `identity` + `password`.
- **Rate caps (verbatim):** "Limit API queries to less than 30 requests per 1 minute(s) and 300 requests per 1 hour(s)" and avoid one-record-per-satellite scripts.
- **Classes today:** `tle`, `tle_latest`, `tle_publish`, `omm`, `boxscore`, `satcat`, `launch_site`, `decay`, `tip`, `cdm`, `announcement`. These will be deprecated.
- **2026 migration:** "We will run out of 5-digit catalog numbers at 69999 not 99999, … around 2026-07-12." Use the new **GP** / **GP_History** classes returning OMM XML/KVN/JSON/CSV (138 M historical elsets). TLE/3LE only supports catalog numbers ≤99,999; for >99,999 you must use OMM-formatted requests.
- **Query syntax example:** `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/format/json`
- **Client lib:** `spacetrack` Python (v1.4.0 — request classes mapped to controllers; predicates discoverable via `client.get_predicates('gp')`).
- **Upstream cadence:** CelesTrak's official GP-formats documentation notes "the 18 SDS GP data only updates 2-3 times a day"; do not poll faster than that.

### 2.3 CelesTrak GP / SupGP

- **Base URL:** `https://celestrak.org/NORAD/elements/`.
- **GP query:** `gp.php?CATNR=25544&FORMAT=JSON-PRETTY` — supports `CATNR` (1–9 digits), `INTDES` (yyyy-nnn launch), `NAME` (substring), `GROUP` (e.g., `starlink`, `active`, `geo`).
- **SupGP query:** `supplemental/sup-gp.php?CATNR=...&FORMAT=...` — Telesat, OneWeb, Planet, Intelsat, ILRS CPF predictions, ISS 6-hour ephemerides.
- **Auth: NONE**. **Refresh cap:** "CelesTrak only checks for new GP data once every 2 hours, so there is no need for you to check more often." Excess polling returns a **HTTP 403 with a human-readable explanation** and a temporary IP block.
- **Formats:** TLE, 3LE, 2LE, XML, KVN, JSON, JSON-PRETTY, CSV.

### 2.4 SatNOGS Network + DB

- **Network REST:** `https://network.satnogs.org/api/` — `/observations/`, `/stations/`, `/jobs/`, `/transmitters/`. OpenAPI auto-doc available. Read = anonymous; write requires authenticated user.
- **DB REST:** `https://db.satnogs.org/api/` — `/satellites/`, `/transmitters/`, `/telemetry/`, `/tle/`, `/optical-observations/`, `/modes/`, `/artifacts/`. Read open; write needs API key (account → API key). All data **CC BY-SA**.
- **Client:** `satnogs-db-api-client` (PyPI); legacy in Libre Space community.

### 2.5 Launch Library 2 (TheSpaceDevs)

- **Prod:** `https://ll.thespacedevs.com/2.3.0/` (also 2.2.0). **Dev/staging:** `https://lldev.thespacedevs.com/2.3.0/` — same schema, stale data, **no rate limit** (use for development only).
- **Rate limit:** "up to 15 API calls per hour (per IP)" without a key; higher with paid key. Caching strongly recommended.
- **Pagination:** `?limit=&offset=`; response envelope `{count, next, previous, results}`.
- **Endpoints (selected):** `launches/upcoming/`, `launches/previous/`, `agencies/`, `astronauts/`, `pads/`, `locations/`, `events/upcoming/`, `dashboard/starship/`, `config/launcher/`. The `api-throttle` endpoint reports your current bucket and **does not count against your quota**.

### 2.6 AIS / Maritime additions (deeper)

- **AISStream.io:** WSS `wss://stream.aisstream.io/v0/stream`. Subscribe with first frame `{ "APIKey":"...", "BoundingBoxes":[[[lat1,lon1],[lat2,lon2]]], "FiltersShipMMSI":[], "FilterMessageTypes":["PositionReport","ShipStaticData"] }`. Free key. Reconnect with exponential backoff; AISStream beta rules limit re-subscribe rate.
- **GFW Vessels API v3:** `https://gateway.api.globalfishingwatch.org/v3/` — Bearer token (long-lived; request via developer portal). Resources: `/vessels/search`, `/4wings/report` (fishing-effort grids), `/events`, `/datasets`. Quota by tier.
- **NOAA CO-OPS Tides:** `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?...&format=json`. Auth: none. Parameters: `station`, `product` (`predictions`,`water_level`,`currents`), `datum`, `time_zone`, `units`, `begin_date`/`end_date`/`range`.
- **NDBC buoys:** TXT/CSV/JSON at `https://www.ndbc.noaa.gov/data/realtime2/<station>.txt` and `https://www.ndbc.noaa.gov/activestations.xml`. No auth.
- **Copernicus Marine (CMEMS):** `https://my.cmems-du.eu/motu-web/Motu` (legacy MOTU) and the new STAC API at `https://stac.marine.copernicus.eu/`. Auth: free Copernicus Marine account; password grant for MOTU; `copernicusmarine` Python client v1.x.

### 2.7 ADS-B / Aviation deeper

- **OpenAIP** (airspaces, airports, navaids, obstacles, hotspots) — base URLs:
  - Core: `https://api.core.openaip.net/api/`
  - IAM: `https://api.iam.openaip.net/api/`
  - Tiles: `https://api.tiles.openaip.net/api/`
- Auth header `x-openaip-api-key: <KEY>` or `?apiKey=<KEY>` (per OpenAIP's 2024 blog announcement: "only an API access key is used. No more Firebase token!"). Endpoints `/airports`, `/airspaces`, `/navaids`, `/reporting-points`, `/obstacles`, `/hotspots`. Tile pattern `data/{layer}/{z}/{x}/{y}.png`. License **CC BY-NC 4.0**.
- **SondeHub (radiosondes / HAB):** REST `https://api.v2.sondehub.org/` (no auth, public). Endpoints: `PUT /sondes/telemetry`, `PUT /amateur/telemetry`, `PUT /listeners`, `GET /sondes` (rate-limited — "Do not regularly poll this endpoint"), `GET /listeners`, `GET /predictions`, `GET /predictions/reverse`, `GET /tawhiri?...`. Streaming MQTT-over-WSS at `wss://ws.v2.sondehub.org:443`; Python SDK `pysondehub` wraps Paho MQTT. **Non-commercial only.**
- **FAA NOTAM API:** OAuth2 via FAA API Portal (`https://api.faa.gov/notamapi/v1`). Endpoints `/notams` with locationLatitude/locationLongitude/locationRadius/effectiveStartDate.
- **Airframes.io:** ACARS/HFDL/VDL collection; HTTP feed at `https://api.airframes.io/`.

**Field findings (2026-06) — global aircraft feed reality:**
- **OpenSky `/states/all` is the only working planet-wide single-shot source** (~13 k aircraft / ~1.7 MB in one ~1.8 s request) and it serves anonymous requests, so the map shows the full sky with zero config. Authed (OAuth2) and anonymous have **separate** credit budgets — when the authed pool is spent (`429`), retry anonymously (separate per-IP ~400 credits/day, 4 credits per global call). A global `/states/all` costs 4 credits; with a bounding box ≤25/100/400 sq° it costs 1/2/3. Anonymous time resolution 10 s, authed 5 s. Pace pulls ≥ the resolution (we use 15 s) and cache between pulls so the count survives budget exhaustion.
- **The free aggregator "firehoses" do NOT exist / are blocked.** From typical egress IPs: airplanes.live has no global verb (`/v2/all`, `/v2/all-with-pos` → 404 — only `/v2/point`, `/v2/mil`, `/v2/squawk`, `/v2/hex`, `/v2/callsign`, `/v2/reg`, `/v2/type`); adsb.lol `/v2/all-with-pos` → 451 (legal block) and publishes an AAAA record that breaks an IPv4-pinned client; adsb.fi `/v2/snapshot` → 403. Treat these as opportunistic-only.
- **airplanes.live `/v2/point` is the dense-region workhorse** (≤250 nm radius, ADSBExchange-compatible payload). Critical gotcha: its rate limiter returns **HTTP 200 with a `text/plain` "You have been rate limited" body** as often as a real `429`. A naive `r.json()` raises `ValueError`, and swallowing that as an empty cell silently blanks the map. Measured tolerance: ≤8 concurrent `/v2/point` OK, ~15 concurrent trips the limiter; ~1.4 req/s sequential sustained fine. Keep the upstream burst semaphore ≤8 and a per-cell 30 s cache so steady-state load stays ~4-5 cells/s.
- **Architecture:** union OpenSky (breadth, throttled+cached) ∪ airplanes.live `/v2/point` grid (freshness, time-boxed) ∪ short-window carry-forward, deduped by ICAO24, freshest wins → ~13 k aircraft at ~1-2 s snapshot age. Implementation: `apps/api/app/routes/adsb.py`. See `docs/adsb-aircraft-pipeline.md`.

### 2.8 RF / SIGINT-adjacent

- **KiwiSDR public network:** machine-readable list at `http://kiwisdr.com/public/` and JSON at `http://kiwisdr.com/public?type=json`. Each entry includes `url`, `name`, `gps`, `users`, `users_max`, `bands`, `antenna`. No auth; respect station owner's bandwidth.
- **WebSDR network:** index at `http://websdr.org/` (manual list).
- **PSKReporter:**
  - Query: `https://retrieve.pskreporter.info/query?senderCallsign=N1DQ&flowStartSeconds=-1800&format=xml` (last 30 min of spots heard from N1DQ). Last 100 records or 6 hours max. Returns XML by default. Optional `appcontact=email` for notification.
  - Identify by User-Agent and avoid synchronized timer polls. Reports submission is IPFIX UDP to `report.pskreporter.info:4739`.
- **WSPRnet:** bulk CSV at `https://wsprnet.org/drupal/downloads`; MySQL spots DB; no formal API key.
- **APRS.fi:** `https://api.aprs.fi/api/get?name=CALL1,CALL2&what=loc|wx|msg&apikey=KEY&format=json` — comma-separated callsigns; metric units; timestamps Unix. API key in account settings. Rate-limited; constant keys for mass-market apps need contact. User-Agent header mandatory with app name + URL.

### 2.9 Internet / Cyber geospatial

- **Cloudflare Radar:** `https://api.cloudflare.com/client/v4/radar/`. Auth: Cloudflare API token with `Account → Radar: Read`. License **CC BY-NC 4.0** — Radar's API is free.
  - HTTP: `/radar/http/summary/device_type?dateRange=7d&format=json` etc.; bot vs human via `botClass=LIKELY_HUMAN|LIKELY_AUTOMATED`.
  - Attacks: `/radar/attacks/layer3/*`, `/radar/attacks/layer7/*`.
  - Outages: `/radar/annotations/outages?dateRange=7d`.
- **IODA (Georgia Tech / CAIDA):** `https://api.ioda.caida.org/v2/` (also legacy `ioda.caida.org/ioda/data/events`). Endpoints `entities/{type}/{code}`, `outages/events/{type}/{code}`, `outages/alerts/...`, `signals/{type}/{code}`, `datasources/{ds}`. Time in Unix seconds via `from`/`until`. Pagination `{page,size,totalPages}`. **No auth.**
- **RIPE Atlas:** `https://atlas.ripe.net/api/v2/` — `measurements/`, `probes/`, `anchors/`, `keys/`, `credits/`. Auth: API key in `Authorization: Key <UUID>`. The official Credits documentation states verbatim: "A host (and sponsor, see below) receives 15 credits for each minute that their probe is connected to our network, so assuming that your probe is connected continuously, you should earn roughly 21,600 credits every 24 hours." Measurements are priced per result (e.g., a single traceroute result costs a small number of credits). Rate cap: "Up to 50 measurement results per second per measurement" and "Up to 25 periodic and 25 one-off measurements of the same type running against the same target at any time."
- **RIPEstat:** `https://stat.ripe.net/data/<widget>/data.json?resource=...` — 100+ widgets (e.g., `routing-history`, `country-asns`, `whois`, `dns-chain`). No auth, generous limits.
- **RIPE RIS / RouteViews:** historical BGP via BGPStream library; RIS Live WebSocket `wss://ris-live.ripe.net/v1/ws/?client=<name>` for real-time BGP updates.
- **Shodan/Censys:** Shodan REST `https://api.shodan.io/`, key in `?key=`; query credits limit; free membership 1 query credit + 1 scan credit per month. Censys Search v2 `https://search.censys.io/api/v2/hosts/search`, auth Basic with API ID + secret; free community plan has hard rate limits.

### 2.10 Seismic / geophysical / hazard

- **USGS FDSN Event:** `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=...&endtime=...&minmagnitude=...&maxlatitude=...` etc. Realtime GeoJSON feeds at `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson` (and `_day`, `_week`, `_month` at magnitudes `all`, `1.0`, `2.5`, `4.5`, `significant`). Also FDSN `count` and `version` methods.
- **EMSC SeismicPortal:**
  - FDSN: `http://www.seismicportal.eu/fdsnws/event/1/query?format=json|text&starttime=...`
  - Realtime WS: `ws://www.seismicportal.eu/standing_order/websocket` — push of new/updated events as JSON `{action: 'create|update', data: {...QuakeML-like...}}`.
  - Moment tensors: `https://www.seismicportal.eu/mtws/api/search?...`. Felt reports: `testimonies-ws/api/search`. ID conversion: `eventid/api/convert?source_id=&source_catalog=&out_catalog=all`.
- **IRIS/EarthScope FDSN:** station/dataselect web services at `https://service.iris.edu/fdsnws/`; auth via `.netrc` for restricted networks.
- **Raspberry Shake:** FDSN at `https://data.raspberryshake.org/fdsnws/event/1/`, station map JSON via the community portal; auth optional.
- **GDACS:** RSS at `https://www.gdacs.org/xml/rss.xml` and `rss_7d.xml`; JSON at `gdacsapi/api/events/geteventlist/EVENTS`. No auth.
- **Smithsonian Global Volcanism Program:** REST + KMZ at `https://volcano.si.edu/database/`; bulk CSV via download page.
- **NOAA PTWC tsunami:** `https://tsunami.gov/events/` ATOM feeds.
- **USGS Water:** `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=...&parameterCd=...`.

### 2.11 Atmosphere / air quality

- **OpenAQ v3:** `https://api.openaq.org/v3/`. Auth header `X-API-Key: <KEY>`. **v1/v2 returned HTTP 410 Gone after 31 January 2025**. Endpoints `/locations`, `/locations/{id}`, `/locations/{id}/latest`, `/locations/{id}/sensors`, `/sensors/{id}/measurements/hourly`, `/sensors/{id}/measurements/daily`, `/parameters`, `/countries`, `/instruments`, `/manufacturers`, `/licenses`. Pagination: `?page=&limit=` with envelope `{meta,results}`. Sign-up at `explore.openaq.org/register`. Python SDK `openaq` reads `OPENAQ_API_KEY` env var.
- **PurpleAir:** `https://api.purpleair.com/v1/` — `READ-API-Key` and `WRITE-API-Key` headers; key requested via email at contact@purpleair.com. Endpoints `sensors`, `sensors/{id}`, `sensors/{id}/history`. Free for non-commercial.
- **Open-Meteo:** `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&daily=&models=&forecast_days=` (default 7, up to 16). Archive at `archive-api.open-meteo.com/v1/archive`; geocoding at `geocoding-api.open-meteo.com/v1/search`. **Free tier (verbatim Terms):** "Less than 10'000 API calls per day, 5'000 per hour and 600 per minute. You may only use the free API services for non-commercial purposes." No key, no signup, CC BY 4.0.
- **NOAA SWPC:** JSON products at `https://services.swpc.noaa.gov/json/` and `/text/`. Examples: `planetary_k_index_1m.json`, `solar_wind/mag-1-day.json`, `solar_wind/plasma-1-day.json`, `aurora/aurora-3day.json`, `noaa_scales.json`, `goes/primary/xrays-1-day.json`. WMS tiles at `https://services.swpc.noaa.gov/`.
- **TROPOMI / Sentinel-5P** — via Copernicus Data Space STAC `https://catalogue.dataspace.copernicus.eu/odata/v1/Products` or Sentinel Hub Process API. Bearer OAuth2 with `code` or `client_credentials` grant against `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token`.
- **NASA EONET:** `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=wildfires&limit=20`. No auth. Categories: wildfires, volcanoes, storms, floods, drought, dustHaze, manmade, seaLakeIce, severeStorms, snow, temperatureExtremes, waterColor.
- **Blitzortung / WWLLN:** Blitzortung public WS (manual key), WWLLN via research access.
- **Weather radar:** NEXRAD via Iowa State Mesonet WMS `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0r.cgi?...`; also TMS template at `https://mesonet-a.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`.

### 2.12 Submarine cables + critical infrastructure

- **Submarine Cable Map (TeleGeography):** community-discovered API endpoints (no formal docs):
  - `https://www.submarinecablemap.com/api/v3/cable/cable-geo.json`
  - `https://www.submarinecablemap.com/api/v3/landing-point/landing-point-geo.json`
  - `https://www.submarinecablemap.com/api/v3/cable/all.json`  
  Public GitHub repo dropped; community mirror exists. License **CC BY-NC-SA 3.0** as per historical README.
- **PeeringDB:** `https://www.peeringdb.com/api/<obj>` — objects `org`, `fac`, `ix`, `net`, `poc`, `ixlan`, `ixpfx`, `netixlan`, `netfac`. Auth via `Authorization: Api-Key <key>` (user or org key). OAuth2 at `https://auth.peeringdb.com/oauth2/{authorize,token}/`. Strongly recommend canonical hostname `www.peeringdb.com` (clients drop auth headers on redirect). Throttling: unauthenticated users have lower per-IP limits and stricter "identical query repetition" throttles.
- **OpenInfraMap / OSM Overpass:** raw OSM tags `power=line|tower|substation|generator`, `pipeline=*`, `man_made=pipeline|telescope|antenna`. Overpass endpoint `https://overpass-api.de/api/interpreter` POST `data=[out:json][timeout:60];nwr["power"="line"](bbox);out geom;`.
- **Infrapedia:** GraphQL endpoint at `https://api.infrapedia.com/api/v2/graphql` (account-restricted).

### 2.13 Imagery / ground truth

- **Mapillary v4:**
  - Metadata root: `https://graph.mapillary.com`
  - Tiles root: `https://tiles.mapillary.com`
  - Vector tile coverage: `tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}`
  - Computed coverage: `mly1_computed_public/2/{z}/{x}/{y}`
  - Map features (points / traffic signs): `mly_map_feature_point/2/{z}/{x}/{y}` and `mly_map_feature_traffic_sign/2/{z}/{x}/{y}`
  - Auth: register app, get `client_id` + `client_secret`. Vector tiles accept token in `?access_token=MLY|...` query param; entity endpoints prefer `Authorization: OAuth MLY|...` header. OAuth2 authorization-code via `graph.mapillary.com/connect` + `graph.mapillary.com/token` (grants: `authorization_code`, `refresh_token`). Scopes: `read`, `write`, `upload`.
- **KartaView:** `https://api.openstreetcam.org/2.0/` — public OAuth2.
- **Wikimedia/Wikidata geosearch:** `https://www.wikidata.org/w/api.php?action=query&list=geosearch&gscoord=...&gsradius=10000&format=json`.

### 2.14 News / event / social

- **GDELT 2.0 DOC API:** `https://api.gdeltproject.org/api/v2/doc/doc?query=<...>&mode=artlist&format=json&timespan=24h&maxrecords=250`. Modes: `artlist`, `artgallery`, `imagecollage*`, `timelinevol*`, `tonechart`, `timelinetone`, `wordcloud*`. Operators inside query: `sourcecountry:US`, `sourcelang:English`, `domainis:nytimes.com`, `theme:GKG_THEME`, `near5:"wall border"`. No auth, no key. 3-month rolling window.
- **GDELT GEO 2.0:** `/api/v2/geo/geo?query=...&mode=PointData|HeatMap|MapList&format=GeoJSON`.
- **GDELT Context 2.0:** sentence-level; 72-hour rolling.
- **ReliefWeb v2:** `https://api.reliefweb.int/v2/` — endpoints `/reports`, `/disasters`, `/countries`, `/jobs`, `/training`, `/sources`, `/blog`, `/book`, `/references`. **Pre-approved `appname` parameter is required from 1 November 2025**. Max `limit=1000`. OpenAPI 3.1 spec at `/v2/swagger/api`. POST + JSON body supported for complex queries (with `facets[]`).
- **ACLED:** REST at `https://api.acleddata.com/acled/read?key=&email=&country=...&year=...`. Free for academic/non-profit with registration.

### 2.15 Population / reference / human geography

- **WorldPop:** REST `https://www.worldpop.org/rest/data/pop/wpgp` returns dataset metadata; rasters downloaded by URL.
- **HDX:** CKAN API `https://data.humdata.org/api/3/action/package_search?q=...&fq=&rows=`.
- **GeoNames:** `http://api.geonames.org/searchJSON?q=&maxRows=&username=demo` (sign-up free; 30k credits/day for free accounts). Most endpoints free but `username` required.
- **Nominatim:** `https://nominatim.openstreetmap.org/search?q=&format=jsonv2&addressdetails=1&limit=5`. Strict policy: **1 req/sec, mandatory User-Agent**, no bulk.
- **Microsoft Building Footprints / Google Open Buildings / Overture Maps:** Overture parquet at `https://overturemaps.org/` (S3 `s3://overturemaps-us-west-2/release/<date>/theme=*/`). License **CDLA 2.0** + ODbL where derived from OSM.

### 2.16 Weather / climate reanalysis

- **Copernicus CDS API (new, post-2024 migration):**
  - **Base:** `https://cds.climate.copernicus.eu/api`
  - **`~/.cdsapirc`:**  
    ```
    url: https://cds.climate.copernicus.eu/api
    key: <PERSONAL-ACCESS-TOKEN>
    ```
    Token from `https://cds.climate.copernicus.eu/profile`. There is **no UID field anymore**; the ECMWF Confluence guidance states verbatim: "new .cdsapirc file should only contain a URL and a key field - there is NO UID field anymore."
  - **Decommissioned:** the legacy `cds.climate.copernicus.eu/api/v2` was retired on 26 September 2024. The ECMWF Forum announcement (https://forum.ecmwf.int/t/goodbye-legacy-climate-data-store-hello-new-climate-data-store-cds/6380) states verbatim: "Today 26th September 2024, CDS-Beta has officially become the new CDS: https://cds.climate.copernicus.eu/ The legacy system is now decommissioned and no longer accessible." All users must re-register, re-accept dataset licences, and `pip install --upgrade cdsapi`. Companion: `https://ads.atmosphere.copernicus.eu/api` (ADS, atmospheric), `https://ewds.climate.copernicus.eu/api` (EWDS, early warning). The CDS Toolbox was also discontinued on 26 Sep 2024.
  - **Typical call:** `cdsapi.Client().retrieve('reanalysis-era5-single-levels', {...}, 'out.nc')`. Response: GRIB or NetCDF.
- **NOAA NOMADS:** OPeNDAP/HTTP at `https://nomads.ncep.noaa.gov/dods/` and `https://nomads.ncep.noaa.gov/pub/data/nccf/com/` (GFS, HRRR, GEFS, etc.).
- **NASA GIBS WMTS:** `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi` — daily MODIS, VIIRS, Black Marble.

### 2.17 Radiation / CBRN-adjacent (open environmental only)

- **Safecast:** `https://api.safecast.org/measurements.json?since=YYYY-MM-DD&until=YYYY-MM-DD&distance=&latitude=&longitude=&captured_after=`. Auth: `?api_key=...` for POSTs; GET is anonymous. License **CC0**. Bulk dump in `s3://safecast-opendata-public-us-east-1/`. POST example: `POST /measurements.json` with `{location_name, longitude, latitude, value, unit}`.
- **EURDEP (EC Joint Research Centre):** restricted to authorities; public summaries via the EURDEP public viewer.
- **CTBTO IDC:** access-restricted to State Signatories; not OSINT.

### 2.18 Wildfires / land

- **NIFC / IRWIN:** ArcGIS REST at `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/` — perimeters, IRWIN incidents.
- **FIRMS:** modern endpoint at `https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/<source>/<area>/<day_range>/<date>` (e.g., `VIIRS_SNPP_NRT/world/1/2026-05-23`). Auth: free MAP_KEY (rate-limit 5,000 calls per 10-minute window per key). The NASA Earthdata FIRMS FAQ states verbatim: "FIRMS makes the NRT data available within 3 hours of a satellite observation (on a best effort basis)"; real-time (RT) data are available within 30 minutes and ultra-real-time (URT) within 5 minutes of overpass — choose the tier that matches your latency budget.

---

## 3. Mandate B (cont.) — New layers consolidated master table

| # | Domain | Source | Auth | Endpoint base | Free/Freemium | License |
|---|---|---|---|---|---|---|
| 1 | Space catalog | Space-Track GP/GP_History | username+pwd cookie | `space-track.org/basicspacedata/query/...` | FREE (acct req) | US Gov |
| 2 | Space catalog | CelesTrak GP / SupGP | none | `celestrak.org/NORAD/elements/gp.php` | FREE | "Open" |
| 3 | Ground stations | SatNOGS Network/DB | none (read) | `network.satnogs.org/api/`, `db.satnogs.org/api/` | FREE | CC BY-SA |
| 4 | Launches | LL2 (TheSpaceDevs) | optional key | `ll.thespacedevs.com/2.3.0/` | Freemium (15/hr free) | Open |
| 5 | Aviation | OpenSky | OAuth2 CC | `opensky-network.org/api` | FREE (non-comm) | OpenSky ToS |
| 6 | Airspace | OpenAIP | API key header | `api.core.openaip.net/api/` | FREE w/ acct | CC BY-NC 4.0 |
| 7 | Radiosondes | SondeHub | none | `api.v2.sondehub.org` + MQTT WSS | FREE non-comm | SondeHub |
| 8 | RF | KiwiSDR network | none | `kiwisdr.com/public?type=json` | FREE | per-station |
| 9 | RF | PSKReporter | optional contact | `retrieve.pskreporter.info/query` | FREE | PSKReporter |
| 10 | RF | APRS.fi | API key | `api.aprs.fi/api/get` | FREE w/ acct | aprs.fi ToS |
| 11 | Cables | Submarine Cable Map | none (community) | `submarinecablemap.com/api/v3/` | FREE | CC BY-NC-SA 3.0 |
| 12 | Interconnect | PeeringDB | API key/OAuth | `peeringdb.com/api/` | FREE | CC BY-SA |
| 13 | Cyber | Cloudflare Radar | API token | `api.cloudflare.com/client/v4/radar/` | FREE | CC BY-NC 4.0 |
| 14 | Cyber | IODA | none | `api.ioda.caida.org/v2/` | FREE | IODA |
| 15 | Cyber | RIPE Atlas | API key | `atlas.ripe.net/api/v2/` | Credit-based | RIPE |
| 16 | Cyber | RIPEstat | none | `stat.ripe.net/data/` | FREE | RIPE |
| 17 | Seismic | USGS FDSN | none | `earthquake.usgs.gov/fdsnws/event/1/` | FREE | Public domain |
| 18 | Seismic | EMSC SeismicPortal | none | `seismicportal.eu/fdsnws/event/1/`, WS | FREE | EMSC |
| 19 | Seismic | Raspberry Shake | none | `data.raspberryshake.org/fdsnws/` | FREE | CC BY |
| 20 | Disasters | GDACS | none | `gdacs.org/xml/rss.xml`, JSON API | FREE | UN/EC |
| 21 | Radiation | Safecast | none read | `api.safecast.org/measurements.json` | FREE | CC0 |
| 22 | Air quality | OpenAQ v3 | API key | `api.openaq.org/v3/` | FREE w/ acct | per-source |
| 23 | Air quality | PurpleAir | API key | `api.purpleair.com/v1/` | FREE non-comm | PurpleAir |
| 24 | Weather | Open-Meteo | none | `api.open-meteo.com/v1/forecast` | FREE non-comm 10k/day | CC BY 4.0 |
| 25 | Space wx | NOAA SWPC | none | `services.swpc.noaa.gov/json/` | FREE | Public |
| 26 | Events | NASA EONET | none | `eonet.gsfc.nasa.gov/api/v3/events` | FREE | Public |
| 27 | Imagery | Mapillary v4 | OAuth2 + token | `graph.mapillary.com`, `tiles.mapillary.com` | FREE | CC BY-SA |
| 28 | News | GDELT DOC 2.0 | none | `api.gdeltproject.org/api/v2/doc/doc` | FREE | GDELT |
| 29 | News | ReliefWeb v2 | `appname` (pre-approved) | `api.reliefweb.int/v2/` | FREE | per-source |
| 30 | Conflict | ACLED | key+email | `api.acleddata.com/acled/read` | FREE (academic) | ACLED |
| 31 | Geocoding | GeoNames | username | `api.geonames.org/searchJSON` | FREE w/ acct | CC BY |
| 32 | Geocoding | Nominatim | none (UA req) | `nominatim.openstreetmap.org/search` | FREE rate-limited | ODbL |
| 33 | Buildings | Overture Maps | none | `s3://overturemaps-us-west-2/release/` | FREE | CDLA 2.0 / ODbL |
| 34 | Climate | Copernicus CDS | personal token | `cds.climate.copernicus.eu/api` | FREE | Copernicus ToU |
| 35 | Marine | Copernicus CMEMS | account | `stac.marine.copernicus.eu/` | FREE | Copernicus |
| 36 | Tides | NOAA CO-OPS | none | `api.tidesandcurrents.noaa.gov/api/prod/datagetter` | FREE | Public |
| 37 | Buoys | NDBC | none | `ndbc.noaa.gov/data/realtime2/` | FREE | Public |
| 38 | Routing/BGP | RIS Live WS | none | `wss://ris-live.ripe.net/v1/ws/?client=` | FREE | RIPE |
| 39 | Cyber search | Shodan | API key | `api.shodan.io/` | Freemium (paid for vol) | Shodan |
| 40 | Cyber search | Censys | API key | `search.censys.io/api/v2/` | Freemium | Censys |
| 41 | Wildfires | NIFC IRWIN | none | `services3.arcgis.com/.../arcgis/rest/services/` | FREE | Public |
| 42 | Fires | FIRMS | MAP_KEY | `firms.modaps.eosdis.nasa.gov/api/area/csv/` | FREE w/ key | NASA |

---

## 4. Mandate C — Platform feature engineering

### 4.1 CesiumJS performance for many entities (using current API)

CesiumJS performance idioms that matter for an OSINT globe:

- **`Cesium3DTileset.fromUrl()`** for any large set of static features (3D buildings, large vector overlays exported to 3D Tiles). Tune `maximumScreenSpaceError=16` for performance, lower to 4 for detail; set `dynamicScreenSpaceError=true`, `skipLevelOfDetail=true`, and `cullWithChildrenBounds=true` for big city tilesets.
- **`scene.requestRenderMode = true`** + `scene.maximumRenderTimeChange = Infinity` to render only on data/clock changes. Cesium's own benchmark of this optimization (Gabby Getz, "Improving Performance with Explicit Rendering," cesium.com, 24 Jan 2018) reports verbatim: "CPU usage in an idle Cesium scene averaged 25.1%, but after enabling the performance improvement, it now averages 3.0%. This was measured on a laptop with an Intel i7 processor, running in Google Chrome" — i.e., an ~88% reduction in idle CPU load.
- For thousands of moving points (vessels, aircraft, satellites): prefer the **PointPrimitiveCollection** / **BillboardCollection** / **LabelCollection** primitives directly on `scene.primitives`, batched into one draw call, instead of `Entity` instances. Update positions per tick via Cesium's `Property` system for entities; for primitives, set `position` in the `preRender` event.
- **EntityCluster** on a `DataSource` for clustered point billboards (`viewer.dataSources.add(ds); ds.clustering.enabled=true; ds.clustering.pixelRange=60;`).
- For trajectories use **`SampledPositionProperty`** with `LagrangeInterpolator` (orders 1–5) and a `ReferenceFrame.INERTIAL` where appropriate (satellites in ECI).

### 4.2 Satellite layer with satellite.js (current API)

```ts
import { twoline2satrec, propagate, gstime, eciToGeodetic,
         degreesLat, degreesLong } from 'satellite.js';

function satToCartographic(tle1: string, tle2: string, when: Date) {
  const rec = twoline2satrec(tle1, tle2);
  const r   = propagate(rec, when);           // returns {position, velocity}
  if (!r) return null;
  const gmst = gstime(when);
  const g    = eciToGeodetic(r.position, gmst);
  return { lat: degreesLat(g.latitude),
           lon: degreesLong(g.longitude),
           altKm: g.height };
}
```
Run propagation in a Web Worker (one worker per ~5,000 sats) and post `Float32Array`s to the main thread; in Cesium feed them to a `PointPrimitiveCollection` with `position = Cesium.Cartesian3.fromDegrees(lon,lat,h*1000)`.

### 4.3 MapLibre v5 (current ~v5.24) clustering for many points

```js
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/globe.json',
  center: [0,0], zoom: 2
});
map.on('load', () => {
  map.addSource('aircraft', {
    type: 'geojson', data: '/tiles/aircraft.geojson',
    cluster: true, clusterMaxZoom: 14, clusterRadius: 50
  });
  map.addLayer({ id:'ac-clusters', type:'circle', source:'aircraft',
    filter:['has','point_count'],
    paint:{ 'circle-color':['step',['get','point_count'],'#51bbd6',100,'#f1f075',750,'#f28cb1'],
            'circle-radius':['step',['get','point_count'],20,100,30,750,40] }});
  map.addLayer({ id:'ac-unclustered', type:'circle', source:'aircraft',
    filter:['!',['has','point_count']],
    paint:{ 'circle-color':'#11b4da','circle-radius':4 }});
});
```
**Future-proof for v6:** MapLibre's official GitHub release notes for v6 pre-releases call out two hard breaks verbatim — "⚠️ WebGL (v1) support has been removed; WebGL2 is now required" and "⚠️ Switch to an ESM-only distribution (maplibre-gl.mjs). The UMD bundles (maplibre-gl.js, maplibre-gl-csp.js) are no longer published." The MapLibre April 2026 Newsletter confirms 5.24.0 as "the final releases for version 5," so your build pipeline must already produce ESM and target WebGL2 only.

### 4.4 Vector / raster tile serving (self-hosted)

- **PMTiles** + `pmtiles://` protocol plugin for MapLibre — single-file vector tile archives served from S3/static; no tile server.
- **pg_tileserv** + **pg_featureserv** for PostGIS-backed vector tiles + Features API.
- **TiTiler** (`uvicorn titiler.application:app`) for COG-on-the-fly: `/cog/preview?url=...&rescale=0,255` and STAC mosaics.
- **MBTiles** for legacy raster; **Cloud-Optimized GeoTIFF (COG)** with `gdal_translate -of COG -co COMPRESS=DEFLATE` and a STAC item for catalog discovery.

### 4.5 STAC integration

Use **`pystac-client`** v0.8+:
```python
from pystac_client import Client
cat = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1")
search = cat.search(collections=["sentinel-2-l2a"], bbox=[lon1,lat1,lon2,lat2],
                    datetime="2026-04-01/2026-05-01", query={"eo:cloud_cover":{"lt":20}})
items = search.item_collection()           # paginates via 'next' links transparently
```
For Copernicus Data Space: catalog at `https://catalogue.dataspace.copernicus.eu/stac` (Bearer OAuth2 same as Sentinel Hub).

### 4.6 Caching, fan-out, offline

- Reverse-proxy each upstream API behind a per-source NGINX + Redis cache with TTL aligned to the source's true update cadence (e.g., 2 h for CelesTrak, 15 min for GDELT, 5 s for AIS).
- Persist all `Observation`s to PostgreSQL (PostGIS+TimescaleDB hypertable on `t`); the fusion engine reads from there, not from upstreams.
- For air-gap: pre-stage tile pyramids (PMTiles), pre-fetch CelesTrak GP for the active satellite set, and run a snapshot of OSM Overpass into a local PostGIS via `osm2pgsql`. Replace WebSocket sources with periodic batch pulls into the same `Observation` table.

### 4.7 Alerting / geofences

Implement AOIs as PostGIS geometries with a `rule_def` JSONB column; a small Python service evaluates new observations against active AOIs each second, raising alerts via a WebSocket bus (`/ws/alerts`) consumed by the browser layer registry. Threshold examples: "≥5 ADS-B aircraft with NACp<7 in 100×100 km in 60 min", "any AIS gap >2 h within 25 km of an AOI", "Cloudflare Radar traffic drop > 60% YoY for country=XX".

---

## 5. Recommendations (decision-ready)

1. **Today (week 1):** Cut over OpenSky to OAuth2; rotate any password-based scripts. Confirm Space-Track scripts use the `gp` class (not `tle_latest`) — change otherwise; you have a hard ~12 July 2026 deadline. Re-issue Copernicus CDS token-only `.cdsapirc`. Drop any OpenAQ v1/v2 calls.
2. **Week 2–3:** Stand up the layer registry skeleton + 10 high-value layers: AIS (AISStream), ADS-B (OpenSky), satellites (CelesTrak GP `active`), launches (LL2), seismic (USGS + EMSC WS), fires (FIRMS), TROPOMI NO2 (CDSE), submarine cables, GDELT GEO, NEXRAD WMS. Use PMTiles for the basemap; CesiumJS 1.x with `requestRenderMode`.
3. **Week 4–6:** Add the cyber/RF tier — Cloudflare Radar, IODA, RIPE Atlas, RIS Live WS, KiwiSDR map, PSKReporter, APRS.fi. Stand up the `Observation` store (PostGIS + TimescaleDB).
4. **Week 7–8:** Wire the fusion engine with the five starter rules in §1.3 and an AOI/geofence alerting bus; instrument with a Grafana dashboard for per-source freshness, error rates, and quota burn.
5. **Benchmarks that should re-trigger architecture review:**
   - **Sustained >50,000 simultaneous entities** → migrate Cesium rendering from `Entity` to primitive collections + workers; consider 3D Tiles for any "frozen" historical layers.
   - **Cloudflare Radar token rate-limit errors** → split API token by use case (Radar-only, read-only) and add a 30 s edge cache.
   - **PostGIS write IOPS > 70%** → partition `observations` by source group; pre-aggregate vessel/aircraft to 10 s buckets.
   - **Fusion rule false-positive rate >10%** → add per-rule confidence (Bayesian update over corroborating sources) before alerting.
6. **Licensing watch-out:** Cloudflare Radar (CC BY-NC), OpenAIP (CC BY-NC), TeleGeography cable map (CC BY-NC-SA), SondeHub (non-commercial) — your platform's distribution model must respect NC. Mapillary v4 imagery is **CC BY-SA**, so derived overlays carry SA obligations.

---

## 6. Caveats

- The TeleGeography Submarine Cable Map JSON endpoints (`/api/v3/cable/*`) are community-discovered and not officially documented; expect breaking changes. Snapshot them locally.
- OpenSky's transition timeline ("required from March 18, 2026" per the Python binding README; "for all new accounts created after March 2025" per the docs site) has been moving — assume basic auth is dead and code only the OAuth2 path.
- Space-Track's exact 9-digit cutover date (≈2026-07-12) is an estimate by Dr. T.S. Kelso; treat it as a hard deadline anyway because `tle_latest` will return blanks for new catalog numbers regardless of the precise day.
- CDS API was migrated 26 Sep 2024; legacy users with old `.cdsapirc` (UID:KEY format) will get 401s on the new endpoint. Some downstream Python packages still reference `/api/v2`.
- ReliefWeb's "pre-approved appname from 1 Nov 2025" implies arbitrary appname strings began being rejected. Plan to email `feedback@reliefweb.int` to register your appname before deploying.
- Cloudflare Radar's API is rich but inherently **Cloudflare-centric** (traffic that passes Cloudflare); do not treat it as ground truth for global Internet behavior — corroborate with IODA + RIPE Atlas.
- "Real-time" claims are uneven: EMSC WS is sub-minute for M≥5; AIS coverage degrades in polar / remote areas; FIRMS NRT data is provided "within 3 hours of a satellite observation (on a best effort basis)" per the NASA Earthdata FIRMS FAQ (with RT at ≤30 min and URT at ≤5 min as separate tiers); Space-Track / 18 SDS GP "data only updates 2-3 times a day" per CelesTrak's GP-formats documentation, which is why CelesTrak itself only refreshes from upstream every 2 h.
- Several listed sources (CTBTO, EURDEP full data) are NOT publicly accessible — included only for completeness and clearly flagged as restricted.
- All authentication mechanics, rate limits, and endpoint URLs should be re-verified against each provider's official docs at deployment time; this document reflects the state captured during research in May 2026.