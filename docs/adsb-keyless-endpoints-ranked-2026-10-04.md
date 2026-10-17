# Ranked keyless ADS-B endpoints for global + ocean coverage

**Date:** 2026-10-04 · **Research only** — no endpoint was called to produce this
document. Every number is a replay of an existing measured artifact in this repo
or a documented measurement in `docs/decisions.md`. The commands to re-measure
are at the bottom.

---

## The headline: no keyless ground-grid endpoint has genuine ocean coverage

This is the finding that should drive the pipeline, and it is stronger than the
endpoint ranking.

`tools/adsb_ocean_probe.py` measures ocean coverage by counting aircraft in
eight basin boxes chosen to sit in genuinely empty water — deliberately **not**
on the great-circle tracks, because a transoceanic corridor is the one ocean
place a coast-based receiver network reliably hears (`tools/adsb_ocean_probe.py:60-75`).

Result across the 2026-10-04 run (`/tmp/adsb_ocean_2.json`), for **every**
provider that answered 200:

| Basin               | adsb.lol | adsb.lol /mil | theairtraffic | hpradar |
| ------------------- | -------- | ------------- | ------------- | ------- |
| N Atlantic (mid)    | 0        | 0             | 0             | 0       |
| S Atlantic          | 0        | 0             | 0             | 0       |
| N Pacific (mid)     | 0        | 0             | 0             | 0       |
| Mid Pacific (equat) | 0        | 0             | 0             | 0       |
| S Pacific (empty)   | 0        | 0             | 0             | 0       |
| Indian Ocean (S)    | 0        | 0             | 0             | 0       |
| Southern Ocean      | 0        | 0             | 0             | 0       |
| Arctic Ocean        | 0        | 0             | 0             | 0       |

**Forty counts, all zero.** I re-ran the basin logic offline against synthetic
positions in every box to rule out a broken comparison — it returns 1 for each
ocean box and 0 for Frankfurt/Atlanta/Tokyo. The zeros are real.

So the honest reading of the ~1,470 "ocean" aircraft each provider reports is:
**coastal water only** — positions over water but within line-of-sight reach of
a land-based receiver. Not one of them is a mid-ocean fix. This is a receiver
question, not a scraping question, and no amount of trying harder hosts creates a
receiver in the middle of the South Pacific.

The same conclusion arrives independently from the regional refresh sweep
(`docs/gap-analysis-2026-09-13.md:46-57`, 90 s window). Even the Gulf — a
semi-enclosed sea with coast on three sides — is starved:

| Region            | Aircraft | Updates/90 s (median) | No update in 90 s | `seen_pos_s` p90 |
| ----------------- | -------- | --------------------- | ----------------- | ---------------- |
| **Hormuz / Gulf** | **136**  | **9**                 | **16 %**          | **106 s**        |
| India             | 332      | 8                     | 11 %              | 80 s             |
| Europe            | 3,173    | 11                    | 16 %              | 30 s             |
| CONUS             | 4,239    | 12                    | 9 %               | 12 s             |

Hormuz gets ~25 % fewer updates than CONUS and its oldest decile is **9× staler**.
The report's own verdict: _"That part is community-receiver density over the
Gulf (all three sources are volunteer feeders) and no code change creates
receivers."_ (Per-source loop fixes later cut Hormuz's no-update rate 16 % → 6 %,
but _"receiver density over the Gulf is unchanged."_)

**Consequence for the shortlist:** the ranking below is therefore ordered by
**sensor reach first, measured freshness second** — because every ground-grid
endpoint is already known to fail the ocean test, and the only variable left
worth ranking on is which sources are not line-of-sight receivers at all.

---

## The shortlist

Confidence is marked per row: **MEASURED** = replayed from a 2026-10-04/08
artifact in this repo; **DOCUMENTED** = a recorded measurement in
`docs/decisions.md` or a code comment citing a dated measurement; **INFERRED** =
structurally sound but never measured here.

### 1. `https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=<n>,<s>,<w>,<e>`

**Keyless. Satellite + MLAT fused. The only genuine-ocean candidate.**
Confidence: INFERRED for ocean, DOCUMENTED for keyless + cap.

