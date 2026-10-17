# Free / No-Key ADS-B APIs — Small & Regional Aggregators (excl. big-5)

**Date:** 2026-10-04 · **Method:** Provider docs, GitHub orgs/repos, licence files, comparative tables.
**Scope:** Flight-tracking services _other than_ FlightRadar24, FlightAware, Radarbox, ADS-B Exchange, OpenSky.
**Companion docs:** `adsb-keyless-endpoints.md` (GitHub code-search of consumer projects),
`adsb_keyless_refresh_rates.md` (refresh cadence), `docs/adsb-aggregators-2025-2026.md` (ADSBiq/RETINA).
This doc adds the **provider-side view**: official endpoint contracts, auth reality, rate limits,
licences, and dead ends.

---

## TL;DR — ranked by "usable right now with zero friction"

| #   | Provider                         | Base URL                  | Key?                          | Schema                     | Licence                             | Verdict                                                               |
| --- | -------------------------------- | ------------------------- | ----------------------------- | -------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| 1   | **adsb.lol**                     | `api.adsb.lol`            | **No**                        | ADSBexchange-v2 compatible | ODbL                                | **Best.** Only one with open _historical_ bulk data                   |
| 2   | **adsb.fi** (open data)          | `opendata.adsb.fi/api`    | **No**                        | ADSBexchange-v2 compatible | Personal, non-commercial + citation | **Best documented.** `/v3` is current, `v2` geo deprecated            |
| 3   | **FlyItalyADSB**                 | `api.flyitalyadsb.com/v2` | Free key by email             | Own schema                 | **CC BY-SA 4.0**                    | Only CC-licensed one; has **MCP server** for agents                   |
| 4   | **Mictronics/aircraft-database** | GitHub releases           | **No** (static files)         | aircraft DB dumps          | ODbL                                | Not live ADS-B — but the best no-key **type/registration** enrichment |
| 5   | **airplanes.live**               | `api.airplanes.live/v2`   | Free key, **manual approval** | ADSBexchange-v2            | Non-commercial                      | Key request = human-reviewed. Not truly keyless                       |

**Universal note:** every ADSBexchange-compatible aggregator in this tier (adsb.lol, adsb.fi, ADS-B One,
airplanes.live) is **pull-based live** — it returns whatever the aggregator holds at request time and
publishes **no** refresh interval. Rate limits (how often _you_ may poll) are a different thing from data
freshness. See `adsb_keyless_refresh_rates.md`.

---

## 1. adsb.lol — the strongest no-key find

**Docs:** https://api.adsb.lol/docs (Swagger) · spec: `https://api.adsb.lol/api/openapi.json`
**Source:** https://github.com/adsblol/api · **Licence:** ODbL

Verified from the live OpenAPI contract (`info.description` + `paths`):

> "The adsb.lol API is a free and open source API… You can use the API for free. **In the future, you will
> require an API key which you can get by feeding to adsb.lol.**"

⚠️ **Key is an announced future requirement, not current.** Treat as unstable for production; fine for research.
The repo states it is a **drop-in replacement for the ADS-B Exchange Rapid API**, and rate limits are
**dynamic based on environment load** (no published number).

Documented endpoints (no auth on any):

| Path                                                                              | Notes                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `/v2/lat/{lat}/lon/{lon}/dist/{radius}`                                           | radius **nm**, max 250                                |
| `/v2/point/{lat}/{lon}/{radius}`                                                  | same, aliased                                         |
| `/v2/closest/{lat}/{lon}/{radius}`                                                | single nearest aircraft                               |
| `/v2/hex/{icao_hex}` · `/v2/icao/{icao_hex}`                                      | comma-separated hexes accepted                        |
| `/v2/callsign/{callsign}` · `/v2/reg/{registration}` · `/v2/type/{aircraft_type}` | lookup by each field                                  |
| `/v2/sqk/{squawk}` · `/v2/squawk/{squawk}`                                        | e.g. 7700 emergency, 7500 hijack, 1200 VFR            |
| `/v2/mil` · `/v2/pia` · `/v2/ladd`                                                | military / Privacy-ICAO / FAA Limiting-Aircraft lists |
| `/api/0/airport/{icao}` · `POST /api/0/routeset` · `/0/me` · `/0/my`              | airports, inferred routes, your feeder stats          |

`/v2/ladd` and `/v2/pia` are unusual — most public mirrors filter military/PIA out; this one exposes them.

### 1b. The historical gold mine (no key, ODbL, no account)

`adsblol/globe_history_YYYY` — **2023, 2024, 2025, 2026** repos, ~**1762 GiB** per year, **one release per day**.

