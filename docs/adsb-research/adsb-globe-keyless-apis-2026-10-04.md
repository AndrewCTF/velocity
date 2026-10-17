# ADS-B globe/tracking sites with keyless backing APIs

**Date:** 2026-10-04 · **Method:** live HTTP verification (specs, schema reads, cheap
non-firehose endpoints) + provider docs. No `aircraft.json` or `/v2/point` was called.
**Companion docs:** `adsb-keyless-endpoints.md` (consumer-code view),
`alt-free-adsb-apis-2026-10-04.md` (provider-side view, does NOT contain adsb.exposed
or AvioADSB — this file fills that gap).

## TL;DR

| # | Site | Backing API | Keyless? | Shape | Licence |
|---|------|-------------|----------|-------|---------|
| 1 | **adsb.exposed** | ClickHouse HTTP `https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website` | **Yes** — no password, role-scoped read-only | SQL over `planes_mercator*` (44 B+ rows, 2022→live) | Repo **CC BY-NC-SA 4.0**; underlying adsb.lol rows **ODbL v1.0** |
| 2 | **adsb.lol** | `https://api.adsb.lol` (OpenAPI 3.1) | **Yes** — no `security` block on any of 18 paths | ADSBexchange-v2 `{ac:[…],msg,now,total,ctime,ptime}` | **ODbL v1.0** |
| 3 | **AvioADSB** (avioadsb.org) | `https://avioadsb.org/v1` (OpenAPI 3.1) | **Yes** — anonymous tier, 100 req/day | adsb.lol/readsb-compatible + `dst`/`dir` | **CC BY 4.0**, personal + research only |
| 4 | **GPSJAM** (gpsjam.org) | `https://gpsjam.org/data/manifest.csv`, `/data/{date}-h3_4.csv` | **Yes** — plain static files | CSV, gzip | Not stated (donation-supported, by John Wiseman); derived from airplanes.live + ADSB-Exchange |

Verified live 2026-10-04: adsb.exposed ClickHouse returned `count() = 32,289,832,983`
rows spanning `2022-02-01` → `2026-10-04 05:05`; adsb.lol `/v2/mil` returned
`total: 79`; AvioADSB `/v1/stats` returned HTTP 200 with
`x-avioadsb-tier: anonymous`, `x-ratelimit-remaining: 99`; GPSJAM manifest returned
1692 rows (2022-02-14 → 2026-10-03).

---

## 1. adsb.exposed — the biggest find: 32 billion rows of queryable history, no key

**Website:** https://adsb.exposed/ (ClickHouse/adsb.exposed, ★462)

The site is a front-end; the data API is the **ClickHouse HTTP interface** the
front-end itself queries. The endpoint is **not documented in the README** — it was
recovered from `https://adsb.exposed/config.js`, which is served unauthenticated and
lists, per dataset:

```js
endpoints: [{ name: "Cloud (Real-Time)", urls: [{
    url: "https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com",
    sticky: "https://{hash}.sticky.kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com",
}]}]
```

**Authentication is a username with no password.** The inline script in
`adsb.exposed/?dataset=Planes` builds every request as:

```js
url = host => `${host}/?user=website&default_format=JSONEachRowWithProgress&query_id=${query_id}`
```

There are four such users, all passwordless and role-scoped read-only:
`website`, `website_progress`, `website_saved_queries`, `website_stats`.

- `?user=default` (no user param) → `Code: 194 ... Authentication failed`. **The
  username is required; no secret exists to omit.**
- `?user=website` → works anonymously.

**Verified (no key, no headers):**

```bash
curl --data-binary "SELECT version()" \
  "https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website"
# 26.10.1.39301

curl --data-binary "SELECT count(), min(time), max(time)
  FROM planes_mercator_sample10 FORMAT TSV" \
  "https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website"
# 32289832983   2022-02-01 00:00:00.001   2026-10-04 05:05:10.002
```

Live bounding-box query works (LHR area, last 5 min):

