# Feature surface — where things live

A map of the platform so you can place new work. Verify exact signatures yourself
before building (this is orientation, not a contract). Backend is `apps/api/app`,
frontend is `apps/web/src`, desktop is `apps/desktop` (Tauri shell over the web dist).

## Backend routes (`apps/api/app/routes/*.py`)

**Air:** `adsb` (open ADS-B aggregators, live mil/squawk, `/ws/adsb`), `aviation`
(OpenSky state vectors), `acars` (keyless ACARS/VDL/HFDL/SATCOM).
**Maritime:** `ais` (AISStream WS bridge `/ws/ais`), `maritime` (keyless AIS union —
Digitraffic Baltic + Kystdatahuset Norway), `sar` (SAR dark-vessel + LOD1).
**Geospatial:** `tiles` (basemap/sat/terrain proxies), `imagery` (sat tiles, catalog,
AOI chip, change-detect, tasking), `places` (airports/ports), `geocode`, `ground`
(Panoramax + KartaView street-level), `space` (CelesTrak orbital catalogue).
**Hazards/events:** `eq` (USGS), `seismic` (EMSC), `firms` (NASA fires), `weather`
(Open-Meteo + SWPC Kp), `events`/`conflict` (EONET/GDELT/ACLED), `cables`, `cyber`
(IODA/Cloudflare outages), `jamming` (GPS/GNSS via NACp).
**Intel core:** `intel` (deep agent analytics — situation, dossier, anomalies, brief,
investigate, agent, watch, deception, emitter, POL, AOIs), `ontology` (typed spine),
`entity`, `correlations`, `search` (`/api/search/objects` faceted), `extract`,
`situations`, `targets` (F2T2EA kanban), `actions` (governed write-back + HITL
proposals), `audit`, `osint` (keyless dns/whois/certs/ip/shodan/threat + investigate),
`watch_officer` (standing loop → cited draft briefs; see worked-example.md).
**Ops/collab:** `alerts` (`/ws/alerts`, standing detections), `alert_rules`, `maps`
(shared COP `/ws/cop`), `collab` (CRDT), `route` (nav — see loose ends), `history`
(position playback), `timeline`, `simulation` (`/api/sim/reason`).
**News/report:** `news` (debias + fact-check), `export` (GeoJSON/CSV + PPTX brief).
**Studio/3D:** `recon` (local 3DGS jobs). **Platform:** `config`, `ai` (local-inference
toggle), `keys` (BYOK + `/api/me`), `health`, `status`, `cams`.

## Backend capability modules

Top-level `app/*.py`: `main` (app factory + lifespan), `auth`+`security`+`tier`+`keys`
(auth/ACL/gating/BYOK), `llm` (unified client — DeepSeek/MiniMax primary, Ollama local
fallback; `chat(messages, tier="fast"|"reason")`), `mcp_server` (MCP GEOINT tools),
`upstream` (shared httpx + TTL cache), `tilecache`, `history` (SQLite positions),
`audit`, `places`, and feed sidecars: `acars`, `ais_firehose`/`ais_keyless`/`ais_sidecar`
(VesselFinder headless), `adsb_sidecar` (tar1090 headless), `marinetraffic`, `eusi`.

`intel/` subpackage — the analytics engine: `analytics`, `agent`, `actions`, `aoi`,
`baseline`, `pol`/`dossier`, `detectors` (ais_gap/proximity/loiter), `deception`, `cue`
(tip-and-cue → SAR), `watch` (geofence eval), `watch_officer`, `emitter`, `incidents`+
`incident_store` (fusion + diff), `ontology`, `graph_analytics` (centrality/community,
no networkx), `resolve` (entity resolution), `classification` (IC markings/ACL), `geo`,
`ground`, `imagery_index`, `lod1`, `offroad`, `sar_damage`, `sar_vessels`. Plus `osint/`,
`news/`, `correlate/` (`bus` pub/sub + `rules`/`runner`/`store`), `fusion/`, `imagery/`
(gibs/cdse/ondemand/tasking/tiler), `ingest/`.

## Frontend feature dirs (`apps/web/src/*/`)

**Map:** `globe` (Cesium canvas + `adapters` — the render plumbing, guarded), `maplibre`
(2D), `lod1`, `imagery`, `layer-rail`. **Feeds:** `acars`, `cams`, `weather`, `ground`,
`tasking`. **Intel:** `entity-panel` (inspector + cards), `osint`, `intel`, `graph`
(investigation canvas), `explorer` (object explorer), `situations`, `target-kanban`,
`watchbox`, `annotations`, `timeline`. **Ops:** `alerts`, `collab`, `cop` (+ORBAT),
`command-bar` (omnibar + agent console), `field`, `inbox`, `metrics`. **Media:** `fmv`,
`studio`, `sim`. **News:** `news`, `news-panel`, `reports`, `extract`. **Shell/infra:**
`shell` (app switcher, rails, tabbed panels), `auth`, `settings`, `security`, and the
non-panel infra `state`/`theme`/`transport`/`types`/`registry`.

## Data plumbing invariants (do not rewrite)

- **Alerts** flow through `correlate/bus.py` (`bus.publish(Alert)`) → `/api/alerts` +
  `/ws/alerts` → `useAlerts` store → InboxPanel. The `Alert` dataclass is deliberately
  thin (id, rule_id, severity, t, lon, lat, confidence, message, contributing[]).
- **Live entities** use upsert-by-id in `PollGeoJsonAdapter`; the `/ws/adsb` push is the
  primary transport, the HTTP poll is the fallback + zoomed-bbox path.
- **Background loops** register in `main.py` lifespan under `if background:` and tear down
  in `finally`; each module follows the `intel/watch.py` idiom (`_TASK`/`_STARTED` +
  `start`/`stop`/`_run_forever` + `asyncio.sleep(cycle)`). `OSINT_DISABLE_BACKGROUND`
  short-circuits them all (tests).
- **In-process snapshot** consumers call `adsb.global_snapshot()`, never the
  `adsb_global()` route handler in-process (its `Query(...)` defaults 500).

## Known half-wired loose ends (cheap wins)

- `route.py` (`/api/route/*` road/offroad/fastest/candidates — full nav) has **no
  frontend consumer**. A whole capability is dark; a minimal "route-to" control unlocks it.
- `sim/TrafficController.ts` calls `/api/interpreter` — **no such route exists.** Dead or
  external reference; verify and fix or delete.
- `/api/audit` and `/api/status` have no viewer (minor).