- Index: `RELEASES.md` (raw.githubusercontent.com) lists every date with sizes.
- Verified 2026 cadence: prod ≈ **3.8 GB/day**, staging ≈ 3.8 GB/day, plus a small `planes-readsb-mlatonly-0` (~340 MB).
- Format: readsb `trace` JSON, gzip-compressed, split tar → reassemble then extract:
  ```
  cat v2025.05.18-planes-readsb-prod-0.tar.aa v2025.05.18-planes-readsb-prod-0.tar.ab \
    | tar -xf - -C 2025.05.18
  ```
  Split folders: `traces/` (per-aircraft history) and `heatmap/` (drives map replay).
- Schema reference: wiedehopf/readsb `README-json.md#trace-jsons`.
- Data also includes FlyItalyADSB and theairtraffic.com feeders.
- **Practical takeaway:** you can build a **global flight-history OSINT corpus** with zero API keys,
  entirely from GitHub release assets.

---

## 2. adsb.fi open data — best-documented no-key service

**Authoritative docs:** https://github.com/adsbfi/opendata/blob/main/README.md (raw README; the website
`/opendata` route 404s, so the GitHub README _is_ the doc).

- **Base:** `https://opendata.adsb.fi/api/` · ~6,500 feeders · unfiltered.
- **Rate limits (documented):** public endpoints **1 req/s**; feeder `/v2/snapshot` 1 req/30 s.
  ⚠️ **Any 4xx/5xx (400/401/403/404/429) counts toward the limit** → typos get you throttled. Validate hex/callsign client-side.
- **Feeder privilege is IP-based/automatic** — no signup; your feeder IP is auto-granted `/v2/snapshot` (all aircraft, 2×/min).
- **Current endpoint is `/v3/lat/{lat}/lon/{lon}/dist/{dist}`.** The older `v2` geo endpoint returns a
  _different_ shape than other v2 endpoints — explicitly deprecated.
- **Terms:** personal, non-commercial only; must cite adsb.fi and link the homepage; as-is, no warranty;
  right to suspend. Exceeding limits → temporary IP ban.

| Path                                                 | Description                            |
| ---------------------------------------------------- | -------------------------------------- |
| `/v2/hex/[hex]` · `/v2/icao/[hex]`                   | by Mode-S hex (comma-separated OK)     |
| `/v2/callsign/[callsign]` · `/v2/registration/[reg]` | lookup                                 |
| `/v2/sqk/[squawk]` · `/v2/mil`                       | squawk / military                      |
| `/v3/lat/[lat]/lon/[lon]/dist/[dist]`                | **use this** for geo, up to 250 NM     |
| `/v2/snapshot`                                       | feeder-IP only — full network snapshot |

---

## 3. FlyItalyADSB — CC BY-SA 4.0, and an MCP server

Born in Italy, 3,200+ direct feeders, own MLAT server (1,800+ synced receivers, incl. over Italy).
**Licence: CC BY-SA 4.0** — the most permissive licence in this tier, and the reason it's interesting
for OSINT redistribution.

- **Docs (Italian site, has `llms.txt`):** https://flyitalyadsb.com/api · https://flyitalyadsb.com/llms.txt
- **Comparison page:** https://flyitalyadsb.com/dati/confronto — a factual rate-limit/feeder/licence
  matrix of every major open ADS-B API. Genuinely useful reference.
- **Base:** `https://api.flyitalyadsb.com/v2`, all calls need `X-Api-Key`.
- **Key:** `POST /v2/keys {email}` → **instant, free, self-serve, no manual approval** (the only provider
  here with a genuinely frictionless signup). Rate limit **100 req/min/IP**.
- **Endpoints:** `/v2/icao/{hex}`, `/v2/callsign/{cs}`, `/v2/reg/{reg}`, `/v2/lat/{lat}/lon/{lon}/dist/{km}`
  (note: **km**, not nm), `/v2/mil`, `/v2/pia`, `/v2/ladd`, `/v2/history/{icao}[/{date}]` (per-aircraft
  daily track, recent days only).
- **MCP server for agents:** https://flyitalyadsb.com/mcp (Streamable HTTP JSON-RPC) with tools
  `find_aircraft`, `aircraft_near`, `special_traffic`, `aircraft_history`. Machine-readable descriptions at
  `/.well-known/mcp/server-card.json` and per-tool `SKILL.md` files at `/.well-known/agent-skills/index.json`.
- **Unique data:** unfiltered (no LADD/BARR), military/state via own MLAT, plus raw **Mode-S BDS50/BDS60**
  (TAS/magnetic heading/Mach) used for tropospheric wind research — unusual and hard to get elsewhere.
