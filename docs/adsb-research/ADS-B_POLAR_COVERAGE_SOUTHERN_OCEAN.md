# ADS-B Coverage — Southern Ocean, Antarctica & Deep South Pacific

**Compiled:** 2026-10-04 · **Method:** direct fetches of primary sources (operator pages, docs, repos,
Wikipedia). **Research only — no data endpoints called, no feeds queried.**

## TL;DR / Bottom line

1. **No open feed genuinely covers Antarctica or the deep South Pacific.** Every free/open ADS-B
   aggregator is a _ground-receiver_ network, and Antarctica has effectively no population to host one.
   OpenSky, ADSB.lol, adsb.fi, ADSBiQ and ADS-B Exchange are all ground-based and all explicitly
   acknowledge the pole/ocean gap.
2. **The one project demonstrably and deliberately closing that exact gap is ADS-B Exchange's
   ADS-C ground-station program** — a full open build guide with a public intake endpoint. Antarctica is
   named in their gap statement. This is the highest-value find.
3. **Satellite-based ADS-B (Aireon / Iridium NEXT, 75 payloads) genuinely does provide global coverage
   including polar/oceanic** — but it is a commercial ANSP product, **not an open feed**.
4. **Only a handful of real, named ground receivers exist in Antarctica**, all at research stations with
   airfields (Troll is confirmed and documented). Coverage there is ~300 NM around a handful of points.
5. **OpenSky's ADS-C dataset** (Zenodo `10.5281/zenodo.15272131`, collected since 2023-07-07) is the best
   _existing open artifact_ touching the gap — worth pulling and spatially filtering.

---

## 1. ⭐ THE ANSWER: ADS-B Exchange ADS-C Receiver Program (open, building the gap now)

**URL:** https://www.adsbexchange.com/ads-c-receiver/

This is the strongest result: an open-source, fully-specified community project whose stated purpose is
to fill precisely the Southern Ocean / Antarctic / deep-Pacific void. Quoted verbatim from the page:

> "Reach Beyond the Horizon with ADS-C. The network built this map. You can finish it. ADS-B receivers
> already cover where people live. The oceans, the poles, the Amazon, the Sahara — those blank spots
> stay blank because reaching them is genuinely hard."

**Their explicit gap statement names Antarctica directly:**

> "**What goes dark** — Oceans, poles, and empty land. The **North Atlantic, the Pacific, Antarctica**,
> the Amazon basin, central Africa, the Sahara, Siberia. No ground receivers. Flights vanish from the
> map mid-track, sometimes for hours."

Page also states: **"<50 Stations worldwide"** and **"Orbit to track ±3.2°"** — i.e. a deliberately
sparse, targeted network aimed at exactly these voids.

### Why ADS-C and not ADS-B

ADS-B is line-of-sight. ADS-C (ICAO contract surveillance) is the standard the aircraft itself uses to
report position over satellite in oceanic/remote airspace — so it is the only medium that returns
flights from the Southern Ocean. Aircraft send it via **Inmarsat** (~3.6 GHz C-Band downlink, plus
L-Band), and anyone with a dish can receive it. This is the open analogue of what Aireon sells to ANSPs.

### Build spec (verbatim from page, useful if we ever stand one up)

- **Dish:** C-Band, **2.4 m minimum** (6–8 ft); bigger is better. Used C-Band TV dishes $100–300.
- **LNB:** **non-5G, external-reference** C-Band LNB (3.4–4.2 GHz) — _older Norsat model_. ⚠ Current
  models ship 5G filters that **silently block the ADS-C signal** and cannot be GPS-modified. This is
  called out as the make-or-break part. $50–200 used.
- **LNB lock:** GPSDO (e.g. Leo Bodnar), inject 10 MHz reference into the LNB. ~$110–150.
- **RF chain:** Mini-Circuits **ZABT-2R12G+** bias-T/diplexer (20 V + ref up the coax). ~$80–100.
- **Feed:** scalar ring + **dielectric** (sliver of bare PCB) to convert feed to **circular
  polarisation** — "the dielectric is critical to sensitivity."
- **SDR:** RTL-SDR Blog **V3** specifically (~$35).
- **Tracking:** feedback **linear actuator + Arduino H-bridge**, driven by **Node-RED** computing
  position from auto-updating **TLE** data; nudges every 10–15 min with deadband. **GEO satellites
  trace a slow figure-8 over 23h54m** — this is why tracking is mandatory.
