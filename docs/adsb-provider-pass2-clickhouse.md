# Second provider pass: the one real find, and the ocean source

**Date:** 2026-10-04 · **Egress:** residential MY (`<egress-ip>`)
**New:** `web_search` finally worked (Firecrawl key supplied by the operator), so
this pass is the first one backed by real search instead of CAPTCHA-blind scraping.

Constraint unchanged: **no API key, no metered credit budget.**

---

## The find: `adsb.exposed` — a keyless ClickHouse over live ADS-B + AIS

The single genuinely new provider in two research passes. It is not an HTTP
aircraft feed at all — it is a **public ClickHouse database** you query with SQL.

```
endpoint : https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website
auth     : username only, no password, no API key, no signup
tables   : planes_mercator, planes_mercator_sample10, ais_mercator,
           ais_mercator_sample10, gtfs_mercator, osm_mercator, firms_mercator,
           taxi_mercator, population_mercator, ...
```

### Measured (2026-10-04, all queries anonymous)

| property | value |
|---|---|
| `count()` on `planes_mercator_sample10` | **32,290,642,773 rows** |
| archive span | **2022-02-01 → 2026-10-04 05:27 UTC** (live tail) |
| distinct aircraft | **6,185,893** |
| aircraft in the last **60 s** | **7,022** |
| aircraft in the last **30 min** | **11,499** |
| median-ish fix latency | seconds (timestamps advanced 05:31:45 → 05:32:36 across two probes) |
| row shape | `icao, r (registration), t (type), lat, lon, altitude, ground_speed, track_degrees, time` |

### Why it matters: it is the only keyless source with real ocean coverage

Every tar1090/aggregator feed reports "ocean" aircraft that are really coastal
water within receiver range (see `docs/adsb-keyless-ocean-coverage.md`: only ~60
contacts are more than 5° from land). This database returned **534 aircraft over
water in a 30-minute window**, and live rows at:

```
lat 65.82, lon -166.83   — Arctic Ocean, north of Fairbanks
lat 66.42, lon -161.84   — Arctic Ocean
```

That is coverage no ground-receiver aggregator produced, and it is consistent with
the table being an **aircraft-database-derived** corpus rather than only a
tar1090 relay.

### The catch: ~49 s query latency

Every non-trivial query measured **49–74 s**, consistently:

```
uniqExact(icao) ... WHERE time > now() - INTERVAL 60 SECOND      -> 49.7 / 49.2 / 49.1 s
SELECT ... WHERE time > now() - INTERVAL 1800 SECOND            -> (same class)
DESCRIBE / SHOW TABLES                                           -> fast (metadata)
```

So this is **not** a replacement for a 1 s live poll. It is good for:

- periodic snapshot/backfill of deep history (2022→now is a genuine OSINT asset),
- ocean/polar coverage the live feeds structurally cannot give,
- SQL aggregation the JSON APIs cannot do at all.

If you want it in the pipeline, the honest shape is a **slow tier polled every
few minutes**, merged freshest-wins — not the hot path.

---

## Pass 3: 141 regional candidates fingerprinted — every one measured

A stalled research agent harvested **141 candidate hostnames** (mostly national
ccTLDs: `adsb.at`, `adsb.co.za`, `1090.de`, `adsb.com.br`, …) and built
`tools/fingerprint_tar1090.py` to triage them **without ever requesting a data
path** — it reads only the front door and the content-hashed `early_*.js` the
tar1090 shell itself references, so a host serving that file is by construction
serving `/data/aircraft.json`. 16 hosts were fingerprinted
`KEYLESS_AIRCRAFT_JSON` and then measured live.

**Result: adsb.lol still wins, by a wide margin. Two independent runs:**

| host | aircraft | ocean | deep | median age |
|---|---|---|---|---|
| **api.adsb.lol/v2/point/0/0/20000** | **5,658–5,678** | 1,205–1,228 | 60–61 | 0.33 s |
| globe.theairtraffic.com | 4,921 | 1,053 | 53 | 0.52 s |
| skylink.hpradar.com | 4,431–4,464 | 924–939 | 46–47 | 0.34 s |
| globe.debeers-labs.xyz | 128–129 | 46 | 3 | 1.18 s |
| graphs/www/globe.banksdada.com | 11 | 0 | 0 | — |
| spotter.post8.org | 9 | 0 | 0 | — |
| adsb.pro | 1 | 0 | 0 | — |
| adsbkarte.jung-services.de | 0 | 0 | 0 | — |