- ⚠️ `flyitalyadsb.com` sits behind **Cloudflare** that blocked both curl and browser during testing;
  `llms.txt` and the API pages were reachable via plain curl with a browser UA, others were not.

---

## 4. Static no-key aircraft/flight data (not live tracking)

- **Mictronics/aircraft-database** — https://github.com/Mictronics/aircraft-database
  Weekly-updated ODbL exports: `aircraft_db.zip` (dump1090-fa/mutability), `icao_aircraft_types.zip`,
  `indexedDB.zip` (readsb protobuf), `icao24plus.zip` (adsbSCOPE). Best no-key way to resolve
  **hex → type/registration/operator** offline when enriching a pulled hex list.
- **adsblol/globe_history_YYYY** (above) — the flight-history corpus.
- `aviationweather.gov/api/data/{metar,sigmet,airsigmet,stationinfo}` — confirmed reachable and keyless
  (returns a 400 "must specify station IDs or bounding box" when called bare, i.e. live & unauthenticated).
  Complementary, not ADS-B.

---

## 5. Dead ends — checked, do not build on these

| Candidate                       | Finding                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADS-B One** (`api.adsb.one`)  | **Dead.** API behind Cloudflare (403); `adsb.one` front-end loads but reports **"Feeder count: 0"**. GitHub org `ADSB-One` (6 followers) is only upstream forks of readsb/tar1090/adsbx-update + a 3-star `site` repo. Comparison table states the API repo was **archived April 2026 after merging into airplanes.live**. Previous keyless lists still list `api.adsb.one/v2/point` — **treat as stale.** |
| **adsbapi.com**                 | Domain is **parked for sale** on Afternic (no API).                                                                                                                                                                                                                                                                                                                                                        |
| **adsbhub.com**                 | Same — parked/Afternic.                                                                                                                                                                                                                                                                                                                                                                                    |
| **airhex.io / api.airhex.io**   | **NXDOMAIN** — dead.                                                                                                                                                                                                                                                                                                                                                                                       |
| **adsbhub.com/api.adsbhub.com** | NXDOMAIN.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **aviation-edge.com**           | Apex only; `www.aviation-edge.com` alive but **API key mandatory** — not no-key.                                                                                                                                                                                                                                                                                                                           |
| **airlabs.io**                  | API reachable but key-gated ("Application not found" unauthenticated).                                                                                                                                                                                                                                                                                                                                     |
| **theairtraffic.com**           | Host resolves; Cloudflare hard-blocks. A feeder source for adsb.lol/FlyItalyADSB, but **no self-serve API found**.                                                                                                                                                                                                                                                                                         |
| **vradarserver.com / VRS**      | NXDOMAIN.                                                                                                                                                                                                                                                                                                                                                                                                  |
| **airplanes.live**              | Not dead but **not keyless**: `api.airplanes.live` returns a hand-written 403 — _"Please contact us… Your email MUST include any links, a description of the project…"_ Human-reviewed key. Free tier 1 req/s, **500 req/day**; Contributor 8,640/day. Spec is at `https://www.airplanes.live/api-docs/api.yaml` (Stoplight), Cloudflare-gated.                                                            |

---

## 6. Practical recommendations for this OSINT project

1. **Primary live source: `api.adsb.lol`** — no key, ODbL, `/v2/mil` + `/v2/pia` + `/v2/ladd` exposed,
   and the endpoint surface is broader than adsb.fi's. Its `/v2/sqk/{squawk}` supports emergency
   (7700/7500/7600) monitoring with no auth.
2. **Secondary / failover: `opendata.adsb.fi/api/v3/lat/.../dist/...`** — larger network (~6,500 feeders),
   ADSBexchange-v2 compatible so the same parser works. Respect 1 req/s and **never send malformed hexes**.
3. **Bulk history: pull `adsblol/globe_history_YYYY` releases** — the only no-key flight-track archive in
   existence. Prefer `mlatonly` (~340 MB/day) when MLAT/aircraft-without-ADS-B is the target; take
   prod when you need full telemetry.
4. **Enrichment: Mictronics/aircraft-database** weekly ODbL dumps for hex→type/registration offline.
5. **Only if you need Mode-S BDS50/BDS60 or permissive CC BY-SA reuse: FlyItalyADSB**
   (`POST /v2/keys {email}`, instant). Its MCP endpoint is the cheapest way to wire this into an agent.
6. **Treat `api.adsb.one` as removed** — purge it from any failover list built off older keyless writeups.
