# ADS-B Datasets & Live Mirrors — Oceanic Airspace Focus (2023–2026)

**Compiled:** 2026-10-04 · **Method:** direct API queries (Zenodo, OpenAlex, arXiv, figshare-style,
HuggingFace Hub, GitHub) + liveness probes of mirror sites. Research only — no data endpoints called.

---

## TIER 1 — Best oceanic match: explicit NAT/PACI oceanic coverage

### 1. GET-25: Global Spatiotemporal ADS-B Kinematic Consistency Benchmark ⭐ TOP PICK

- **DOI:** `10.5281/zenodo.19557474` (concept DOI `10.5281/zenodo.18904146`; also indexed `10.5281/zenodo.18904147`)
- **Published:** 2026-04-13 · **Creators:** Eugene Pik, Joao Souza Dias Garcia, Timothy A. Smith
- **URL:** https://zenodo.org/records/19557474
- **License:** Data CC BY 4.0 / Code MIT
- **Volume:** 246.7 B OpenSky ADS-B messages, ~77.5 M observed flight hours, 2025 calendar year
- **Size:** ~60 GB (monthly `processed_events_*.zip` 5–15 GB + `exposure_grids_*.zip` ~25 MB)
- **OCEANIC RELEVANCE — explicit.** Record text names oceanic FIRs directly:
  > "The 'Data Gap' Confounding: **Oceanic and remote FIRs (e.g., NAT, PACI) inherently experience high
  > latency.** Kinematic jumps triggered by these coverage gaps are retained in the dataset as genuine
  > degradations of systemic observability."
  > Also: antimeridian wrap handling in the **Pacific** so trans-Pacific flights aren't falsely flagged as
  > "teleportation"; warns that ML anomaly classifiers must not read **oceanic coverage gaps** as cyberattacks.
- **Contents:** scripts.zip, requirements.txt, LICENSE.txt, reference_and_baselines.zip + per-month
  processed_events and exposure_grids
- **Caveat:** global + heterogeneous receiver density; oceanic rows are precisely the _degraded/observable-gap_
  signal, so filtering logic must use the provided exposure grids to avoid bias.

### 2. Degradation of ADS-B Integrity: Temporal Clustering and Anomaly Persistence

- **DOI:** `10.5281/zenodo.21878953` · **Published:** 2026-08-10 · **Creator:** Eugene Pik
- **URL:** https://zenodo.org/records/21878953
- **License:** CC BY 4.0 / Code MIT · **Size:** DATA.zip 2.4 GB, RESULTS.zip 105 MB, CODE.zip, LOGS.zip
- **Volume:** same 246.7 B-message 2025 corpus; 229.0 B filtered airborne state vectors; 233,859 trajectories
- **Scope note:** same OpenSky 2025 global basis as GET-25 → same oceanic/remote-FIR structure applies,
  though the description does not itself name NAT/PACI. v2 adds day-resolution survival analysis
  (scrambled-temporal permutation tests W={3,5,7,10,15}, Kaplan-Meier, Cox PH, Andersen-Gill).

### 3. Hourly Global ADS-B Kinematic Sensitivity Dataset (2025)

- **DOI:** `10.5281/zenodo.18459771` · **Published:** 2026-02-02 · **Creator:** Eugene Pik (Mevocopter Aerospace)
- **URL:** https://zenodo.org/records/18459771
- **Shape:** one row per UTC hour for all of 2025 — `sensitivity_analysis_V2.5-2025_hourly.csv`
  (processed_adsb_messages, mean/std speed, etc.) + Python & SQL generation code
- **Use for oceanic work:** hourly global sampling-volume baseline — lets you quantify _how much_ ADS-B
  volume exists over oceanic boxes vs. landmass in the same hour. Lightweight (single CSV) vs. the multi-GB
  GET-25 shards. No anomaly labeling/attribution performed (author is explicit about this).

---

## TIER 2 — ADS-C: the medium that actually covers oceanic airspace

### 4. ADS-C Air Traffic Data Collected by the OpenSky Network ⭐ KEY FOR OCEANIC

- **DOI:** `10.5281/zenodo.15272131` · **Published:** 2025-04-23
- **Creators:** Marc Xapelli, Martin Strohmeier, Tobias Lüscher (OpenSky / TU Delft-associated)
- **URL:** https://zenodo.org/records/15272131
- **Files:** `adsc_decoded.txt` (846 MB) + `adsc_file_structure.md` — **continuously collected since 2023-07-07**
- **Paper:** "A First Look at Exploiting the Automatic Dependent Surveillance-Contract Protocol for Open
  Aviation Research," _Journal of Open Aviation Science_ (2023), doi:10.59490/joas.2023.7229