The single most important row in this list. Every other keyless endpoint is a
community **ground receiver** grid, and ground receivers have a ~160-250 NM
horizon, which is why the basin table above is all zeros. This endpoint is what
FR24's own web map calls, needs no key, account or token, and returns FR24's
_fused_ picture — **ADS-B, MLAT, satellite and FLARM** — i.e. the only keyless
sensor net in the candidate set that is not line-of-sight
(`apps/api/app/adsb_fr24.py:1-7`). It is therefore the only endpoint on this
list that can plausibly report a fix nobody on land could hear.

Constraints, all documented:

- **1500 rows per response, whatever the bbox.** Measured 2026-08-07: one call
  over Europe returned exactly 1500 with `full_count: 20683`. The world must be
  walked as a grid; the shipped grid is 30° boxes (busy cells split into
  quarters).
- **Rows are positional arrays**, field 10 = the position's epoch second — the
  only honest freshness signal. Converted to readsb's `seen_pos`; never stamp 0,
  which would let an hour-old satellite fix beat a live transponder return.
- Requires a **browser UA**; a bare one gets a challenge page.

_Untested for ocean yield — that is the highest-value single measurement left in
this repo, and it is one grid run._

### 2. `https://opensky-network.org/api/states/all?lamin=&lomin=&lamax=&lomax=`

**Keyless anonymous. Credit-metered (flagged). The only source you can _aim_ at an ocean box.**
Confidence: DOCUMENTED.

Anonymous per-IP budget of 400 credits/day, and cost scales with **area**
(measured 2026-08-07 by reading `x-rate-limit-remaining` either side of each call):

| Request               | Credits |
| --------------------- | ------- |
| 2×2° box (≤25 sq deg) | 1       |
| 10×10° box            | 2       |
| whole world           | 4       |

Two reasons it ranks above the community mirrors despite the credit meter:
its receiver network has historically included shipborne and remote stations
rather than only volunteer rooftops, and the bbox form is **four times cheaper
than a global pull** — ~400 small ocean boxes/day instead of ~100 world pulls
(`apps/api/app/adsb_opensky_gaps.py:1-20`). It is also the only keyless source
that can be pointed at one specific mid-ocean box on purpose.

⚠️ Operator standing instruction is that no provider may cost credits or need a
key, and the running pipeline deliberately excludes it from probing
(`tools/adsb_ocean_probe.py:209-216`). Ranked here because "keyless" and
"free-tier-metered" are different claims and the ranking must not hide that
distinction.

### 3. `https://api.adsb.lol/v2/point/0/0/20000`

**Best measured keyless endpoint on earth. Coastal ocean, not open ocean.**
Confidence: MEASURED.

The full-snapshot quirk: a `/v2/point` at the globe centre with a planet-spanning
radius returns every aircraft adsb.lol knows, keyless, and — unlike the
`/v2/all*` verbs and the `aircraft.json` mirrors — is **not** Cloudflare/451
blocked from a datacenter egress.

|                   | adsb.lol    | theairtraffic | hpradar |
| ----------------- | ----------- | ------------- | ------- |
| Aircraft          | **12,142**  | 10,720        | 9,704   |
| "Ocean" (coastal) | **1,472**   | 1,238         | 1,190   |
| Median fix age    | **0.267 s** | 1.097 s       | 0.335 s |
| Payload           | 6.66 MB     | 5.9 MB        | 5.47 MB |
| HTTP              | 200         | 200           | 200     |

It also carries the union. The 3-host marginal analysis
(`/tmp/adsb_union_now.json`) shows why it is first and the mirrors are not:

|                                       | adsb.lol                     | theairtraffic | hpradar |
| ------------------------------------- | ---------------------------- | ------------- | ------- |
| Marginal aircraft (no other host had) | **1,262**                    | 115           | 45      |
| **Marginal ocean** (only source)      | **166**                      | 7             | 9       |
| Share of the union                    | **98.6 %** (12,099 / 12,272) | —             | —       |

