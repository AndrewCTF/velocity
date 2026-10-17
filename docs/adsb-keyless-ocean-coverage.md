# Keyless ADS-B: provider ranking and the measured ocean-coverage ceiling

**Date:** 2026-10-03/04 · **Egress:** residential MY (`<egress-ip>`), NOT the
datacenter IP the older notes in this file were measured from — every number here
is a fresh probe from this box, and a couple of hosts answer differently than
they did from the old egress.

**Constraint (operator, standing):** no provider may require an API key or a
metered credit budget. OpenSky's `/states/all` spends a 400-credit/day anonymous
per-IP pool, so it is **not eligible** as a provider, and no probe in this work
called it (doing so would burn the pool the running app's own tier shares).

Every number below was produced by a tool in this repo, re-runnable:

| tool                           | what it answers                                                               |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `tools/adsb_ocean_probe.py`    | which hosts answer, how many aircraft, ocean split, per-basin counts          |
| `tools/adsb_union_analysis.py` | union vs each host, and **marginal** contribution (is a host a mirror?)       |
| `tools/adsb_cadence.py`        | real update rate under a given poll interval, and throttle behaviour          |
| `tools/adsb_candidates.py`     | score an arbitrary candidate-URL list; rejects key-gated/HTML/throttled hosts |
| `tools/adsb_config_impact.py`  | what `ADSB_SIDECAR_ONLY` does to the feed set and the aircraft count          |

The land/ocean classifier is `ne_110m_land` (Natural Earth) parsed with a plain
ray-cast — no shapely in the API venv. It was validated against 12 known control
points (London, Sahara, Tokyo, Amazon, Antarctica, mid-Pacific, mid-Atlantic,
Singapore, …) before any of these numbers were believed: **12/12 correct.**

---

## 1. Which host is best

Measured 2026-10-03, one request each, browser UA, no credentials:

| host                                         | HTTP    | aircraft    | ocean  | deep-ocean | median fix age | notes                                                    |
| -------------------------------------------- | ------- | ----------- | ------ | ---------- | -------------- | -------------------------------------------------------- |
| `api.adsb.lol/v2/point/0/0/20000`            | 200     | ~11.7–12.1k | ~1.49k | ~60        | **0.27 s**     | biggest; **24–27 s to serve**; intermittent **HTTP 420** |
| `globe.theairtraffic.com/data/aircraft.json` | 200     | ~10.4–11.6k | ~1.26k | ~55        | ~0.95 s        | clean 5/5 at 25 s                                        |
| `skylink.hpradar.com/data/aircraft.json`     | 200     | ~9.5–10.6k  | ~1.23k | ~48        | **0.33 s**     | **clean 8/8 at 5 s** — best-behaved                      |
| `opendata.adsb.fi/api/v2/snapshot`           | **403** | —           | —      | —          | —              | per-path WAF from this egress                            |
| `api.airplanes.live/v2/point/…`              | **403** | —           | —      | —          | —              | app-level ban (see `apps/api/CLAUDE.md`)                 |
| `api.adsb.one/v2/point/…`                    | **403** | —           | —      | —          | —              | blocked here                                             |

**Recommendation: `adsb.lol` as the breadth primary, `hpradar` as the fast
freshness source.** The two are complementary rather than redundant, but the
cadence has to be asymmetric — see §3.

### The three are near-mirrors, not independent networks

`adsb_union_analysis.py` dedups by ICAO24 and measures **marginal** contribution —
aircraft a host has that _no other host_ has:

| host                   | total      | marginal  | ocean-marginal |
| ---------------------- | ---------- | --------- | -------------- |
| `adsb.lol`             | 12,099     | **1,262** | **166**        |
| `tar1090-globe`        | 10,634     | 115       | 7              |
| `hpradar`              | 9,706      | 45        | 9              |
| **union of all three** | **12,272** |           |                |

Union of all three is **+1.4 %** over `adsb.lol` alone. So running all three costs
3× the upstream load of a community service for ~170 aircraft — worth it only as
_failover_, not as three simultaneous tiers. Research independently confirmed the
cause from source: `adsb.lol` is itself a tar1090 running as a full aggregator
(`--net-ingest` + BeastReduce), i.e. a **superset** of the single-instance
mirrors. `hpradar` is 8 ground stations in Hai Phong, Vietnam (confirmed on
`hpradar.com`, which enumerates ADS-B #01–#04 and AIS #01–#04, all Hai Phong).

**Sharpened 2026-10-04 — the "8 stations" line explained the wrong thing.** Those
8 stations are not why the feed is a mirror. `hpradar.com` also documents that
every ADS-B station runs several feeder dockers at once — station #1 is listed as
"readsb-protobuf, **fr24, radarbox, flightaware and tar1090** docker images" — and
the AIS stations feed **MT, FM, VT, VF** (MarineTraffic, FleetMon, VesselFinder)
via AIS-catcher. So `skylink.hpradar.com` is a Vietnamese-*operated node
re-publishing other people's global aggregators*, which is the real and much
stronger reason its marginal contribution is only 45 aircraft / 9 ocean. The 8
stations explain where the hardware sits, not why the data duplicates adsb.lol.
Evidence: `docs/keyless-own-network-feeds-2026-10-04.md` §4b.

### Every "hidden gem" failed

22 candidate URLs from a 30-subagent research fan-out were measured. **All the
new ones are dead**, and this is worth recording so nobody re-runs the search:

- `adsb.330k.info`, `tar1090.adsb.im`, `radar.fdy.cz` → DNS/ConnectError
- `api.2.adsb.lol`, `ops-manager.adsb.lol` → self-signed cert
- `hpradar.com` (root) → HTML page, not JSON
- `api.adsb.fi/v2/point/…` → 404; `opendata.adsb.fi/v2/point/…` → 400
- `www.adsbexchange.com/api/aircraft/json` → 200 but not JSON; every one of its 27
  endpoints carries `"security":[{"X-Api-Key":[]}]`, community API is $10/mo

Three research premises were **fabrications** and were caught by measurement, not
argument: "Spacedys" (actually SpaceDyS, an asteroid-dynamics company), "MauriGram"
and "radartar1090" (NXDOMAIN + no Wayback snapshot), `afr321` (an Air France
flight number, not ADSBHub), and `adsbhub vol4/table.json` (404s; never existed).

---

## 2. Ocean coverage: the ceiling is physics, not scraping

This is the part that decides how anyone should talk about this feature.

ADS-B is **line-of-sight**. A transponder is heard by receivers within roughly
**150–250 NM**. Mid-ocean sits 1,000+ NM from any coast. No scraper creates a
receiver.

**All eight deliberately-empty ocean basins returned ZERO aircraft, on every host
that answered — 40 counts, all zero:**

N Atlantic (mid) · S Atlantic · N Pacific (mid) · Mid Pacific (equat) ·
S Pacific · Indian Ocean (S) · **Southern Ocean** · **Arctic Ocean**

The boxes were chosen _off_ the great-circle tracks on purpose, since a
transoceanic corridor is the one ocean place a coast-based network reliably hears.
The basin logic was re-run offline against synthetic positions to prove it returns
1 for each ocean box and 0 for Frankfurt/Atlanta/Tokyo, so the zeros are real.

So what _is_ the ~1,470 "ocean" aircraft each host reports? Measured distribution
of `adsb.lol`'s 1,466:

- **1,406 within 2.5–5° of land** (150–300 NM — exactly receiver range)
- **only ~60 more than 5° from land**, clustered at **Hawaii** (~21 N, 158 W),
  **Puerto Rico** (~20 N, 67 W), and the **North Atlantic**

Those 60 are real live fixes (median age **0.33 s**, not stale ghosts) and they
exist for a physical reason: dense island receiver clusters, plus HF skip
propagation, which carries a signal far past line-of-sight.

**Independent corroboration.** Research measured 17,054 MLAT stations from
ADS-B Exchange's keyless `mlat-map` and found **zero** MLAT feeders in the
mid-Pacific, South Pacific, Southern Ocean and the Falklands/Tristan da Cunha/
Socotra zone. Since MLAT needs 4+ receivers, aircraft seen there are
single-receiver unverified fixes. And the repo's own regional sweep found Hormuz
getting ~25 % fewer updates than CONUS with a **9× staler** p90
(`seen_pos_s` 106 s vs 12 s).

**Conclusion: do not claim global ocean coverage.** The honest claim is
"ocean-adjacent contacts a volunteer receiver network genuinely produces, plus
the island/HF clusters." Anything stronger is false for every keyless feed that
exists. Genuine remote-ocean coverage is a **proprietary satellite** product
(Aireon: ADS-B receivers hosted on **66** of the Iridium NEXT satellites — per
Aireon's own site, not the full 75 — covering the NAT since 2019) or an **ADS-C**
ground program (ADS-B Exchange publishes a full build spec
for C-Band dish receivers aimed at Inmarsat, explicitly naming Antarctica as the
gap; <50 stations worldwide). Neither is keyless.

---

## 3. Update rate: measured, not documented

Every feed's README claims "1 second". The observable behaviour is what matters,
so `adsb_cadence.py` polls a host N times and reports how many aircraft actually
changed.

| host            | interval | result                                   | median fix age | churn/poll |
| --------------- | -------- | ---------------------------------------- | -------------- | ---------- |
| `hpradar`       | 5 s × 8  | **8/8 clean, no throttle**               | 0.32 s         | ~175       |
| `tar1090-globe` | 25 s × 5 | **5/5 clean**                            | ~1.0 s         | ~560       |
| `adsb.lol`      | 25 s × 5 | **3/5 — two HTTP 420**                   | 0.24 s         | —          |
| `adsb.lol`      | 60 s × 4 | **3/4 — one HTTP 420**, and a 27 s fetch | 0.27 s         | —          |

Two things fall out of this, and both are load-bearing:

1. **`adsb.lol` answers HTTP 420, not 429**, when the planet snapshot is requested
   again too soon — and it takes **24–27 s** to compute. Polling it on a hot path
   spends the fan-out budget to earn a throttle. It wants a long interval and a
   hard cache. (The repo already does this: `adsb_feed_slow_interval_s = 20.0` vs
   `adsb_feed_interval_s = 3.0` for the mirrors.)
2. **`hpradar` is the one that tolerates a fast tick** — 8/8 clean at 5 s. It is
   the smaller dataset but the best-behaved, which makes it the freshness source
   and `adsb.lol` the breadth source.

One self-inflicted lesson: an early soak of mine (40 samples × 3 hosts, 120 s
apart) tripped a 429 on `adsb.lol`. Measuring a free community service harder than
it wants to be polled gets you throttled — and a throttle looks exactly like a
dead provider.

---

## 4. What the pipeline already does (and the one real gap)

**There is already a mature ADS-B pipeline here.** `apps/api/app/routes/adsb.py`
is ~3,150 lines with a sticky snapshot, a pre-rendered gzipped world blob, a
`/ws/adsb` push transport, per-feed background pull tasks, ETag/304 handling and
freshest-observation-wins merging. And `ADSB_FEED_URLS` **already lists all three
keyless hosts**:

```
https://globe.theairtraffic.com/data/aircraft.json,
https://skylink.hpradar.com/data/aircraft.json,
https://api.adsb.lol/v2/point/0/0/20000
```

So the correct answer to "build me a pipeline" was **not** to write a new tier. An
earlier draft of this work built one and it was a duplicate of `_readsb_feeds()`
with fewer protections; it was deleted rather than merged.

### The real gap: `ADSB_SIDECAR_ONLY=1` suppresses the keyless tier

`.env` sets `ADSB_SIDECAR_ONLY=1`, which makes `_feed_urls()` **drop every remote
keyless mirror** and keep only `http://127.0.0.1:8090/aircraft.json` — the local
tar1090 sidecar. That is the right call on a CPU-starved box with a healthy
sidecar. But on this deployment **the sidecar is not listening** (:8090 refused),
so the whole keyless breadth tier is being deferred to something that isn't there.

Measured with `tools/adsb_config_impact.py`:

| config                                | feeds                    | keyless union       | ocean | deep-ocean |
| ------------------------------------- | ------------------------ | ------------------- | ----- | ---------- |
| `ADSB_SIDECAR_ONLY=1` (as configured) | sidecar only             | 15,461              | 2,940 | 401        |
| `ADSB_SIDECAR_ONLY=0`                 | + theairtraffic, hpradar | **17,255** (+1,794) | 2,986 | 402        |

Note the deep-ocean column barely moves — **more hosts buys aircraft, not
ocean.** That is §2 showing up in production numbers.

**Fix: start the sidecar, or turn the flag off.** No code change is warranted, and
adding a provider would not help.

### Keyless-only floor (the operator's constraint, verified)

With **every** credit-metered and key-gated source disabled — `OPENSKY_ENABLED=0`,
`adsb_fr24_enabled=false`, `adsb_opensky_gaps_enabled=false`, no sidecar — the
three keyless hosts still deliver:

**11,895 aircraft** (1,462 ocean, 64 deep-ocean)

comfortably above the repo's `≥8 000` invariant. **The keyless constraint is
satisfiable today with no code change at all.**

---

## 5. Re-measuring

```bash
# which hosts answer, and with what ocean split
python tools/adsb_ocean_probe.py

# is a host a mirror? (union vs marginal contribution)
python tools/adsb_union_analysis.py

# real update rate + throttle behaviour
python tools/adsb_cadence.py --polls 5 --interval 25
python tools/adsb_cadence.py --polls 8 --interval 5 --only hpradar

# score an arbitrary candidate list (rejects key-gated / HTML / throttled)
python tools/adsb_candidates.py --candidates tools/adsb_candidates_research.txt

# what ADSB_SIDECAR_ONLY costs
python tools/adsb_config_impact.py      # run from apps/api/
```

Run these from the deployment you actually care about. Every host verdict in this
document is egress-specific, and this repo has been bitten by that before (see
the airplanes.live 403 and the `tar1090.de` NXDOMAIN entry in this file's history).