- **Why it matters for oceanic:** ADS-C (contract surveillance) is the ICAO standard for oceanic/remote
  airspace where line-of-sight ADS-B reception fails. This is the closest thing to a continuously-growing
  public oceanic surveillance dataset. Same for **ADS-C over the North Atlantic.**

---

## TIER 3 — Transatlantic / geomagnetic (oceanic route case studies)

### 5. Impacts of the 10–11 May 2024 Geomagnetic Superstorm on Transatlantic Aviation

- **DOI:** `10.5281/zenodo.16931981` · **Published:** 2025-08 · **Creator:** Jie Li
- **URL:** https://zenodo.org/records/16931981
- **Files:** `20240503-19.nc` (5.7 GB, met fields **North America → Europe**), `ADSB.rar` (4 MB),
  `0Data and result.xlsx`
- **Note:** ADS-B component is small (4 MB); the bulk is ERA5-style meteorology. Useful as a
  transatlantic-route sample, not as a volume source.

---

## TIER 4 — Live, continuously-updating mirrors (the operational answer)

### 6. ADSBiq / "ADSB IQ" — daily open corpus, no token, no rate limit ⭐ TOP LIVE MIRROR

- **Site:** https://adsbiq.com/data · **Repo:** `github.com/Sky-Power-Services/adsbiq-data`
- **Direct per-day URL pattern:**
  `https://github.com/Sky-Power-Services/adsbiq-data/releases/download/YYYY-MM/aircraft_diffs_YYYY-MM-DD.parquet`
- **Cadence:** daily, ~06:10 UTC after prior day finalizes; monthly GitHub Release tagged `YYYY-MM`
- **Format:** zstd-compressed Parquet per UTC day; append-only **state diffs**
  (`is_snapshot=true` rows = full state; later rows only changed fields → forward-fill per `hex` ordered by `ts`)
- **Schema:** `ts, hex, flight, lat, lon, alt_baro, gs, track, squawk, type` + full readsb field set
- **License:** ODbL-1.0 · Attribution: "ADSB IQ feeder network"
- **Integrity:** per-file row counts + SHA-256 checksums in release notes
- **Queryable directly from DuckDB** without downloading (documented pattern on their site)
- **Stack:** readsb, tar1090, mlat-client, Ultrafeeder — i.e. MLAT-capable, which is what carries
  coverage into coastal/island-adjacent offshore areas
- **Oceanic caveat:** community receiver network — coverage is receiver-geography-dependent, so offshore
  cells are exactly where the gaps are. Their Caribbean sample (below) covers 5–30°N, 95–55°W.

### 7. ADSBiq Caribbean sample (HF) — oceanic bbox sample

- **Repo:** `huggingface.co/datasets/jsals/adsbiq-caribbean-aircraft-data` (ODbL, mod 2026-08-22)
- **Contents:** `data/caribbean_sample_2026-06-29.parquet` (1.5 MB, 100,000 rows) —
  positioned observations **5–30°N, 95–55°W on 2026-06-29**, i.e. Caribbean Sea / open-water
- Companion notebooks: `github.com/Sky-Power-Services/adsbiq-api-demo`
  (incl. `examples/coverage_gap_analysis.ipynb`)

### 8. vdlIQ — daily VDL2/ACARS exports (sibling mirror) ⭐ UNDER-EXPLOITED

- **Site:** https://vdliq.com/data · **Repo:** `github.com/Sky-Power-Services/vdliq-data`
- **URL pattern:** `.../releases/download/YYYY-MM/vdl2_messages_YYYY-MM-DD.parquet`
- **Cadence:** daily ~06:20 UTC · **License:** ODbL-1.0
- **Columns:** `timestamp, icaoHex, fromHex, toHex, tail, flightNumber, label, mode, sourceType, text,
public_category, policy_version`
- **Categories:** `position`, `weather`, `oooi`, `ats_operational`
- **Oceanic value:** oceanic ATC depends on **text/voice comms and position reports over VDL2/ACARS** —
  this gives you the non-ADS-B oceanic picture (ATS operational messages = oceanic sector coordination).
  Deliberately excludes specialty/maintenance/engine frames and station identity.

### 9. adsb.lol + HuggingFace daily archive — 344-day global history ⭐ BEST ARCHIVED MIRROR