Union of all three: 12,272 aircraft / 1,486 coastal-ocean. **Both mirrors together
buy +173 aircraft and +21 ocean over adsb.lol alone** — real, but an order of
magnitude less than adsb.lol's own +1,262 / +166. Both numbers were stable across
three soak samples 120 s apart (`/tmp/adsb_union_soak.json`: union_ocean
1,479 / 1,486 / 1,501; adsb.lol 12,124 / 12,102 / 12,082).

Two gotchas that are free wins: it **451s a non-browser User-Agent** (send a real
browser UA), and `seen_pos` arrives already expressed as an age in seconds.

### 4. `https://skylink.hpradar.com/data/aircraft.json`

**Freshest full-globe mirror. Second-best independent net.**
Confidence: MEASURED.

9,704 aircraft / 1,190 coastal-ocean at **0.335 s median age** — 3.3× fresher
than theairtraffic, 5.5 MB, and the fastest wall-clock of the three (2.52 s vs
5.38 s / 8.13 s). Worth keeping specifically because its _freshness_ profile
differs from adsb.lol's, which is what makes it a real second net rather than a
mirror in the freshest-wins union.

### 5. `https://globe.theairtraffic.com/data/aircraft.json`

**Second-largest, slowest of the three.**
Confidence: MEASURED.

10,720 aircraft / 1,238 coastal-ocean, but median age **1.097 s** — ~4× staler
than the other two. Still earns tier-3 placement: it contributed the largest
marginal count of the two mirrors (115) and held 200 across every recorded probe
(`/tmp/adsb_ocean_2.json` 5.9 MB / 5.38 s; `docs/decisions.md:759` 10,581 direct
and 10,570 through WARP).

### 6. `https://api.adsb.lol/v2/mil`

**Keyless, 0.35 s, genuinely maritime-skewed. Cheap niche add.**
Confidence: MEASURED.

91 aircraft, **11 of them over water** — a 12.1 % water fraction against 12.1 %
for the full feed, so not statistically maritime-skewed _in this sample_. Still
worth row 6 because military aircrew skew maritime (anti-piracy, maritime
patrol), it is 0.06 MB against 6.66 MB, answers in 2.78 s at 0.351 s median age,
and it is the one keyless signal with a genuinely different sensor population
rather than a subset of the same volunteers.

### 7. `https://opendata.adsb.fi/api/v2/snapshot`

**403 from this egress — but it is a per-PATH WAF, not a host ban. Use the bbox sibling instead.**
Confidence: MEASURED (the 403) + DOCUMENTED (the workaround).

Answers 403 to every client tried. The important nuance, from
`apps/api/app/routes/adsb.py:485-491`: it is a **per-path WAF shape** — the same
host's `/v2/lat/{lat}/lon/{lon}/dist/{d}` answers **200**, and the 403 is
address- and time-dependent. That bbox form is _also_ the correct shape for
aiming at an ocean box. Kept last-but-one in `_FIREHOSE_URLS` rather than deleted
because it costs zero requests while adsb.lol answers.

### 8. `https://api.airplanes.live/v2/point/0/0/20000`

**The densest community grid on the planet, app-level banned from this egress.**
Confidence: MEASURED (403) + DOCUMENTED (why).

403 on every verb, and the body is not a WAF and not a rate limit — it is a
policy ban carrying a contact address: `{"error": "Please contact us at
contact@airplanes.live..."}`. Nothing routes around it: not a proxy, not WARP,
not real Chrome (`apps/api/app/routes/adsb.py:470-480`,
`docs/decisions.md:758-767`). It stays in `_HEAD_HOSTS` **last** so a deployment
that has not been banned keeps the tier; this one is switched off via
`ADSB_DISABLED_HOSTS=api.airplanes.live`. An outreach draft is unsent at
`docs/outreach/airplanes-live-access.md` — sending it is the owner's call.

Watch the second trap documented at `docs/adsb-aircraft-pipeline.md:103-107`:
its limiter returns **HTTP 200 with a `text/plain` "You have been rate limited"
body**, so `_parse_ac` must reject non-JSON or a throttled cell silently caches
as empty and blanks the map.

