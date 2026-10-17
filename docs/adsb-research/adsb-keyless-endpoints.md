# Keyless (No-Auth) ADS-B Endpoints Found in GitHub Repos & Awesome-Lists

**Date:** 2026-10-04 · **Method:** GitHub code search (REST `/search/code`) + raw file retrieval.
**No endpoints were called** — research only; hostnames extracted from source/docs text.

## Core finding

Five hosts dominate: the "tar1090-family" mirrors all share the same `/v2/point/{lat}/{lon}/{nm}` and
`/api/v3/lat/{lon}/{lat}/{dist}` schema. `aircraft.json` is the readsb/dump1090-native path
(`http://<receiver>:8080/data/aircraft.json` locally; the _public_ keyless equivalent is on adsb.fi/adsb.lol
mirror hosts). AirplaneScatter hardcodes a 5-host failover chain — the most complete public list found.

---

## Tier 1 — Public mirrors, no key (tar1090 / readsb family)

| Host                    | Documented paths                                                                                                                                       | Notable source                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.adsb.lol`          | `/v2/point/{lat}/{lon}/{nm}`, `/v2/point/0/0/10000`, `/v2/hex/{icao}`, `/v2/icao/{icao}`, `/v2/callsign/{cs}`, `/v2/mil`, `/v2/all`, `/api/0/routeset` | j4v3l/ADS-B_TUI `docs/DATA_SOURCES.md`; VrushankPatel/godseye `src/constants/dataSources.js`; 0xchamin/skyintel `src/voyageintel/flights/adsb_lol.py`; ArduPilot/MissionPlanner `ExtLibs/Utilities/adsb.cs`; MickWest/Sitrec2 `sitrecServer/proxyADSBLive.php` |
| `api.airplanes.live`    | `/v2/point/{lat}/{lon}/{nm}`, `/v2/point/0/0/10000`, `/v2/mil`                                                                                         | Highpoint2000/AirplaneScatter `AirplaneScatter/airplanescatter.js`; Stellarium/stellarium `plugins/Planes/src/Planes.cpp`; VrushankPatel/godseye; BigBodyCobain/Shadowbroker `backend/services/fetchers/flights.py`                                            |
| `api.adsb.one`          | `/v2/point/{lat}/{lon}/{nm}`, `/v2/point/0/0/10000`                                                                                                    | Highpoint2000/AirplaneScatter; VrushankPatel/godseye (`docs/FEED_RESEARCH.md`, `src/constants/dataSources.js`)                                                                                                                                                 |
| `api.adsb.fi`           | `/v2/point/{lat}/{lon}/{nm}`                                                                                                                           | Highpoint2000/AirplaneScatter `airplanescatter.js`                                                                                                                                                                                                             |
| `api.theairtraffic.com` | `/v2/point/{lat}/{lon}/{nm}`                                                                                                                           | Highpoint2000/AirplaneScatter `airplanescatter.js` (rarest; often omitted by other tools)                                                                                                                                                                      |
| `opendata.adsb.fi`      | `/api/v3/lat/{lon}/{lat}/{dist}` (also `/api/v3/lat/{lat}/{lon}/{dist}` variant — inconsistent across repos)                                           | Stellarium/stellarium `plugins/Planes/src/Planes.cpp`; Yeraze/meshmonitor `src/utils/adsbFeeds.ts`; koala73/worldmonitor `scripts/seed-military-flights.mjs`; BigBodyCobain/Shadowbroker; rarthur22/skyview `docs/SETUP.md`                                    |

Additional mirror hosts referenced by Highpoint2000 projects (AirplaneScatter, LiveMap, MeteorScatter,
fm-dx-webserver, stream): `api.fmlist.org`, `tef.noobish.eu`.

## Local/self-hosted keyless (documented as defaults)

- `http://localhost:8080/data/aircraft.json`, `http://localhost:9090/data/aircraft.json` — j4v3l/ADS-B_TUI `docs/DATA_SOURCES.md`
- `http://<receiver>:8080/data/aircraft.json` — j4v3l/ADS-B_TUI; mccahan/esp32-nearest-plane
- `http://tar1090/data/aircraft.json` — adsblol/feed `docker-compose.yaml`
- `http://adsbexchange.local/tar1090/data/aircraft.json` — bmidgley/adsb2mqtt `README.md`
- wiedehopf/readsb `README-json.md` documents the `aircraft.json` schema and `json_out.c` origin

## Keyed / paid — found hardcoded, use as contrast