```bash
curl --data-binary "SELECT time,icao,t,altitude,ground_speed,track_degrees,lat,lon,source
  FROM planes_mercator_sample10
  WHERE time > now() - INTERVAL 5 MINUTE
    AND lat BETWEEN 51.2 AND 51.5 AND lon BETWEEN -0.6 AND 0.2
  ORDER BY time DESC LIMIT 3 FORMAT JSONEachRow" \
  "https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website"
```
```json
{"time":"2026-10-04 05:07:42.002","icao":"06a148","t":"A388","altitude":2350,
 "ground_speed":179,"track_degrees":270,"lat":51.465408,"lon":-0.212021,"source":"adsb_icao"}
```

### Tables (use the samples, not the full table)

| Table | Sampling | Note |
|-------|----------|------|
| `planes_mercator_sample100` | 1/100 | fastest, use for big scans |
| `planes_mercator_sample10` | 1/10 | **measured 32.29 B rows** |
| `planes_mercator` | full | 44.47 B rows (README, Mar 2024) — a `count()` over a recent window **timed out at 90 s**; do not hit this cold |

Sibling datasets in the same DB are queryable the same way: `Ships` (AIS),
`OSM`/`OSM History`, `GBIF`, `Buildings`, `Weather`, `Taxi`, `Fires`, `Lightning`,
`Population`, `Transit`.

### Schema (live `DESCRIBE TABLE planes_mercator`)

`time` `DateTime64(3)` · `date` `Date` · `icao` `String` · `r` (registration) ·
`t` (type) · `desc` (description) · `ownOp` (operator) · `year` · `lat`/`lon` `Float64` ·
`altitude` `Int32` · `ground_speed` `Float32` · `track_degrees` `Float32` ·
`vertical_rate` · `flags` `UInt32` · `dbFlags` · `noRegData` `Bool` ·
`geometric_altitude` · `geometric_vertical_rate` · `indicated_airspeed` · `source` ·
`aircraft_squawk` · `aircraft_baro_rate` · `aircraft_flight` · `aircraft_category` ·
`aircraft_emergency` · `aircraft_ias` / `tas` / `mach` / `mag_heading` /
`true_heading` / `roll` · `aircraft_nac_p` / `nac_v` / `nic` · `aircraft_sda` / `sil` /
`spi` · `aircraft_gva` · `aircraft_rc` · `aircraft_alt_geom` · `aircraft_oat` / `tat` ·
`aircraft_wd` / `ws` · `aircraft_track_rate` · `aircraft_nav_altitude_fms` /
`mcp` · `aircraft_nav_modes` `Array(Enum8)` · `aircraft_nav_qnh` ·
`aircraft_alert` · `aircraft_version` · `user` (MLAT user id) ·
`mercator_x`/`mercator_y` `UInt32` MATERIALIZED.

**Note the column naming differs from adsb.lol**: `altitude`/`ground_speed`/
`track_degrees`, **not** `alt_baro`/`gs`/`track`. An `alt_baro` query fails with
`Code: 47 ... Unknown expression identifier`.

### Licence — read this before redistributing

- **Repository/site code: CC BY-NC-SA 4.0** (verified from
  `https://raw.githubusercontent.com/ClickHouse/adsb.exposed/main/LICENSE`) —
  **NonCommercial + ShareAlike**.
- **The rows are a mix, and the mix is not uniform:**
  - **adsb.lol** rows → **ODbL v1.0**, "full historical data provided without
    restrictions". ODbL is the permissive one.
  - **airplanes.live** rows → "no reselling; no commercial use (except within this
    application) without an agreement; attribution required".
  - **ADS-B Exchange** rows → sample days only, best coverage, commercial licence.
- The site's own footer says: `data: © adsb.lol (ODbL v1.0), © airplanes.live,
  © adsbexchange.com`.
- ⚠️ **There is a `source` column — filter on it** (`adsb_icao`, `mlat`, …) if you need
  to stay on ODbL-only rows and drop the airplanes.live/ADSBX rows.

### Practical caveats

- Full-table scans time out (90 s on a recent window). Stick to `sample100`/`sample10`
  and always bound on `time`.
- `?user=website` returns `JSONEachRowWithProgress` by default — the progress block
  interleaves with rows; set `default_format=JSON` or use `FORMAT TSV`/`JSONEachRow`.
- The hostname says `clickhouse-staging.com` — it is the production endpoint for the
  site despite the name. Do not "fix" TLS.
- Sticky replicas exist at `https://{hash}.sticky.{host}` where hash = `cityHash64(user)`.
- The clickhouse.com public playground (`play.clickhouse.com/?user=play`) is also
  keyless but **no longer hosts the `adsb` database** — its databases are
  `blogs`, `coverage_ci`, `default`, `fts_benchmarks_ci`, `git_clickhouse`,
  `keeper_stress_tests`, `mgbench`, `system`. Use the endpoint above.