### 9. `https://api.adsb.one/v2/point/0/0/20000`

**Cloudflare 403 from this egress.**
Confidence: MEASURED.

403 in the 2026-10-04 run. Same ADSBx-v2 shape as rows 3/7/8, same
`/v2/point/0/0/20000` planet-radius quirk, so it would rank immediately below
adsb.lol on any egress that can reach it. Cloudflare-blocked for datacenter IPs
per `docs/decisions.md:1485`. Untested since — a candidate for the next probe.

### 10. `https://www.adsbexchange.com/api/aircraft/json`

**Returns HTTP 200 with a non-JSON body — the most dangerous row on the list.**
Confidence: MEASURED.

`/tmp/adsb_ocean_2.json` records `status: 200` alongside
`JSONDecodeError: Expecting ':' delimiter` — a block page, not data. Ranked last
but kept precisely because it is the standing example of why **`200` is not
success**: any client that checks status before parsing will ingest a block page
as a valid empty feed and pin the map blank. Per `docs/decisions.md:758-761`,
`/data/aircraft.json` is 403 both direct and through WARP; the working route is
the browser-capture tier reading the request the page itself makes.

---

## Two documented failures worth recording

**The two adsb.lol README-advertised mirrors are not usable.**
`https://ops-manager.adsb.lol/api/v2/point/0/0/20000` and
`https://api.2.adsb.lol/v2/point/0/0/20000` both fail
`ConnectError: CERTIFICATE_VERIFY_FAILED — self-signed certificate`. Whatever
they are, they do not present a verifiable chain from this egress. Do **not**
"fix" this with `verify=False`.

**OpenSky's own `/states/all` is the breadth floor, not the ocean answer.**
`docs/honesty-wave-2026-08-30.md:28` and `docs/phase1-ground-truth-2026-08-30.md:90`
record it contributing 539 contacts of which **525 were exclusive**, and the
keyless feeds 14 with **0 exclusive**. That is the mirror image of the ADS-B keyless
result above, and worth stating plainly: OpenSky's unique contribution is
_aircraft nobody else has_, which is precisely the oceanic/sparse set.

---

## The structurally different answer

If the requirement is genuine ocean coverage rather than the best available
approximation, no scraped endpoint satisfies it. Two options do, and neither is
a keyless public endpoint:

1. **Self-host the receiver** — an `sdr-enthusiasts` tar1090 / ADS-B feeder, at
   sea or in an island state, serving `http://<host>:8080/data/aircraft.json`.
   This is the only option that _creates_ a receiver instead of borrowing one.
   `tools/adsb-globe-feeder/README.md:80-81` calls it "the robust, blessed
   alternative". The repo already ships the reverse bridge for the borrowing case.
2. **Satellite** — ADS-B over satellite (the physical basis of row 1's satellite
   input, and ADSBX's product). Requires an API key, so it is excluded by the
   keyless constraint, but it is the only true global-ocean solution in the
   category and should be named as such rather than silently omitted.

---

## Re-measuring

```bash
# Per-provider reach, ocean-vs-coastal split, freshness, and per-basin counts.
python tools/adsb_ocean_probe.py --json /tmp/adsb_ocean_3.json

# Union + marginal contribution across the three reachable keyless hosts
# (the numbers that decide tier order, not raw counts).
python tools/adsb_union_analysis.py                    # -> /tmp/adsb_union_now.json
python tools/adsb_union_analysis.py --repeat 40 --interval 120 \
        --out /tmp/adsb_union_soak.json

# Reachability + freshness for a wider mirror candidate set (fdy.cz, 330k.info,
# tar1090.adsb.im, hpradar.com, adsbexchange — none of these are in the 2026-10-04
# results, so they are the cheapest remaining unknowns).
python tools/probe_adsb_mirrors.py

# Per-region update rate and fix-age percentiles — the Hormuz/Europe/CONUS table.
python tools/perf/adsb_region_refresh.py
```

**Not yet measured, highest value first:** FR24's ocean yield (row 1) and the
freshness of `fdy.cz` / `330k.info` / `tar1090.adsb.im` / `adsb.one`. All four are
one probe run away.