- **Compute:** i5/i7, 8–16 GB RAM, SSD. **"A Raspberry Pi cannot keep up with C-Band."**
- **Est. cost:** **≈ $500–800** plus months of commissioning.
- **Frequencies to decode:** 10500 (primary/strong), 1200, 8400 (voice) → separate Jaero instances.
- **Decoder:** **JAERO** (`jontio/JAERO`, 274★) — handles 1200 and 10.5k C-Band, plus L-Band 600/1200.
- **Proof of concept:** "Seeing real aircraft appear over open ocean or remote land — positions no
  ADS-B receiver anywhere can see — is the proof of concept."

### Open intake — data lands in a public map/API

- **Endpoint:** `feed.adsbexchange.com` port **31600/tcp**, SBS output.
- **Option A (recommended):** local `readsb` relay —
  `--net-only --net-sbs-jaero-in-port=30003 --net-connector=feed.adsbexchange.com,31600,sbs_out_jaero`
- **Option B (simple):** Jaero client mode direct to the same endpoint.
- **Data is tagged `"type": "adsc"`**, distinct from `adsb`, and is **visible to everyone on the map and
  the API** (`gateway.adsbexchange.com/api/aircraft/v2/...`).

### Community build guides (linked by the page, real and detailed)

- **https://thebaldgeek.github.io/C-Band.html** — full C-Band ground station guide. Key warnings:
  dish size is the variable; smaller dishes typically decode only 10500 and people dismiss the weaker
  channels; _"you can start simple and just solve each issue"_; automation step _"could take many many
  months"_.
- **https://thebaldgeek.github.io/Inmarsat.html** — pick "your" satellite. **Inmarsat moved orbits in
  2018 and again late-2023/early-2024.** L-Band beam is broad and decodable at the edge; **C-Band is
  narrow and becomes very hard or impossible near coverage edges** — so satellite selection is the
  binding constraint for polar siting. Satellites also move **±3° latitude** and drift in longitude.

### Community / contact

- Discord (satcom channel, small community of working ADS-C feeders): https://discord.gg/ad8SSMpWvH
- Reddit: r/ADSBexchange · "For dedicated operators": they ask to be contacted pre-build and will help
  identify the right satellite for your location.

---

## 2. Satellite-based ADS-B — real global polar coverage, but NOT open

- **Aireon** (JV of Iridium + ANSPs) hosts Harris-built ADS-B payloads on **all 75 Iridium NEXT
  satellites**; operational service from **March 2019**. NATS + Nav Canada activated it over the
  **North Atlantic 27 March 2019** under ICAO **ASEPS** (reduced separation minima).
  Claimed effect: ~45,000 t CO₂/yr and ~£19M/yr airline fuel saved in UK-managed NAT by 2023.
- Extends ADS-B surveillance _"from the roughly 30% of the Earth's surface covered by terrestrial radar
  and ground ADS-B receivers to the entire globe, including the oceanic, polar and remote-continental
  airspace."_
- Also: ESA **Proba-V** (2013) first space reception of ADS-B (>25M aircraft positions by May 2015);
  **GomSpace / Aalborg University** CubeSats; **Spire Global** and **Thales–Spire–ESSP (Eurialo)** as
  other operators.
- **Sources:** https://en.wikipedia.org/wiki/Satellite-based_ADS-B ·
  https://en.wikipedia.org/wiki/Automatic_Dependent_Surveillance%E2%80%93Broadcast
- **Openness caveat:** Aireon is a commercial ANSP product — **not an open feed**. Its own data is
  licensed to paying ANSPs. This is the gap ADS-C community reception works around.

---

## 3. OpenSky Network — the best _existing open_ artifact, and it runs ADS-C

- **Site:** https://opensky-network.org/ · **Datasets:** https://opensky-network.org/datasets/ ·
  **FAQ:** https://opensky-network.org/about/faq · **Trino:** https://opensky-network.org/data/trino/
- Non-profit (Swiss) association; founded 2015 from a 2012 project (armasuisse, Univ. Kaiserslautern,
  Univ. Oxford). Volunteers + industry + academia feed sensors; **all raw data archived in a large
  historical database**.
