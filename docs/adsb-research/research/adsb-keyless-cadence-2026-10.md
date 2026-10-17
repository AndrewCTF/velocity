# Fastest-updating keyless global ADS-B source — actual push/poll cadence

**Date:** 2026-10-04
**Scope:** Research only. No ADS-B data endpoint was called; all cadence numbers below come
from upstream source code + official documentation, cross-checked against this repo's own
recorded live measurements (`docs/decisions.md`).

---

## TL;DR — the answer

**The fastest-updating keyless global ADS-B source is an open `tar1090`/`readsb` aggregator
mirror serving `/data/aircraft.json`, polled at ~1 s. It is a 1 Hz poll of a file that the
server itself rewrites every 1 second — it is _not_ a push.**

No keyless global ADS-B source offers true server-push. There is no WebSocket in the
keyless global tier. Every global source is HTTP-poll. The difference between them is the
**poll floor**, and that floor is set by two independent things: (a) how often the server
regenerates the data, and (b) an explicit rate limit / credit budget.

| Source                                                        | Keyless?          | Transport | Actual cadence (verified)            | Enforced floor                          |
| ------------------------------------------------------------- | ----------------- | --------- | ------------------------------------ | --------------------------------------- |
| **tar1090/readsb aggregator `/data/aircraft.json`**           | Yes               | HTTP poll | **~1 s** (server rewrite)            | none documented; bytes-bound            |
| **ADSBx (`adsb.lol`/`airplanes.live`) `/v2/point/0/0/20000`** | Yes               | HTTP poll | ~1 s underlying, but budget-limited  | per-IP rate limit → this repo uses 20 s |
| **OpenSky `/states/all`**                                     | Yes (anonymous)   | HTTP poll | **10 s time resolution** (anonymous) | 400 credits/day; 10 s bucket            |
| OpenSky `/states/all` (authenticated)                         | Key required      | HTTP poll | 5 s time resolution                  | 4,000 credits/day                       |
| FR24 map backend                                              | No (ToS/headless) | HTTP poll | measured p50 4 s / p90 9 s           | n/a                                     |
| Aircraft live WebSocket push                                  | —                 | —         | **does not exist** keyless           | —                                       |

---

## 1. Winner: tar1090 / readsb aggregator — 1 Hz poll of a 1 Hz file

### Endpoints (keyless, no API key, no registration)

```
GET https://<aggregator>/data/aircraft.json          # ~12-18k aircraft, global
GET https://<aggregator>/data/aircraft.json.gz       # gzipped variant
GET https://<aggregator>/data/aircraft_extended.json # + extended fields
```

### Actual cadence — from source, not docs

readsb **3.16** source, `readsb.c:179`:

```c
Modes.json_interval = 1000;          // default: write JSON every 1000 ms
Modes.json_trace_interval = 20 * 1000;
```

`--write-json-every <sec>` help text (`help.h:113`) — _"Write json output and update API json
every sec seconds (**default 1**)"_. Floor enforced at `readsb.c:1870-1871`:

```c
Modes.json_interval = (int64_t) (1000.0 * atof(arg));
if (Modes.json_interval < 100)        // 0.1s
    Modes.json_interval = 100;
```

So the real range is **100 ms (operator-set minimum) to 1 s (stock default)**.

Upstream's own `README-json.md:15` states it plainly:

> _"The file versions are written periodically; for aircraft, typically once a second, for
> stats, once a minute."_

And `README-json.md:26` — the file carries its own refresh hint for consumers:

> _`refresh`: how often aircraft.json is updated (for the file version), in milliseconds. the
> webmap uses this to control its refresh interval._

### Two independent timers (this is the part people get wrong)

The JSON thread is **not** a naive sleep loop (`readsb.c:699`):

```c
// we should exit this wait early due to a cond_signal from api.c
threadTimedWait(&Threads.json, &ts, Modes.json_interval * 3);
```

- **File writer** (`/data/aircraft.json`) — writes every `Modes.json_interval`, i.e. **1 s default**.
- **API thread** (`api.c:1964-1970`) — computes its own phase-aligned sleep
  (`ival = Modes.json_interval; remaining = ival - (now % ival)`) so the _in-process API_
  cache is rebuilt on the same 1 s grid, and is likewise woken early by a cond_signal from
  `api.c` when an HTTP request arrives.

**Practical consequence:** an HTTP request to `/data/aircraft.json` is served from the file on
disk (the webserver reads `data/`), so **polling faster than 1 s returns byte-identical
cached data**. There is no benefit to sub-second polling against a stock mirror. Polling at
1 s is not merely allowed — it is the exact rate at which new bytes appear.

### Why this beats everything else

- `seen_pos` (seconds since last position fix, in `aircraft.json`) is measured by the
  _server_ against its own decode clock, so a healthy aggregator mirror reports **p50 well
  under 1 s** — i.e. data age is bounded by the 1 s rewrite, not by your poll rate.
