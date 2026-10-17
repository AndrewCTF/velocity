# New ADS-B Aggregator Projects (2025–2026) with Free Public Endpoints

Research date: 2026-10-03. Research only — **no endpoints were called**; all claims
below come from GitHub metadata (via `gh api search/repositories`), raw README files
(raw.githubusercontent.com), and the vendors' own API documentation pages.

## Critical framing: aggregator vs. consumer

Most "ADS-B GitHub projects" from 2025–2026 are **consumers** — ESP32 dashboards, TUI
trackers, HA integrations, Telegram bots — that merely _call_ an existing aggregator
(adsb.lol, adsb.fi, OpenSky). They expose no endpoint of their own. The genuinely new
**aggregator-core** projects (own receiver network + own public API) are much rarer.

---

## Tier 1 — Real aggregator-core, new in 2026, public endpoint

### ADSBiq — the strongest new find

- **Sites:** https://adsbiq.com · https://api.adsbiq.com · docs at `/api/docs` (OpenAPI 3.1 contract published)
- **Repos (org `Sky-Power-Services`, all created 2026):**
  - `Sky-Power-Services/adsbiq-data` — daily open Parquet, ODbL-1.0. Pushed 2026-10-02.
  - `Sky-Power-Services/adsbiq-api-demo` — credential-free REST/WS/Flask examples. Pushed 2026-08-22.
  - `Sky-Power-Services/adsbiq-mcp-server` — remote MCP at `https://adsbiq.com/mcp`. Pushed 2026-09-07.
  - `Sky-Power-Services/adsbiq-home-assistant` — HA sensors over retained-delta MQTT.
  - `adsbiq/adsbiq-feeder` — OSS feeder install scripts (readsb/dump1090 autodetect, Beast 30004, MLAT 31090).
- **Endpoint surface (from /api/docs):** ~31 endpoints across
  - Search: `/v2/hex/{hex}`, `/v2/reg/{reg}`, `/v2/type/{type}`, `/v2/callsign/{callsign}`,
    `/v2/flight/{identifier}`, `/v2/flights`, `/v2/operator/{code}/flights`, `/v2/types/{type}/flights`,
    `/v2/operators`, `/v2/types`
  - Location: `/v2/bbox`, `/v2/aircraft/nearest`, `/v2/airports/nearby`, `/v2/lat/{lat}/lon/{lon}/dist/{nm}`
  - Airports/routes (8), tracking & safety (3), network stats (5), bulk snapshot (1)
  - Live **WebSocket** (snapshot + sparse deltas with sequence-gap detection)
- **Response shape:** readsb-compatible flat envelope — `now, messages, total, ctime, ptime, ac[]`
  with `lat/lon, alt_baro, alt_geom, gs, ias, tas, mach, track, roll, squawk, emergency,
nav_altitude_mcp, rssi, seen, route_origin, route_dest, type`.
- **⚠️ Caveat — not fully keyless:** auth is **feeder-gated**. Docs state live access is
  "earned by feeding" — 3-day trial, then Free tier (1 req/5 min, 150s push) vs Contributor
  (1 req/20s, 10s push). Also supports **IP-based auth** (no key from a home network).
  **Bulk Parquet downloads are free to everyone, no account, no limits.**