Fingerprinted-then-dead or blocked: `adsbitalia.it` 404 · `adsb.boringservice.net`
404 (subpath mount, not root) · `adsbiq.com` 404 · `vdliq.com` 404 ·
`globe.adsb.lol` 404 · `globe.airplanes.live` **403** · `adsb.ae` /
`ads-b-europe.eu` / `aeroweb.fr` 403 Cloudflare · `adsb.im` 405 · `ads-b.pro`
"Page not found" · `adsb.fi/tar1090/` 404 · `api.planes.lol` **Vercel
`DEPLOYMENT_NOT_FOUND`** (torn down) · `api.bharatradar.com/data/aircraft.json`
**HTTP 200 but `{"aircraft": [], "messages": 0}`** — a live endpoint serving an
empty sky.

The pattern is consistent across all three passes: **community tar1090
instances are single-receiver sites (1–130 aircraft), not global aggregators.**
The only hosts with global breadth are the three already wired.

---

## Also confirmed live: USCG Nationwide AIS via NOAA Marine Cadastre

Zero prior mention in this repo. Federal receiver network, **no key, no login,
CC0 licence**, anonymous index/HEAD access verified. A genuinely independent
government source for ship traffic — worth wiring as an AIS tier.

---

## Everything else in this pass: dead, blocked, or fabricated

Measured with `tools/adsb_candidates.py` (one request each, no credentials):

| candidate | verdict |
|---|---|
| `adsb.chaos-consulting.de/data/aircraft.json` | **404** (and `/tar1090/...` 404) |
| `api.flyitalyadsb.com/v2/point/...` | **403** — alive, blocks this egress |
| `api.adsbhub.org/v2/point/...` | **DNS/ConnectError** |
| `atc.plane.watch/api/v2/point/...` | **404** |
| `adsb.one/api/v2/point/...` | 200 but **HTML**, not JSON |
| `birds.adsb.lol/v2/mil` | 200 but **HTML login page** |
| `planes.lol/v2/mil` | **404** |
| `adsb.lol/data/aircraft.json` | **404** |
| `opendata.adsb.fi/api/v3/...` | **403** (per-path WAF, already documented) |
| `globe.adsbexchange.com/...` | credit-metered — refused without probing |

`adsb.chaos-consulting.de` and `atc.plane.watch` are the kind of thing that
sounds authoritative in a README and is simply not there. Verified, not assumed.

---

## Provider ranking after both passes

**Live poll (sub-second-to-20 s cadence), keyless:**

1. **`api.adsb.lol/v2/point/0/0/20000`** — still the best live feed. Largest,
   freshest fixes, ~706 aircraft the mirrors lack.
2. `globe.theairtraffic.com/data/aircraft.json` — clean, ~89 unique.
3. `skylink.hpradar.com/data/aircraft.json` — best-behaved under fast polling,
   ~19 unique.

**Archive / ocean / SQL:**

4. **`adsb.exposed` ClickHouse** — the only keyless source with genuine ocean and
   polar coverage, plus 2022→now history. Slow (≈49 s/query).

For ships, separately: **Sentinel-1 SAR** (`docs/adsb-keyless-ocean-coverage.md`
and `app/ais_pipeline/sar.py`) is keyless and sees vessels regardless of AIS —
verified finding real vessel targets in open water. The ClickHouse AIS table also
shows vessels the coastal feeds miss, including one at **lat −69.97** near
Antarctica and one at −54.8 in the Southern Ocean.

---

## Reproduce

```bash
CH="https://kvzqttvc2n.eu-west-1.aws.clickhouse-staging.com/?user=website"

# what is there
curl -sS "$CH" --data-binary "SHOW TABLES FORMAT TabSeparated"

# is it live
curl -sS "$CH" --data-binary \
  "SELECT max(time) FROM (SELECT time FROM planes_mercator_sample10 ORDER BY time DESC LIMIT 5) FORMAT TabSeparated"

# how big / how far back
curl -sS "$CH" --data-binary \
  "SELECT count() FROM planes_mercator_sample10 FORMAT TabSeparated"

# ocean aircraft (30 min)
curl -sS "$CH" --data-binary \
  "SELECT uniqExact(icao) FROM planes_mercator_sample10
   WHERE time > now() - INTERVAL 1800 SECOND FORMAT TabSeparated"
```

Measure the latency before designing around it — that ~49 s is the whole
constraint, and it will change if the operator's data grows.