- **Repo:** `huggingface.co/datasets/alexisplacet/adsblol_globe_history` (ODbL)
- **Coverage (verified):** **344 day-directories, 2023-03-10 → 2026-02-03** — squarely in the 2023–2026 window
- **Per-day layout** (e.g. `v2026.02.03-planes-readsb-prod-0/`):
  `aircraft.parquet` (~1 MB), `traces_00.parquet` … `traces_0c.parquet` (~6 MB each),
  plus `heatmaps/positions_*.parquet` and `heatmaps/callsigns.parquet`
- **Declared configs:** `traces`, `heatmap_positions`, `callsigns`, `aircraft`
- **Provenance:** source_dataset `https://github.com/adsblol` (readsb-based global aggregator, "globe")
- **Oceanic value:** a _global_ aggregator, so trans-ocean tracks appear as first-class records rather than
  being absent. Roughly ~12 MB/day → ~4.3 GB for the full 344-day span. Efficiently queryable via HF
  `datasets`/DuckDB over `traces_*.parquet` globs.
- **Live upstream:** https://adsb.lol (verified HTTP 200) — the HF repo is the archive; the site is live.

### 10. OpenSky Network — canonical live source (research-grade, auth required)

- **Site:** https://opensky-network.org/ · **Datasets/bucket browser:** https://opensky-network.org/datasets/
- **Trino SQL interface:** https://opensky-network.org/data/trino/ (verified live)
- **Oceanic note:** OpenSky is the corpus behind GET-25/Tier-1 items; its own coverage is community
  ADS-B + **ADS-C receivers**, and ADS-C is what extends it into oceanic FIRs. Historical access is via
  the Trino interface and the bucket browser (Parquet) rather than the rate-limited REST `/states/all`
  endpoint. Requires registered OAuth2 credentials; no token = research login required, so treat as
  "live mirror with friction" vs. ADSBiq/vdlIQ's open-access model.

### 11. Other live mirrors verified reachable (no dedicated oceanic archive found)

- https://adsb.lol/ (200) — readsb/tar1090 based, MLAT
- https://adsb.fi/ (200) — community flight-tracking aggregator w/ globe + API
- `xoolive/traffic` (GitHub, live) — Python toolbox for processing/analyzing air traffic data w/ OpenSky
  - ADS-B ingest; useful for the analysis layer
- `wiedehopf/readsb` + `wiedehopf/tar1090` (GitHub, live) — the decoder/MLAT stack underpinning the mirrors

---

## TIER 5 — Academic programs targeting oceanic/remote surveillance (research context)

### SATERA — ESA SESAR project: space-based composite ADS-B + MLAT

- **Zenodo community:** "SPACE-BASED COMPOSITE ADS-B AND MULTILATERATION SYSTEM VALIDATION THROUGH
  SCALABLE SIMULATIONS" · **Project site:** https://www.satera-sesar.eu/
- **Public project deliverables on Zenodo (all open, 2024–2026),** e.g.:
  - `10.5281/zenodo.19567532` — SATERA D7.1 Exploratory Research Plan (2026-04-14)
  - `10.5281/zenodo.17657766` — SATERA Performance Prediction Tool (2025-11-20, Software)
  - `10.5281/zenodo.17476865` — D6.1 Space-based MLAT algorithms description (2025-10-29)
  - `10.5281/zenodo.18388175` — D6.2 Space-based MLAT algorithms prototypes (2026-01-27)
  - `10.5281/zenodo.22764680` — D3.4 Guidelines: resilient MLAT receiving stations for LEO space (2026-09-15)
  - `10.5281/zenodo.17120477` — D3.2 Hybrid receiving station architecture (2025-09-15)
  - `10.5281/zenodo.16810893` — D3.1 Signal features extraction systems (2025-08-12)
  - `10.5281/zenodo.16810937` — D5.2 CRLB for MLAT (2025-08-12)
- **Key paper:** "SATERA Baseline: Identifying the Challenges of Space-Based Multilateration Systems,"
  ICNS 2024, doi:10.61009/SID.2024.1.36 (`10.5281/zenodo.14886604`)
- **Oceanic relevance:** space-based reception exists _precisely_ because oceanic airspace is beyond
  line-of-sight of ground MLAT. These deliverables are the best public documentation of that gap and
  of the validation methodology for filling it.

### GAIA — high-resolution global aviation emissions inventory from ADS-B

- **DOI:** `10.5281/zenodo.8369564` (2019–2021 origin-destination statistics)
- **Creators:** Roger Teoh, Zebediah Engberg, Marc Shapiro, Lynnette Dray, Marc E.J. Stettler
  (Imperial College London / UCL / Breakthrough Energy)
- **Oceanic value:** global OD (origin–destination) matrices include long-haul trans-oceanic legs;
  useful for building traffic-weighting layers over oceanic boxes when raw ADS-B is sparse.