- Coverage: a fed aggregator (e.g. `globe.theairtraffic.com`, `skylink.hpradar.com`) merges
  hundreds of upstream receivers via `--net-connector ... beast_in`, giving global reach
  ~10k-18k aircraft from a single keyless GET.
- Reads are unauthenticated and unmetered by any API credit system.

**Cost caveat:** `aircraft.json` bodies are several MB. At 1 s that's real bandwidth — this
repo's own `docs/decisions.md:1482-1483` chose **5-8 s** as the bandwidth balance for exactly
this reason. That's a local policy choice, not an upstream limit.

---

## 2. Runner-up: ADSBx (`adsb.lol` / `airplanes.live` / `adsb.fi`) — same 1 Hz data, metered

ADSBx is itself a tar1090 aggregator, so the underlying freshness is comparable (~1 s), but
it is fronted by a per-IP rate limiter. Endpoints:

```
GET https://api.adsb.lol/v2/point/{lat}/{lon}/{radius}     # radius in nm
GET https://api.airplanes.live/v2/point/{lat}/{lon}/{radius}
GET https://api.adsb.fi/v2/point/{lat}/{lon}/{radius}
```

The global-coverage quirk this repo relies on is `lat=0&lon=0&radius=20000`, which yields a
planet-radius snapshot (~11k-12.5k aircraft). Measured in this repo: **11,441 aircraft
(2026-08-21)**, later **12,561** after reordering the host list.

Two hard operational facts, both from this repo's decision log rather than marketing:

- **UA-gated:** `api.adsb.lol` answers **HTTP 451** to a non-browser User-Agent. A real
  browser UA is mandatory (`docs/decisions.md:1484-1485`).
- **Datacenter-IP gated:** `airplanes.live` / `adsb.fi` / `adsb.one` Cloudflare-block
  datacenter IPs — so "works on my laptop" does not imply "works in prod". From a DC egress
  `airplanes.live` answers **403 on every verb**, with a body asking the project to be
  emailed; that is a ban, not a challenge.
- **Rate-limit footgun:** over ~8 concurrent calls, `airplanes.live` throttles by returning
  **HTTP 200 with a `text/plain` body** — not a 429. A parser that trusts the status code
  silently ingests garbage. (Also `api.adsb.lol/v2/all-with-pos` → **404**, a verb that does
  not exist; egress-independent.)

Because of that metering, this repo polls ADSBx on a deliberately slow
`adsb_feed_slow_interval_s = 20.0` while polling the full mirrors on
`adsb_feed_interval_s = 3.0`.

---

## 3. OpenSky — the 10 s anonymous ceiling (officially documented)

Anonymous, keyless, but **hard-limited by design**. From the official REST docs
(`openskynetwork.github.io/opensky-api/rest.html`), "Limitations" and "API Credits":

**Anonymous users (unauthenticated, bucketed by IP):**

- Only the most recent state vectors; the `time` parameter is **ignored**.
- **Time resolution is 10 seconds**: `now - (now mod 10)`.

**Authenticated users:**

- State vectors up to 1 h in the past (`t < now - 3600` → 400).
- **Time resolution is 5 seconds**.

**Credit budget (three independent buckets, one each for `/states/*`, `/tracks/*`, `/flights/*`):**

| Tier                           | Credits | Refill |
| ------------------------------ | ------- | ------ |
| Anonymous                      | **400** | Daily  |
| Standard user                  | 4,000   | Daily  |
| Active feeder (≥30% uptime/mo) | 8,000   | Daily  |
| Licensed user                  | 14,400  | Hourly |

`/states/all` credit cost = **bounding-box area in sq°**:

| BBox area                     | Credits |
| ----------------------------- | ------- |
| ≤ 25 sq° or serial-only query | 1       |
| 25-100 sq°                    | 2       |
| 100-400 sq°                   | 3       |
| **> 400 sq° or global**       | **4**   |

Exhaustion → `429 Too Many Requests` + `X-Rate-Limit-Retry-After-Seconds`. Balance is visible
in `X-Rate-Limit-Remaining`. `/states/own` is free and unlimited but **requires auth** (403
otherwise), so it is not keyless.

**Hard arithmetic for the anonymous keyless tier:** a global query costs 4 credits → **100
global calls/day, i.e. one every ~14.4 minutes**, at a 10 s data resolution. Only
**1/864th of the 10 s buckets** are ever seen. This is the single most important reason
OpenSky is a _breadth_ source, never a _freshness_ source — and it matches this repo's
treatment of it: pulled once on boot, then once per UTC day, cached in between.

Also worth flagging for anyone tempted to scrape it: the OpenSky docs carry an explicit
instruction not to seek whitelisting for AI dashboards, and reserve the right to block
hyperscaler/AWS IPs. That is a policy decision, not a technical obstacle.

---

## 4. Push: what actually exists (and why nothing keyless-global qualifies)

- **OpenSky** publishes **no WebSocket** endpoint — a full-text scan of the official docs
  (index, rest, trino, python, java) returns **zero** occurrences of "websocket". REST +
  Trino only.
