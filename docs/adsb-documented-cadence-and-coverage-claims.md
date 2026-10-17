# Documented update rate + coverage claims of keyless ADS-B sources

**Date:** 2026-10-04 · **Method:** documentation review only — vendor READMEs,
OpenAPI specs, official doc sites and GitHub source. **No aircraft-data endpoint
was called.** Every cadence number below is quoted from a vendor's own words, or
marked `UNPUBLISHED`.

**Why this doc exists:** `docs/adsb-keyless-ocean-coverage.md` §3 *measures* the
cadence and §2 *measures* ocean reach. Neither quotes what the vendors actually
**claim**. Those are different questions, and the gap between them is where an
overclaim would come from. Short answer up front:

> **Not one keyless source documents an update rate AND claims oceanic coverage.
> Only two document any cadence at all. Every "global"/"worldwide" claim in the
> keyless set means "worldwide network of land receivers", not "worldwide
> airspace". The single explicit oceanic claim belongs to Aireon, which is
> proprietary and not keyless.**

---

## 1. Documented cadence, per source

| source | documented update rate | documented rate limit | where it says it |
| --- | --- | --- | --- |
| **readsb / tar1090** (the mirror software behind `globe.theairtraffic.com`, `skylink.hpradar.com`, `radar.fdy.cz`, …) | **`--write-json-every=<sec>` — "Write json output and update API json every sec seconds (default 1)"** | n/a — your own instance | `wiedehopf/readsb` README, options list |
| **adsb.fi** open data | `/v2/snapshot` — **"Returns all aircraft refreshed twice a minute"** (= 30 s). **This is the only cadence figure adsb.fi publishes, and the endpoint is feeder-only.** | public **1 req/s**; feeder **1 req/30 s**; 400/401/403/404/429 all count; abuse earns a temporary IP restriction | `adsbfi/opendata` README |
| **OpenSky Network** | **time resolution 10 s** anonymous (`now - (now mod 10)`); **5 s** authenticated. Historical ≤1 h authenticated. `/flights/*` + arrivals/departures are a **nightly batch → previous day or earlier only**. | **credit-metered**, see §3 | `openskynetwork/opensky-api` `docs/free/rest.rst`, "Limitations" |
| **ADS-B Exchange** | **500 ms** on the homepage, **250 ms** on `/api/` — **their own two pages disagree by 2×**. Daily product: 24 h. | Enterprise is a subscription with **minimum annual commitments**; Community API needs an account | `adsbexchange.com` homepage vs `/api/` |
| **adsb.lol** | **UNPUBLISHED.** Zero occurrences of `refresh`, `update`, `second`, `interval`, `cache` in the whole OpenAPI spec (v0.0.2). The docs page "Open Data → API" is four lines of prose: *"The API is available to everyone."* | *"Rate limits are dynamic based on the environment load. If you get 4xx errors, you are doing something wrong."* — **no numbers** | `adsblol/api` README + `adsblol/website` `content/en/docs/open-data/api.md` |
| **theairtraffic.com**, **hpradar.com** | **UNPUBLISHED — no API documentation exists.** | none published | — |

**So: of six sources, two publish a cadence. One publishes a *resolution* and a
price (OpenSky). One publishes two contradictory numbers (ADS-B Exchange). Two
publish nothing at all (adsb.lol, the tar1090 community mirrors).**

### Supporting detail already in the repo

- `apps/api/app/config.py` comments the 1 s basis correctly: *"Full readsb
  aircraft.json MIRRORS are CDN-ish files refreshed ~1 s (tar1090 itself polls
  them ~1 s)"* — that traces straight back to readsb's documented default 1.
- Measured fix ages line up with it: `globe.theairtraffic.com` median age
  **0.95–1.03 s**, i.e. one upstream write interval old. So the 1 s doc is the
  one documented number that survived measurement.
- Other documented readsb/tar1090 intervals, for completeness: `--heatmap 30`
  (globe history bucket), `--json-trace-interval 0.1` (max resolution),
  tar1090 track-history `INTERVAL=20`, `?pTracks` default 15, `--net-heartbeat 60`,
  `--net-connector-delay 15`.

### Three corrections this surfaced

1. **Aireon is 66 satellites, not 75.** Aireon's own site: *"Powered by Iridium's
   networked constellation of **66 satellites**."* 75 is the full Iridium NEXT
   constellation; Aireon hosts on a subset. Both this repo's
   `adsb-keyless-ocean-coverage.md` and the `adsb-ocean-coverage-measurement`
   skill say 75 — fix them before a claim goes in front of an operator.