- Sister site: **vdlIQ** (https://vdliq.com/api/docs) — Mode-S/VDL2 (HFDL) equivalent.
- Zenodo DOI for citation: `10.5281/zenodo.22062551`.

### offworldlabs/adsb-service — RETINA ADS-B Data Plane

- Created 2026-08-26, pushed 2026-09-10. **Aggregator-core**, explicitly built on the
  adsb.lol lineage (`vendor/` includes adsblol/api, adsblol/infra, readsb).
- Ingests worldwide **ADSBHub SBS feed** (`data.adsbhub.org:5002`) + RETINA-node-contributed
  ADS-B; serves geo-filtered state back to nodes.
- Architecture: `ADSBHub adapter → readsb-hub (re-api :30152) → serving-api (FastAPI)`,
  serving `GET /v2/lat/{lat}/lon/{lon}/dist/{radius}` (adsb.lol v2 format).
- Status: Phase A (server-side v1) only; gRPC distribution + node rollout still planned.
  Node-local API → **not an open public endpoint**.

---

## Tier 2 — Aggregator-core, new-ish, keyless public endpoints (best usable finds)

### adsb.lol — `adsblol/api` (actively maintained 2026)

- **Public API:** `https://api.adsb.lol` — docs at `/docs`. **Drop-in ADSBExchange RapidAPI
  compatible.** No key required today.
- ⚠️ README states a key **will** eventually be required, obtainable by feeding.
  Rate limits are dynamic by load; 4xx usually means client error.
- GitOps infra: `adsblol/infra` (Flux/K8s: readsb, tar1090, mlat-server) — pushed 2026-06-03.
- **Open data drops (genuinely free, no key):**
  - `adsblol/globe_history_2026` — created 2026-01-02, pushed 2026-10-03, **1762 GiB**,
    ODbL. Daily tar-split readsb trace JSONs from prod/staging planes containers.
  - `adsblol/globe_history_2025` / `_2024` / `_2023` — same, per year.
  - `adsblol/aircraft-data-links-2025` — ACARS/HFDL/VDL2 open data, **CC0**, pushed 2026-03-01.
  - `adsblol/vrs-standing-data` — VRS standing data on GitHub Pages, updated hourly.
  - `adsblol/feed` — multi-feed MLAT/ADS-B/ACARS/VDL2 container client.

### mrjackwills/adsbdb — `api.adsbdb.com`

- Rust/axum + PostgreSQL + Redis, Docker. Aircraft, airline, and flightroute data.
- **Public, no key** (`https://api.adsbdb.com`); frontend `mrjackwills/adsbdb_site`
  (Vue 3/TS/Vuetify, pushed 2026-07-16). Data sourced from PlaneBase; flight routes
  credited to David Taylor / Jim Mason with redistribution restrictions.
- This is the enrichment layer several other new projects lean on.

---

## Tier 3 — Consumer-side projects (NO new public endpoint — useful as integration evidence)

These confirm which aggregators are actually being consumed in 2026, but expose nothing:

- `stevenselcuk/nearPlane` (2025-09-09, 23★) — ESP32 tracker via **adsb.lol** API
- `hecmeynell-debug/uk-airspace-pipeline` (2026-09-10) — production pipeline over public ADS-B, UK/North Atlantic
- `Paylicier/avion` (2026-08-13) — Cloudflare Worker aggregating **adsb.lol + airportdb**, demo at `avion.notri1.workers.dev`
- `kylehodgson/reapi-allowlist` (2026-08-27) — derives adsb.lol re-api feeder allowlist → Cilium
- `x86ed/adsb.lol-mcp` (2025-03-31) — MCP wrapper over adsb.lol
- `dirkhh/adsb-mcp-server` (2025-09-23) — MCP over any readsb/tar1090 feeder
- `Nicholaswilde/cyd-flight-radar`, `MrRonco/AirRadar`, `betty02/esp32-flight-radar` (2026) — adsb.fi consumers
- `forafox/adsb-traffic-analysis` (2026-09-27) — Cape Town analysis over OpenSky + adsb.lol
- `SkyLink-API/flight-tracking-api` (2026-03-29) — ⚠️ **thin/possibly vaporware**: 2★,
  README-only, no source code, "global network, 15M msgs/day". Listed on RapidAPI with a
  1,000 req/mo free tier (RapidAPI requires an account/key, so **not** keyless).

## Tier 4 — Supporting infrastructure (new, no public endpoint)

- `ADSBItalia/mlat-server` (2026-09-04) — native Rust MLAT server, GPL-3.0, 35MB RAM,
  claims 500+ feeders live. A modern replacement for mutability/wiedehopf's Python `mlat-server`.
- `flightportrait/mlatd` (2026-08-31) — Rust `mlat-client`-protocol-compatible MLAT server;
  sharded/geographic, Gauss-Newton solver, adaptive partitioning. **Pre-release, no long
  production deployment yet.**
- `flightportrait/mlatc` (2026-09-04) — one MLAT client feeding several servers
- `marklit/adsb_json` (2024-06-27, pushed 2024-07) — enriches adsb.lol feeds into 1M-line
  GZIP JSONL; **dated, pre-2025**, but reusable pipeline logic
- `CHA0S-CORP/SkySpy` (2025-12-26) — tar1090 alternative UI, public instance `radar.chaos.navy/`

---

## Dashboard aggregators (2026, high-star) — consumer of the above, not a feed source

- `BigBodyCobain/Shadowbroker` — 11,274★, created 2026-03-05, pushed 2026-10-01. 60+ OSINT
  feeds incl. ADS-B + AIS. Self-hosted, no accounts; **FastAPI backend** serves its own
  `/api/` routes (e.g. `/api/status/provenance` in the sibling project) but is operator-local.
- `NoblerWorks-HQ/IRONSIGHT` — 660★, created 2026-03-21. "No API keys required."
- `h9zdev/GeoSentinel` — 1,082★, created 2026-01-16. Aggregates flight + ship routes.
- `Syntax-Error-1337/radar` (2026-02-25) — RADAR v2.0.0, ADS-B via **adsb.lol (no auth) or OpenSky**.
- `AndrewCTF/velocity` — 94★, created 2026-06-12. **This is the local user's own repo**
  (`/home/andrew/Projects/OSINT`); self-hosted OSINT console w/ TimescaleDB history + MCP server.
- `Jieyab89`/`smittix/intercept` — SIGINT platform (2025-12-19, 2,411★)

---

## Bottom line

1. **ADSBiq** is the one genuinely new (2026) aggregator network with a published, richly
   documented public API — but live access is **feeder-gated**, not open. Its daily Parquet
   bulk data _is_ unconditionally free.
2. **`offworldlabs/adsb-service`** is the other new aggregator-core project (RETINA, built on
   adsb.lol, ingests ADSBHub) but is node-internal, not public.
3. **The keyless public endpoints that actually work today are the incumbents:**
   `api.adsb.lol` (ADSBExchange-compatible), `api.adsbdb.com`, plus OpenSky and adsb.fi.
   The 2025–2026 GitHub activity in ADS-B is overwhelmingly _downstream consumption_
   (ESP32/HA/TUI/MCP wrappers), not new aggregation infrastructure.
4. So for "new + aggregator + free public endpoint," the realistic picks are
   **ADSBiq bulk data** and **adsb.lol globe_history_2026** (1762 GiB, ODbL, no key) —
   both excellent OSINT research sources that need no credentials at all.
