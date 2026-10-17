# Open-access ADS-B for NAT / North Pacific oceanic routes

**Research date:** 2026-10-03 · **Scope:** documentation review + status-code
verification only. No ADS-B data endpoints were called (per task instruction).

---

## TL;DR — the honest answer

**No genuinely open, keyless, high-coverage ADS-B feed covers mid-ocean NAT or
North Pacific tracks.** That is a physics and economics result, not a scraping
failure:

- **ADS-B is line-of-sight.** A transponder is heard only within roughly
  **160–250 NM** of a receiver. Mid-ocean sits 1,000+ NM from the nearest coast,
  so _terrestrial_ feeder networks structurally cannot cover it.
- The system that _does_ cover it — **Aireon** (ADS-B receivers hosted on the 75
  Iridium NEXT satellites) — went operational over the NAT on **27 March 2019**
  and is **proprietary, sold to ANSPs/airlines, not open access**.
- What _is_ open gives you **corridor-edge coverage only**: the tracks' oceanic
  entry/exit points, not the middle.

Prior measurements in this repo (`/tmp/adsb_union_soak.json`,
`/tmp/adsb_ocean_2.json`, from `tools/adsb_union_analysis.py`) confirm this
precisely: three keyless aggregators report ~**1,200–1,500 "ocean" aircraft
each** (water within 150 NM of a coast) but **exactly 0 aircraft** in every
deep-ocean test box. The mid-ocean counts are the coast-halo, not the ocean.

---

## Tier 1 — Open, keyless, but ocean-limited (usable for corridor edges)

| Source                            | Access                                                                                                                        | Endpoint                                                                  | Ocean value                                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **adsb.fi** open data             | Open, **no key**, ADSBexchange-v2-compatible, 1 req/s                                                                         | `https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}` (≤250 NM) | Best-documented open feed. Verified **HTTP 200** at 60N/-30 and 60N/-40 (on the NAT corridor). ~6,500 community feeders. Full `/v2/snapshot` is **feeder-only (403 from here)**. Terms: **personal, non-commercial only**; must cite adsb.fi. |
| **adsb.lol**                      | Open, no key, dynamic rate limit                                                                                              | `https://api.adsb.lol/v2/point/0/0/20000` (~12k aircraft)                 | Measured **best single tier** _and_ best marginal contributor (**~1,250 marginal**, **~165 ocean-marginal**) — i.e. genuinely adds aircraft no other open host had. README: an API key "in the future… in return for feeding."                |
| **airplanes.live**                | Open, no key                                                                                                                  | `https://api.airplanes.live/v2/point/...`                                 | **403 from this egress**; mirrors via `adsb.lol`/`adsb.one` reachable.                                                                                                                                                                        |
| **tar1090 / globe.theairtraffic** | Open, no key                                                                                                                  | `https://globe.theairtraffic.com/data/aircraft.json`                      | ~10.7k aircraft, ~1.2k ocean. But **marginal ≈ 100–120 total / 5–11 ocean** → effectively a **mirror** of adsb.lol, not extra coverage. Use as fallback, not primary.                                                                         |
| **skylink.hpradar**               | Open, no key                                                                                                                  | `https://skylink.hpradar.com/data/aircraft.json`                          | ~9.7k aircraft, ~1.2k ocean, **marginal ≈ 27–36 total / 4–7 ocean** → same story. Fallback tier.                                                                                                                                              |
| **OpenSky `/states/all`**         | Anonymous allowed (reduced limits) but **credit-metered** (~400 credits/day anon); OAuth2 client-credentials since 2026-03-18 | `https://opensky-network.org/api/states/all`                              | Global breadth ~13k. The only open tier with _some_ genuinely oceanic aircraft — but oceanic positions degrade first once the daily pool is spent, and the repo's standing rule is no credit-spend.                                           |

**The union finding that matters:** union of the three open mirrors =
**~12,300 aircraft / ~1,485 ocean**, versus best single (adsb.lol) **12,124 /
1,464** — a **+1.5% total, +1.5% ocean** gain. Because the mirrors are
mirrors, fanning out across all three buys almost nothing over adsb.lol alone.
_Recommendation: adsb.lol primary, one mirror fallback._

---

## Tier 2 — Genuinely oceanic, but NOT open access

| Source                                             | Why it covers ocean                                                                                                                                                                                                                                                                                                         | Access reality                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Aireon** (Iridium wholly-owned since 2026-07-02) | ADS-B receivers on all 75 Iridium NEXT sats, ~450 nmi altitude. Activated by **NATS + Nav Canada over the NAT 2019-03-27**; now used for **North Pacific Tracks, South Atlantic, Indian Ocean**, African upper airspace. Enabled ICAO **ASEPS** reduced separation (40 nmi → 14–17 nmi longitudinal). ~190,000 flights/day. | **Proprietary.** Sells to ANSPs and airlines (via **FlightAware AeroVue**). Not open, no public API. |
| **Spire Global / AirSafe**                         | ADS-B payloads on 100+ Lemur-2 CubeSats                                                                                                                                                                                                                                                                                     | **Commercial.** Not continuous; explicitly _not_ certified as primary ATC surveillance.              |
| **Thales–Spire–ESSP "Eurialo"**                    | 100+ sat constellation, GNSS-independent RF timing                                                                                                                                                                                                                                                                          | ESA-funded €16M, service **targeted 2027**. Not available.                                           |