2. **`/v2/point/0/0/20000` is 80× outside adsb.lol's documented contract.** The
   adsb.lol OpenAPI spec puts `radius` on `/v2/point` and `/v2/closest` at
   **`maximum: 250`** NM. The repo's `ADSB_FEED_URLS` third entry uses radius
   **20000**. The "planet-radius firehose" is therefore an undocumented abuse of
   a lookup endpoint, not a supported interface — it is exactly the sort of thing
   that becomes a 420 or a 404 without notice, and it should be described that
   way rather than as a documented global endpoint.
3. **adsb.fi has no public global endpoint at all**, which matches the measured
   failures exactly: `opendata.adsb.fi/api/v2/snapshot` → 403 (feeder-gated),
   `api.adsb.fi/v2/point/...` → 404 (not in the spec), `opendata.adsb.fi/v2/point/...`
   → 400. The documented public surface is **lookups only** — hex / icao /
   callsign / registration / squawk / mil, plus `/v3/lat/lon/dist` capped at
   250 NM. Getting global coverage from adsb.fi keyless would mean ~200+ tiled
   lookups inside the 1 req/s budget.

---

## 2. Coverage claims — what each source actually asserts

| source | verbatim claim | oceanic? | verifiable? |
| --- | --- | --- | --- |
| **Aireon** | *"continuous air traffic surveillance to areas of the world that previously had no access to this information, **including over oceans, polar regions**, mountainous regions, jungles, deserts, and conflicted airspace"*; *"global, gate-to-gate, surface-to-space"* | **YES — the only explicit oceanic claim found** | Yes: satellite-hosted, so physically capable. **Not keyless** — proprietary, sold to ANSPs/airlines |
| **ADS-B Exchange** | *"over 25,000 receivers"*; *"A global, independent flight data network"*; *"the world's largest independent ADS-B receiver network"*; *"global aircraft activity"* (~10 repetitions) | **No ocean mention anywhere** | "Global" is unqualified marketing. 25k *ground* receivers cannot cover mid-ocean; the repo measured **deep-ocean 0** in all 8 basins |
| **adsb.fi** | *"over 6500 feeders around the world"*; *"open and unfiltered access to worldwide air traffic data"* | **No ocean mention** | "Worldwide" = feeder footprint. Consistent with the 0-deep-ocean measurement |
| **adsb.lol** | *"aggregates data from volunteer feeders **around the world**"* | **No ocean mention** | Same reading |
| **OpenSky Network** | *"air traffic control sensor network with **worldwide coverage**"*; *"openly support global"* | **No ocean mention** | Strongest genuine remote reach of the open set, because it is largely **ADS-C** ground stations — the one ground technology that does work over water. Still sparse in the S Pacific. Region-by-region reach is **not** documented and must be measured |
| **theairtraffic.com**, **hpradar** | **No coverage claim published at all.** No API docs, no stats prose, no cadence. (`/stats` is JS-rendered; `hpradar.com` root returns 522 / HTML) | — | Nothing claimed ⇒ nothing to verify |
| **MLAT** (adsb.lol's own `mlat-server`) | — | Cannot help, by design | **"Results get passed back to the clients that contributed to the positions."** MLAT fixes go only to the contributing receiver cluster, never to the public API — and MLAT needs **≥4 receivers** (hpradar's own page). So MLAT cannot manufacture ocean coverage |

### The precise negative finding

**No keyless, no-API-key, no-credit-metered ADS-B source claims oceanic coverage,
and none could deliver it.** Every one of them says "global" or "worldwide" in a
sense that means *our receivers are spread across many countries* — a claim about
the **network**, not the **airspace**. The only source that claims oceans is
Aireon, and it is the only one with satellites.

So the safe sentence is: *"ocean-adjacent contacts a volunteer receiver network
genuinely produces, plus island/HF-skip clusters"* — which is what
`adsb-keyless-ocean-coverage.md` §2 already concludes. **Do not use the word
"global" or "worldwide" about coverage without saying whose network you mean.**

---

## 3. Eligibility ledger (for the "no key, no metered credits" constraint)