- Claimed mission: _"completely open air traffic control sensor network with **worldwide coverage**."_
- **Key asset for polar work:** **ADS-C Air Traffic Data Collected by the OpenSky Network** —
  Zenodo **`10.5281/zenodo.15272131`**, published 2025-04-23, by Marc Xapelli, Martin Strohmeier,
  Tobias Lüscher. `adsc_decoded.txt` (846 MB) + `adsc_file_structure.md`,
  **continuously collected since 2023-07-07**. Paper: "A First Look at Exploiting the ADS-C Protocol for
  Open Aviation Research," _Journal of Open Aviation Science_ (2023), doi:10.59490/joas.2023.7229.
  → **This is the single best open dataset to spatially filter for Southern Ocean coverage.**
- Access friction: registered OAuth2 credentials required; historical access via Trino/bucket browser
  (Parquet) rather than the rate-limited REST `/states/all`.
- **Note:** I could not retrieve a `Network Coverage` page (the nav links to it but `/network-coverage/`
  and `/coverage/` both 404), so OpenSky's own _quantified_ polar coverage figure is unverified.

---

## 4. Confirmed ground receivers actually inside Antarctica

Antarctica's airfields are the only places a receiver can exist. Documented cases:

- **Troll Research Station** (Norwegian Polar Institute, **-72.011, 2.52**; runway 3000 m blue-ice,
  opened 2005) — **the best-documented case.**
  - Flightradar24 installed its **first Antarctic receiver** at end of Dec 2022; **first flight tracked
    13 Jan 2023**: Privatair **737 HB-JJA** (as `PTI737`), a resupply flight from Cape Town (~6 h south).
    URL: https://www.flightradar24.com/blog/flight-tracking-news/special-event/tracking-flights-with-our-first-receiver-in-antarctica/
  - Installed in the **NILU environmental monitoring / clean-air sampling station** at **4000 ft** —
    highest point at the station with power + internet. Internet via **Kongsberg** satellite (TrollSat).
  - **Stated coverage: ~300 NM.** Antarctica is a frozen desert → **static is a constant equipment
    risk**, mitigated only by site elevation.
  - Troll also has an airfield ops blog: https://www.flightradar24.com/blog/flight-tracking-news/special-event/troll-research-station-how-to-operate-an-airport-in-antarctica/
  - Runs summer-season resupply flights (Icelandair 767, Privatair 737); "potential to follow research
    flight activities in the area" — **i.e. low-altitude research/mission traffic is a real niche.**
- **McMurdo** — has a **Transponder Landing System (TLS)** enabling precision approaches; a 787 landing
  there was tracked (FR24 blog links both). Indicates more than bare ADS-B infrastructure.
- **DP0GVN** — amateur-radio station in Antarctica **equipped with an ADS-B receiver to relay
  aircraft tracking data** (seen via DD1US space-SAT blog cross-reference). Worth confirming.
- Other airfields that plausibly host receivers (not individually confirmed in this pass):
  Rothera/Neumayer, SANAE IV, Palmer, Mawson/Davis/Caseby, Scott Base, Zucchelli, Troll satellite base.

**Reality check:** even a perfect Antarctic installation is ~300 NM radius around a handful of points.
That is not coverage of the Southern Ocean — it is coverage of _the approach corridors to Antarctic
stations_. Nothing ground-based can cover the 20M km² between them.

---

## 5. Why ADS-B fundamentally cannot close the gap (the structural argument)

From the ADS-B Exchange gap page and general physics, stated crisply:

> "Ground receivers hear aircraft directly, so coverage ends where the earth curves — or where no one's
> run a receiver. Over oceans and in the great empty interiors of continents, aircraft go dark for
> hours."

This matches Wikipedia's ADS-B article: _"During a flight over areas without radar coverage, e.g.,
**oceanic and polar**, reports are periodically sent by the aircraft to the controlling air traffic
region"_ — but that is **ADS-A via ACARS**, a _controlled_ channel, not broadcast.

**Consequence for our collection:** the Southern Ocean must be covered by (a) satellite ADS-B
(closed/commercial — Aireon), (b) ADS-C over Inmarsat (open-receivable — ADS-B Exchange program,
OpenSky dataset), or (c) ADS-A/ATN via ACARS over VHF/satellite (weakly represented; the
**vdlIQ** mirror carries `ats_operational` VDL2 text which is the closest open proxy). Ground ADS-B
feeders — the entire open-feed ecosystem — are structurally excluded from the region.