- `adsbexchange.com/api/aircraft/json/` (needs `?apiKey=`) — j4v3l/ADS-B_TUI; afk11/airtrack `pkg/tracker/adsbx_producer.go`; k2fc/scope `DGScope.Receivers.ADSBX/ADSBExchageReceiver.cs`
- `public-api.adsbexchange.com/VirtualRadar/AircraftList.json` (legacy, no key historically) — ArduPilot/MissionPlanner `ExtLibs/Utilities/adsb.cs`
- `gateway.adsbexchange.com/api/receive/` (ingest, keyless) — api-evangelist/adsbexchange OpenAPI spec; adsb-related-code/adsb-stats `json-status`
- `aeroapi.flightaware.com`, `api.aviationstack.com` — Die-Hu/awesome-giser `data-sources/space-aerospace.md`; RishiJain905/TerraWatch
- `customer-api.wingbits.com/v1/flights` — koala73/worldmonitor `scripts/seed-military-flights.mjs`
- `auth.opensky-network.org/.../token` (OAuth) — BigBodyCobain/Shadowbroker; koala73/worldmonitor

## Other keyless aviation endpoints seen

- `opensky-network.org/api/states/all` — anonymous/no-key (godseye comments explicitly: _"anonymous access, no API key needed"_), but **CORS-blocked** in browsers → proxied via `api.allorigins.win/raw?url=`
- `aviationweather.gov/api/data/{metar,sigmet,airsigmet}` — VrushankPatel/godseye `src/constants/dataSources.js` (keyless)
- `api.planespotters.net/pub/photos/hex/{icao}` — Highpoint2000/AirplaneScatter
- `adsbdb.com` — rusty3699/termradar `docs/DATA_PROVIDERS.md`

## Awesome-lists & curated source docs (best single references)

- **rickstaa/awesome-adsb** (★388) — the canonical curated ADS-B list
- **Die-Hu/awesome-giser** `data-sources/space-aerospace.md` — geo/OSINT data sources incl. adsb.lol, adsb.one, adsbexchange, aeroapi
- **j4v3l/ADS-B_TUI** `docs/DATA_SOURCES.md` + `docs/CONFIGURATION.md` — most thorough ADS-B **keyless-vs-keyed** source matrix
- **VrushankPatel/godseye** `docs/FEED_RESEARCH.md` + `src/constants/dataSources.js` — explicit "ADS-B public mirrors with CORS enabled and no auth requirement", incl. `/v2/point/0/0/10000` global-radius trick
- VrushankPatel/godseye `docs/FEED_RESEARCH.md` has a section literally titled **"5) Conflict / War Data (Keyless)"**
- Also: Nardo021/SkyOS `docs/data-sources.md`; socquique/capsule-radar & Ziplock78/orb-os `docs/DATA_SOURCE.md`; rusty3699/termradar `docs/DATA_PROVIDERS.md`; sanztheo/SeeYou `docs/data-sources.md`; rwmqx7dwb5-arch/IntMap `docs/AVIATION-DATA-SOURCES.md`; RishiJain905/TerraWatch `docs/DATA_SOURCES.md`; ExpertVagabond/adsb-integrity-monitor `aim/feed.py`; Valar-Systems/valar-scopes `proxy/FEED-SOURCING.md`; delphicchen/esp32_flight_radar `PLAN_SOURCES.md`; buriedsignals/scoutpost-os `docs/features/transport.md`

## Highest-value repos to read for a live failover list

1. **Highpoint2000/AirplaneScatter** → `AirplaneScatter/airplanescatter.js` — 5-host `/v2/point` failover chain + `api.fmlist.org`, `tef.noobish.eu`
2. **Highpoint2000/AirplaneScatter** → `AirplaneScatter/airplanescatter_server.js`
3. **VrushankPatel/godseye** → `src/constants/dataSources.js`
4. **j4v3l/ADS-B_TUI** → `docs/DATA_SOURCES.md`
5. **koala73/worldmonitor** → `scripts/source-attribution.mjs`, `scripts/seed-military-flights.mjs`

## Notes / caveats

- `aircraft.json` and `/v2/point` are **different endpoint families**: `aircraft.json` is the readsb/dump1090
  native REST output (default port 8080), typically reached on a LAN receiver. Public-keyless hits for the
  literal string `aircraft.json` + `adsb.fi` returned **0** on GitHub — the public mirrors use `/v2/point`
  and `/api/v3/lat/...`, not `aircraft.json`.
- `/v2/point/0/0/10000` (lat 0, lon 0, 10000 NM) is the widely-copied trick for near-global coverage in one call.
- godseye flags that mirrors have **CORS enabled** (browser-callable) while OpenSky does not.
- Search-result counts observed: `api.airplanes.live/v2/point` 443, `adsb.lol/v2/point` 428, `adsb.fi`+`/v2/point`
  301, `aircraft.json`+`adsbexchange` 265, `"v2/point" "adsb.lol"` 740, `api.fmlist.org` 9.
- Gist-specific search returned nothing usable (GitHub search does not index gist content separately).