| source | keyless? | metered? | eligible |
| --- | --- | --- | --- |
| readsb/tar1090 mirrors | yes | no | **yes** |
| adsb.lol | yes today | no published limit, **dynamic + undocumented** | **yes, with a caveat** — undocumented dynamic limits are why it 420s; treat as long-interval + hard cache |
| adsb.fi public | yes | **1 req/s**, non-commercial only | **yes** for tiled lookups only; **no** global endpoint |
| adsb.fi `/v2/snapshot` | **feeder-IP only** | 1 req/30 s | **no** (403 measured) |
| ADS-B Exchange | **no** — `X-Api-Key` on all 27 endpoints; community API is a paid account | yes | **no** |
| OpenSky `/states/all` | anonymous works, but **OAuth2 client-credentials required since 2026-03-18** | **yes — 400 credits/day anonymous** | **no** |
| Aireon | no | yes | **no** |

**OpenSky's arithmetic, so nobody re-derives it:** `/states/all` costs **4
credits** for a `> 400 sq°` or global box. Anonymous budget is **400 credits/day**.
⇒ **100 global pulls/day = one global pull every ~864 s (~14.4 min)** — and zero
credits left for anything else. Authenticated raises it to 4,000/day (standard)
or 8,000/day (active feeder); licensed is 14,400/**hourly**. `429` plus
`X-Rate-Limit-Retry-After-Seconds` when exhausted. `/states/own` is free and
unlimited but only for receivers you operate.

---

## 4. Why documented ≠ real (three worked examples)

1. **ADS-B Exchange disagrees with itself** — 500 ms on the homepage, 250 ms on
   `/api/`. You cannot cite a documented rate from a vendor that publishes two.
2. **adsb.lol documents no rate at all**, yet it is the one host that **throttles**
   (HTTP **420**, not 429) and takes **24–27 s** to serve the planet snapshot. The
   throttle is undiscoverable from documentation — only from measurement.
3. **readsb's 1 s is a *write* interval, not a *freshness* guarantee.** The file is
   rewritten every second whether or not new positions arrived; the repo's own
   `tools/adsb_cadence.py` header says the effective append rate is **5–15 s**, and
   the Hormuz sweep measured a p90 fix age of **106 s** against CONUS's 12 s. A
   documented 1 s write cadence told you nothing about the 106 s.

That third point is the general rule: **documentation describes the file, not the
data.** Only `adsb_cadence.py` describes the data.

---

## 5. Sources consulted (all read 2026-10-04)

- `adsbfi/opendata` README — <https://raw.githubusercontent.com/adsbfi/opendata/master/README.md>
- `adsblol/api` README + `openapi.json` — local copies in `research/adsb-lol/`
- `adsblol/website` `content/en/docs/open-data/api.md`, `.../overview/introduction.md`
- `adsblol/mlat-server` README — <https://raw.githubusercontent.com/adsblol/mlat-server/master/README.md>
- `wiedehopf/readsb` README (+ `README-json.md`) — <https://raw.githubusercontent.com/wiedehopf/readsb/master/README.md>
- `wiedehopf/tar1090` README — <https://raw.githubusercontent.com/wiedehopf/tar1090/master/README.md>
- `openskynetwork/opensky-api` `docs/free/rest.rst` — <https://raw.githubusercontent.com/openskynetwork/opensky-api/master/docs/free/rest.rst>
- <https://www.adsb.fi/>, <https://opensky-network.org/about/>, <https://www.aireon.com/>
- <https://www.adsbexchange.com/>, `/api/`, `/api/community/`
- <https://theairtraffic.com/>, `/stats`, `/how-to-feed`; <https://skylink.hpradar.com/>

**Tooling note:** `web_search` / `web_extract` (Firecrawl) were rate-limited
throughout this session — a shared per-minute quota consumed by parallel siblings
(`Remaining (req/min): 0`). All fetches above were done with `curl` against
documentation and marketing URLs instead. This is the same fallback
`spacedys-adsb-research.md` §"Tooling notes" records.

## 6. What would still be worth measuring (research-only gaps left)

- Whether **OpenSky's** own reach differs by ocean basin — it is the one open
  source with a real ADS-C footprint, so it is the only candidate where a
  non-zero mid-ocean box is physically plausible. Requires spending credits, so
  it needs operator sign-off before probing.
- Region-by-region ADS-B Exchange coverage (they publish no map) — blocked behind
  a paid key.
- **hpradar**'s real footprint: the repo says 8 stations in Hai Phong, Vietnam.
  Unconfirmed from any vendor source, because hpradar publishes no docs.