## 2. adsb.lol — confirmed keyless, ODbL

**Docs:** https://api.adsb.lol/docs · spec `https://api.adsb.lol/api/openapi.json`

Verified from the live spec: **18 paths, no `security` block on any of them.**
Keyless smoke test (`/v2/mil`, small endpoint):

```
GET https://api.adsb.lol/v2/mil   ->  200 application/json, 24486 bytes
{"ac":[…], "msg":"No error", "total":79, "now":…, "ctime":…, "ptime":…}
```

Aircraft fields: `hex,type,r,t,dbFlags,alt_baro,gs,true_heading,category,lat,lon,
nic,rc,seen_pos,version,nac_p`.

Paths: `/v2/point/{lat}/{lon}/{radius}` · `/v2/lat/{lat}/lon/{lon}/dist/{radius}` ·
`/v2/closest/…` · `/v2/hex/{icao}` · `/v2/icao/{icao}` · `/v2/callsign/{cs}` ·
`/v2/reg/{reg}` · `/v2/registration/{reg}` · `/v2/type/{type}` · `/v2/sqk/{squawk}` ·
`/v2/squawk/{squawk}` · `/v2/pia` · `/v2/mil` · `/v2/ladd`.

**Licence: ODbL v1.0** (verified `globe_history_2026/main/LICENSE-ODbL.txt`).

⚠️ Two instability notes: a browser `User-Agent` is required (non-browser UAs get
451), and the README states an API key is an announced **future** requirement for
feeders — treat as stable-for-research, not contractual.

## 3. AvioADSB — keyless anonymous tier, CC BY 4.0

**Website:** https://avioadsb.org/ · **Docs:** https://avioadsb.org/docs/api ·
**Spec:** https://avioadsb.org/v1/openapi.json · **Base:** `https://avioadsb.org/v1`

A drop-in **adsb.lol / readsb-compatible** API (same response shape plus `dst` nm
and `dir` degrees). This is the newest keyless option found and the only one whose
licence is plain CC BY.

**Verified keyless** — `GET /v1/stats` with zero auth headers returned HTTP 200:

```json
{"aircraft_live":19,"aircraft_with_position":18,"aircraft_mlat":0,
 "receivers_online":4,"receivers_total":11,"now":1791090621450}
```
```
x-avioadsb-tier: anonymous
x-license: CC-BY-4.0; personal and research use only
x-ratelimit-limit: 100
x-ratelimit-policy: 1;w=10, 100;w=86400
x-ratelimit-remaining: 99
```

Note the OpenAPI lists `security` on every path, but it is an **optional**
`apiKey` scheme — omitting the header yields the `anonymous` tier, not 401.

| Tier | Who | Rate | Quota | Radius |
|------|-----|------|-------|--------|
| Anonymous | no key | 1 req / 10 s | **100 / day** (UTC) | ≤ 100 nm |
| Contributor | key whose receiver fed in last 7 d | 1 req / s (burst 2) | 10 000 / month | ≤ 250 nm + `/v1/aircraft` |

Limits are counted **per network** (IPv4 `/24`, IPv6 `/64`), not per address.
`GET /v1/me` is free and does not count against quota.

⚠️ 100 requests/day anonymous is a *hard* cap and unsuitable for a 1 s globe
refresh — this is a research/on-demand source, not a firehose. Feed a receiver to
reach the contributor tier. Docs explicitly forbid scraping the live map instead of
using the API; violating it gets the network blocked.

## 4. GPSJAM — keyless static CSV, no API surface at all

**Website:** https://gpsjam.org/ (John Wiseman, since July 2022)