---

## 6. Related open infrastructure worth knowing

| Source                       | Link                                                        | Polar relevance                                                                                  |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ADS-B Exchange ADS-C program | adsbexchange.com/ads-c-receiver/                            | ⭐ Direct attack on the gap; open intake, `type: adsc`                                           |
| JAERO decoder                | `github.com/jontio/JAERO` (274★)                            | Required to decode ADS-C (1200/10.5k C-Band, 600/1200 L-Band); BSD-style, prebuilt binaries      |
| SDReader (JAERO-adjacent)    | `github.com/jeroenbeijer/SDRReceiver` (40★)                 | Purpose-built SDR receiver front-end for JAERO                                                   |
| docker-jaero                 | `github.com/sdr-enthusiasts/docker-jaero`                   | Containerised JAERO                                                                              |
| ADSB-Ultrafeeder             | `github.com/sdr-enthusiasts/docker-adsb-ultrafeeder` (579★) | readsb+tar1090+graphs1090+autogain+mlat-hub; the standard feeder, also supports Jaero input port |
| JAERO C-Band guide           | thebaldgeek.github.io/C-Band.html                           | Detailed open satcom ground-station build                                                        |
| Inmarsat satellite guide     | thebaldgeek.github.io/Inmarsat.html                         | Satellite selection; **orbits changed 2018 & 2023/24**                                           |
| OpenSky ADS-C dataset        | Zenodo `10.5281/zenodo.15272131`                            | ⭐ Open ADS-C decode stream since 2023-07-07                                                     |
| SATERA (ESA SESAR)           | satera-sesar.eu + Zenodo                                    | Space-based composite ADS-B + MLAT; open deliverables (see existing oceanic notes file)          |

---

## 7. Recommended next actions (no endpoints called yet — for parent agent decision)

1. **Pull OpenSky's ADS-C dataset** (`10.5281/zenodo.15272131`, 846 MB) and spatially filter to
   lat < -50 / the Southern Ocean bbox. This is the cheapest real win and needs no new hardware.
2. **Query the ADS-B Exchange map/API for `type: adsc`** positions south of 60°S to establish a real
   baseline of what ADS-C community coverage exists today in polar airspace.
3. **Check ADS-B.lol / adsb.fi / ADSBiQ archives for any traffic below -60° latitude** to confirm (or
   rule out) that ground networks contribute anything at all near Antarctica. If zero, that is the
   finding: the gap is total.
4. **Stand up a C-Band ADS-C station** — this is the only open route to the region. Note the Antarctic
   practicalities: Troll's 4000 ft + Kongsberg satellite link is a proven template; ~300 NM coverage;
   **static electricity is the named equipment hazard**; summer-season resupply traffic plus research
   flight activity is the actual traffic of interest.
5. **Realistic scoping:** a single C-Band station sees an Inmarsat beam, not the Southern Ocean.
   Covering the region needs **multiple stations across the ±3° GEO figure-8 track**, and GEO
   visibility at high southern latitudes is the binding geometric constraint. Treat ADS-C as the
   _only_ viable medium and the Southern Ocean as a _many-station_ problem.

---

## 8. Issues / limitations encountered in this research

- **`web_search` / `web_extract` were unconfigured** (`FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` unset),
  so no managed web search was available.
- **Google, Bing, DDG-html, Mojeek, Brave, Ecosia, Startpage, searx.be all returned bot-challenge or
  403** to this host (IP <egress-ip>). Marginalia Search was the only working general index and is
  low-recall; most findings came from **direct primary-source fetches** plus two Marginalia queries.
- **arXiv API returned empty** for all ADS-B × polar queries (including generic ones) — appears broken
  or geo-blocked from this host rather than a genuine null result.
- **OpenSky's `Network Coverage` page is linked in nav but 404s** at `/network-coverage/` and
  `/coverage/` — so OpenSky's own quantified polar coverage number is unverified.
- **Several Flightradar24 blog URLs** (787 Antarctica landing, McMurdo TLS) **now 404** — content moved;
  only the Troll articles resolved.
- Per task constraints: **research only — no ADS-B data endpoints were called** and no live feeds
  queried. ADS-B Exchange's intake endpoint is documented here but not contacted.