- **tar1090/readsb** is poll-only over HTTP for `/data/aircraft.json`. It _does_ have
  push-style outputs for **feeder-to-feeder** distribution, but they are raw decoder
  streams for your own infrastructure, not a query API:
  - TCP `beast_out` / `raw_out` / `sbs_out` / `vrs_out` / `json_out` / `asterix_out` on
    configurable ports (`--net-*-port`).
  - `--net-bo-port` (Beast out) defaults to **0 = off**. You must enable it, and it is a
    listener on _your_ box — a remote aggregator will not expose it to you.
  - `beast_reduce_out` interval default 250 ms; `net_output_vrs_interval` default **5 s**;
    `net_output_json_interval` default **0.0 (every position)**; TCP flush 50 ms /
    1280-byte buffer.
- The WebSocket in this repo's own architecture (`/ws/adsb`) is **downstream of the backend** —
  it pushes the fused snapshot to the browser at a ~1.0 s server-timed cycle. It is not an
  upstream ADS-B feed.

**Conclusion:** for a keyless _global_ ADS-B source, "push" is a non-existent option. ~1 Hz
HTTP polling of a tar1090/readsb mirror is the fastest available, and it is exactly matched
to the data's own refresh rate.

---

## 5. Recommendation for this repo

1. **Keep tar1090/readsb mirrors as the freshness primary.** ~1 s data age, no credits, no
   UA/IP gate on the open mirrors (`theairtraffic`, `hpradar`, `adsbexchange`) — those are
   the ones that work from a datacenter IP, unlike the ADSBx hosts.
2. **Keep `adsb_feed_interval_s = 3.0`** for those mirrors rather than 1.0. The file only
   changes every 1 s; 3 s costs the same bytes-per-freshness while cutting bandwidth ~3× on
   multi-MB bodies. Sub-second polling is pure waste against a stock mirror.
3. **Do not treat OpenSky as fresh.** It is a breadth/backfill tier on a 300 s grid
   (`adsb_opensky_gaps_interval_s`) funded by a 400-credit/day anonymous budget. One 2x2°
   cell = 1 credit → 288/day at 300 s, which fits with reserve. Never spend it on a
   global query from a 1 Hz loop.
4. **Prefer breadth-preserving fusion.** Freshest-observation-wins dedup by `icao24` across
   tiers is already correct; note that raw `seen_pos` is age-at-upstream-serve-time, so a
   cached tier reports itself as fresh forever — never compare it across tiers.
5. **If sub-second freshness is ever genuinely required**, the only honest route is running
   your **own** readsb/tar1090 fed from `--net-connector <host>,30003,beast_in` with
   `--write-json-every 0.1` (the 100 ms floor), or enabling `--net-bo-port` for a real TCP
   push. Both require your own receiver deployment — neither is available keyless from a
   third party.

---

## Provenance

| Claim                                                                    | Source                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `json_interval = 1000` default, 100 ms floor                             | readsb 3.16 `readsb.c:179`, `:1869-1871`                      |
| `--write-json-every` "(default 1)"                                       | readsb 3.16 `help.h:113`                                      |
| "written periodically; aircraft typically once a second"                 | readsb 3.16 `README-json.md:15`                               |
| `refresh` ms field in aircraft.json                                      | readsb 3.16 `README-json.md:26`                               |
| Writer wakes early on cond_signal; API thread phase-aligned to same grid | `readsb.c:699`, `api.c:1964-1970`                             |
| Beast/VRS/raw/SBS push ports + intervals                                 | readsb 3.16 `help.h:56,130,135-146`                           |
| OpenSky anonymous 10 s resolution, auth 5 s                              | `openskynetwork.github.io/opensky-api/rest.html` §Limitations |
| OpenSky 400 credits/day anon; global = 4 credits                         | same §API Credits                                             |
| OpenSky has **no** WebSocket endpoint                                    | full-text scan of all 5 official doc pages — 0 hits           |
| ADSBx 451-on-non-browser-UA; DC-IP 403s                                  | `docs/decisions.md:1484-1485`, `:192`, `:1160-1165`           |
| airplanes.live HTTP-200 + text/plain throttle                            | `docs/decisions.md:186-190`                                   |
| mirror freshness ~1.6 s median, ~10k aircraft                            | `docs/decisions.md:1481`                                      |
| readsb bodies multi-MB → 5-8 s chosen                                    | `docs/decisions.md:1482-1483`                                 |
| OpenSky pulled daily / cached, ~4 credits                                | `docs/decisions.md:180-183`                                   |

### Retrieval notes

`web_search`/`web_extract` were unavailable (no `FIRECRAWL_API_KEY` configured), and
`api.github.com` + `wcampbell03/*` raw paths were blocked/rate-limited from this egress.
OpenSky docs and `raw.githubusercontent.com/openskynetwork/opensky-api` were reachable
directly; readsb source was obtained as the official Debian/Ubuntu orig tarball
(`archive.ubuntu.com/ubuntu/pool/universe/r/readsb/readsb_3.16.orig.tar.gz`), which is the
same upstream tree, so the cadence constants are first-party — not inferred from docs.