A GPS/GNSS-interference map derived from **aircraft reporting low nav-system
accuracy** — i.e. an ADS-B-derived OSINT product, not a position feed.

| URL | Response |
|-----|----------|
| `https://gpsjam.org/data/manifest.csv` | `date,suspect,num_bad_aircraft_hexes,source` — gzip CSV, **1692 rows**, 2022-02-14 → 2026-10-03 |
| `https://gpsjam.org/data/{YYYY-MM-DD}-h3_4.csv` | `hex,count_good_aircraft,count_bad_aircraft` — e.g. 2026-10-03 = 187 KB / 47 092 rows, H3 resolution-4 cells |

Verified both with no auth. **Must send `--compressed`** (curl) / `Accept-Encoding:
gzip` — the body is gzip even though `Content-Type: text/csv`, so naive parsing
yields binary garbage.

Data comes from **airplanes.live + ADS-B Exchange**. The site says today's data is
incomplete intraday and publishes a daily map.

**Licence: not stated** — no LICENSE file, no terms page. The site's stated model is
donation-funded ("If you would like to support my efforts… then donate"). Since the
inputs are partly airplanes.live ("no commercial use without an agreement") and
ADS-B Exchange (commercial), treat as **research-only, ask before redistribution**.
This is already how `apps/api/app/routes/mega_feeds.py:862` consumes it
(`GPSJAM_URL = "https://gpsjam.org/data/manifest.csv"`).

---

## Also checked, not keyless / dead

| Candidate | Finding |
|-----------|---------|
| **ADSBHub** (`adsbhub.org`) | Site is live and has a globe, but data access sits behind **login/register** (`/api/` → 404, `api.adsbhub.org` → NXDOMAIN). Not keyless, despite a Reddit thread claiming it's "free for commercial use". |
| **ClickHouse playground** (`play.clickhouse.com/?user=play`) | Keyless but the `adsb` database is **not** there any more. Dead as an adsb.exposed route. |
| **opendata.adsb.fi** | `…/api/v3/lat/51.47/lon/-0.45/dist/50` → **403 text/html** (Cloudflare challenge) from this egress. Documented 1 req/s in `alt-free-adsb-apis-2026-10-04.md`; reachable from other addresses. |
| **ADS-B One** (`api.adsb.one`) | Previously documented as dead (archived Apr 2026, merged into airplanes.live). |
| **airplanes.live** (`api.airplanes.live`) | 403 with a contact-address policy body from this egress; human-reviewed free key. Note it is a **source** for both adsb.exposed and gpsjam. |

## Recommendation for this project

1. **adsb.exposed ClickHouse** is the highest-value addition and nothing in the repo
   currently uses it. It is the only keyless source of *multi-year* ADS-B **history**
   queryable in SQL (32 B rows, 2022→live), and its `source` column lets you stay on
   ODbL-only rows if licence hygiene matters. Build it on `planes_mercator_sample10`,
   always `WHERE time > …`, always format explicitly.
2. **AvioADSB** is the cleanest licence (CC BY 4.0) and the best-documented anonymous
   tier, but 100 req/day anonymous makes it on-demand only. Worth an outreach/feed
   conversation like the existing airplanes.live one.
3. **adsb.lol** stays the primary live firehose; nothing found here displaces it.
4. **GPSJAM** is already integrated — the one fix is the gzip requirement.

### Re-measuring

```bash
EP="https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website"
curl --data-binary "SELECT count(),min(time),max(time) FROM planes_mercator_sample10 FORMAT TSV" "$EP"
curl --data-binary "DESCRIBE TABLE planes_mercator FORMAT TSV" "$EP"
curl --data-binary "SELECT source,count() FROM planes_mercator_sample10 WHERE time>now()-INTERVAL 1 DAY GROUP BY source FORMAT TSV" "$EP"

curl -sS -D - -o /dev/null https://avioadsb.org/v1/stats      # x-avioadsb-tier, x-ratelimit-*
curl -sS --compressed https://gpsjam.org/data/manifest.csv | tail -3
curl -sS -A "Mozilla/5.0" https://api.adsb.lol/v2/mil | head -c 200
```