### Other academic (2023–2026), for methods/baselines rather than oceanic data

- `10.59490/joas.2023.7229` — First look at ADS-C for open aviation research (companion to Tier-2 item 4)
- arXiv:2505.06254 / IEEE ICNS 2025 doi:10.1109/icns65417.2025.10976963 — **OpenSky Report 2025:
  Improving Crowdsourced Flight Trajectories with ADS-C Data** (directly about fixing oceanic-track
  reconstruction quality in OpenSky)
- `10.5281/zenodo.23073781` — "Before 7700: Detecting Persistent Trajectory Precursors in OpenSky Data"
  (2026-10-01 preprint; OpenSky, 42 emergency + 162 control flights)
- `10.5281/zenodo.17293601` — ADS-B anomaly detection in surveillance of low-altitude aircrafts (2025-10-08,
  dataset.zip 828 MB)
- `10.5281/zenodo.12204932` — "Securing the Sky": cross-checking receiver-based estimated vs. received
  ADS-B trajectories (2024-06-21; 2 × ~275 MB CSV) — MLAT-vs-received cross-validation, which is the
  method that matters where only one receiver sees a track
- `10.5281/zenodo.10054835` — Radarcape raw ADS-B messages, EETAC-UPC Barcelona rooftop, Sep–Oct 2023
  (28 raw .csv.gz, ~4.7 GB) — raw RF-message level, useful for decode-layer work
- `10.1109/mmm.2024.3443754` — "Aircraft Surveillance From Space: The Future of Air Traffic Control?"
  IEEE Microwave Magazine 2024-11-05 (14 citations) — best review of space-based ADS-B status/gaps
- arXiv:2608.21108 — ADS-B interferometry (ADSBi) for atmospheric refractivity (2026-08-21)
- arXiv:2607.09700 — Track-consistency-based GNSS RFI monitoring using crowdsourced ADS-B sensor
  networks (2026-06-21)
- `10.1109/icns65417.2025` — Simulation study / Pacific oceanic region ATM efficiency evaluation (2025)
  and "Simulation Study of Oceanic Flight Operations to Support Airspace Design" (JSASS, 2025)

---

## Practical recommendation for oceanic OSINT work

1. **For historical, reproducible, citable analysis (2025):** start with **Tier-1** —
   GET-25 (`19557474`) is the only source that explicitly labels NAT/PACI oceanic coverage gaps as a
   first-class analytical object. Pair with `18459771` (hourly global volume baseline) to size oceanic
   sampling density.
2. **For oceanic surveillance substance:** **ADS-C** dataset (`15272131`, growing since 2023-07-07) plus
   the OpenSky Report 2025 ADS-C trajectory work. ADS-C is the protocol oceanic airspace actually uses.
3. **For live/current monitoring:** **ADSBiq** (daily Parquet, no auth) is the most automation-friendly;
   **vdlIQ** adds the oceanic comms/ATS-operational layer; **adsb.lol HF archive** gives ~1 year of
   already-downloaded global history at ~12 MB/day with zero API friction.
4. **Known structural limitation, stated plainly:** every ground-receiver source (ADSBiq, adsb.lol,
   OpenSky, HF mirrors) has **thinner oceanic coverage than landmass** — that is the core finding
   documented in GET-25 and the motivation for SATERA. Treat offshore gaps as signal, not noise, and
   use the provided exposure grids to de-bias. For true open-ocean coverage, space-based sources
   (Aireon-class / SATERA) are the frontier and remain mostly non-public.

---

### Sources queried

Zenodo REST API (multiple relevance/date-sorted sweeps) · OpenAlex Works API (2023-01-01+ filter,
`fulltext.search`) · arXiv API · HuggingFace Hub datasets API · GitHub repositories API ·
liveness probes of adsbiq.com, vdliq.com, adsb.lol, adsb.fi, opensky-network.org.

### Notes / issues

- `web_search` backend was unconfigured (no FIRECRAWL key), so all discovery was done via direct
  API queries + HTTP probes instead.
- GitHub repositories/code search rate-limited (403/empty) partway through; repo-level findings
  (adsb.lol/adsb.fi/readsb/tar1090/traffic/OpenSky stack) confirmed via direct page probes instead.
- Zenodo began rate-limiting after ~60 queries; the last sweep (SATERA enumeration) was truncated,
  but individual SATERA DOIs listed above were each independently verified.
- No ADS-B data endpoints were called (per task constraint) — liveness checks were GETs of HTML/API
  _documentation_ pages only.