**Conclusion: there is no open proxy for Aireon.** Any claim of "global open
oceanic ADS-B coverage" should be treated as false.

---

## Tier 3 — Open _archive_ of oceanic traffic (research, not realtime)

Not live tracking, but genuinely open and ocean-inclusive:

- **OpenSky Trino historical DB** — free **full dataset** via SQL (Trino +
  MinIO). **Eligibility-gated**: university-affiliated researchers, government,
  aviation authorities. **Private/commercial must license** — not open to this
  project as-is. Bucket structure confirmed: `flights/`, `flightsV5/`,
  `states/`, `raw/`, `trino-tables/`, `incident-data/`, `metadata/`,
  `publication-data/`.
- **OpenSky Scientific Datasets** — published samples incl. **the OpenSky
  ADS-C dataset** (ADS-C is the _other_ oceanic satellite channel, via
  Inmarsat — the natural open stand-in for ADS-B oceanic), plus LocaRDS, weekly
  24h state vectors, aircraft metadata. Sample flight Parquet/CSV schema
  includes full `track` arrays of lat/lon/alt → usable to reconstruct historical
  NAT crossings.
- Bucket is public-read at `https://s3.opensky-network.org/data-samples`.

---

## How to actually see traffic on the NAT / North Pacific tracks

1. **Get the track geometry** (open): NAT-OTS is published twice daily by
   **Shanwick (EGGX)** and **Gander (CZQX)** via NOTAM — reference **ICAO NAT
   Doc 007**. PACOTS via the FAA/NOTAM route. Westbound tracks (11:30–19:00 UTC
   at 30W) = letters **A–M** omitting I; eastbound (01:00–08:00 UTC at 30W) =
   **Z–N** omitting O. Route level **FL340–FL400**.
2. **Overlay open ADS-B point queries** along that corridor: tile
   `opendata.adsb.fi/api/v3/lat/…/dist/250` along the track lat/lon line,
   rate-limited 1 req/s, and filter to FL340–400. This reliably catches aircraft
   **near the oceanic entry/exit points and coastal approaches** — which is most
   of what any open source can honestly see.
3. **Join to OpenSky's ADS-C dataset** if you need _mid-ocean_ positions
   historically. That is the only open channel that genuinely crosses the ocean.
4. **Do not** claim live mid-ocean coverage from adsb.lol/tar1090/hpradar — the
   numbers above show it is coast-halo, not ocean.

---

## Per-repo implications

- Existing pipeline (`docs/adsb-aircraft-pipeline.md`) is already correct on
  this: OpenSky is the breadth tier and its **oceanic contacts degrade first**
  when the daily credit pool is spent, while the grid keeps dense regions live.
- `tools/adsb_union_analysis.py` produced the union/marginal evidence above and
  should stay the instrument for this question. `tools/adsb_ocean_probe.py`
  already encodes the correct honest metric — **basin counts + fix age**, not
  raw totals, so "ghost" extrapolated positions can't be mistaken for coverage.
- Worth adding to the repo's honesty docs: the reason open ocean coverage is
  absent is **structural (no receivers, receiver horizon ~250 NM)** and the
  real fix is **satellite-based**, not another aggregator.

---

## Verification log (status codes, this egress)

| URL                                                                                            | Result                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `opendata.adsb.fi/api/v2/lat/60/lon/-30/dist/250`                                              | **200**                                   |
| `opendata.adsb.fi/api/v2/lat/60/lon/-40/dist/250`                                              | **200**                                   |
| `opendata.adsb.fi/api/v2/snapshot`                                                             | 403 (feeder-only)                         |
| `api.adsb.lol/v2/point/0/0/20000`                                                              | 200 (per repo soak)                       |
| `www.adsb.fi/`, `www.adsb.fi/api/`                                                             | 200 (docs readable)                       |
| `opensky-network.org/data/`, `/datasets/`                                                      | 200                                       |
| `s3.opensky-network.org/data-samples`                                                          | 200 (bucket listing OK)                   |
| `globe.theairtraffic.com/data/aircraft.json`                                                   | 200 (per repo soak)                       |
| `skylink.hpradar.com/data/aircraft.json`                                                       | 200 (per repo soak)                       |
| `api.airplanes.live/v2/point/0/0/20000`                                                        | 403                                       |
| `api.adsb.one/v2/point/0/0/20000`                                                              | 403                                       |
| `ops-manager.adsb.lol`, `api.2.adsb.lol`                                                       | TLS self-signed cert (unusable)           |
| `www.adsbexchange.com/api/aircraft/json`                                                       | 200 but non-JSON                          |
| icao.int NAT docs, ganderoc.ca, shanwickoceanic.com, flightaware.com/aeroe, airnavradarbox.com | 403 / DNS-fail (blocked from this egress) |

**Tooling note:** `web_search` is unconfigured in this environment (needs
`FIRECRAWL_API_KEY`), and Google/Bing/DDG/Mojeek/searx.be all block this egress
with bot challenges. Findings above were obtained by direct HTTP against
primary sources plus the repo's existing probe data.
