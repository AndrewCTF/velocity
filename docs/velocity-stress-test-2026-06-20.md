# Project Velocity — Defense-Analyst Stress Test & Capability Critique

**Analyst run:** 2026-06-20, ~20:00–20:25 local. **Mode:** local, keyless (backend `127.0.0.1:8000`, freshly booted; frontend Vite `:5173`). **Surface exercised:** 24 `osint-geoint` MCP tools, 8 backend HTTP routes, live frontend (Cesium globe, CommandBar, EntityPanel selection, SIM, layer toggles).

> **Sourcing discipline.** Everything below is grounded in what *Velocity itself returned* this session. Where I cite world events, they come from Velocity's own news layer (`news_analysis` / `fact_check`) and are **attributed**, not asserted as independent ground truth. I have not invented any track, vessel, callsign, or event. Where a region was blind, I say "blind," not "quiet."

---

## 1. BLUF (Bottom Line Up Front)

1. **The premise corrected itself.** Asked to research "the Iran–US war," Velocity's own news/fact-check layer says that war is **over**: a 14-point US–Iran MoU (post-G7, Versailles) ended the fighting, reopened the Strait of Hormuz, and tanker traffic has risen. `fact_check("US and Iran in active declared war as of June 2026")` → **verdict `false`, confidence 0.95**, six cited outlets. The currently **hot** conflicts in Velocity's feed are **Israel–Hezbollah** (ceasefire broken, strikes resumed) and **Ukraine–Russia** (record Ukrainian drone strike on Moscow; Russian retaliation pledged). A defense analyst using this tool would, correctly, re-scope.

2. **Velocity is excellent at the air + EW picture in well-covered airspace, and structurally blind everywhere the conflicts actually are.** The cross-domain fusion (`intel_brief`) lit up **25 incidents — essentially all in the Gulf of Finland / Baltic**, because that is where keyless ADS-B *and* keyless AIS overlap. The three named theaters (Hormuz, E-Med, Black Sea) returned **0 vessels each** and either tier-degraded or empty jamming. The product's headline `threat_level` does **not** encode coverage confidence, so an active war zone (Black Sea) reads **"low."** This absence-as-absence problem is the single biggest analytic risk.

3. **The reasoning/LLM layer is the strongest part of the product.** `deep_analyze` (minimax-m3) produced a calibrated, evidence-grounded EW assessment that *correctly refused* to speculate about naval movements it couldn't see. `sim/reason` returned probability-weighted strike outcomes. `news_analysis` did real verified-vs-attributed-vs-rhetoric debiasing. These are genuinely useful.

4. **Both engineering quality gates pass** (backend `pytest` 260 passed; `pnpm -r typecheck` green). The defects below are **design/semantic/coverage** flaws, not a broken build.

---

## 2. The three conflicts, as actually observed through Velocity

### 2.1 Iran–US — Strait of Hormuz / lower Gulf (focus_area 26.6N, 56.5E, 200 nm)

| Signal | Velocity result |
|---|---|
| Aircraft | 51 (48 airliner, 2 helo, 1 private) — Emirates, Etihad, Gulf Air, flydubai, Kuwait, Saudia. Civil-normal. |
| GNSS degradation | **16/51 (~31%)** degraded; multiple at cruise with **NACp=0** across ≥6 operators/airframes. |
| Jamming cells | 7 (6 medium). `locate_emitter` → diffuse, CEP 95 km, confidence 0.29 (honest). |
| Military | 2 US KC-135 (`K35R`) present but **mis-tagged `airliner`**. |
| Vessels | **0** — the busiest oil chokepoint on earth is invisible. |
| Emergencies / spoofing | none / none detected. |

**Assessment (grounded):** Velocity shows a real, fleet-wide **GNSS-interference footprint** over the UAE coast / strait approaches (3.3× the global degradation baseline per `deep_analyze`), consistent with persistent jamming that can outlast a ceasefire. This *aligns* with the news layer's "Hormuz reopened, tanker traffic up." **But the naval question — IRGCN, US 5th Fleet, tanker escort, dark tankers — is unanswerable here**: 0 AIS. `deep_analyze` flagged this blind spot itself and declined to speculate.

### 2.2 Israel–Lebanon — Eastern Mediterranean (focus_area 33.5N, 35.0E, 150 nm)

| Signal | Velocity result |
|---|---|
| Aircraft | 31 — **MEA** (Beirut), **Arkia/Israir** (Israel), **Royal Jordanian**, Qatari/Emirati wide-bodies overflying. |
| **Military ISR** | **NATO/coalition E-3 AWACS `SHUCK84` (type E3TF)** + **US KC-135 `K35R`** on station — both **mis-tagged `airliner`**. |
| Jamming | only 2 cells, near-zero — **despite the E-Med being the world's most spoofed airspace.** |
| Deception | `detect_deception` → **0 findings.** |
| Vessels | **0.** |

**Assessment (grounded):** Velocity *does* capture the **coalition air-ISR posture** (AWACS + tanker orbit) consistent with the news layer's "Israel–Hezbollah fighting resumed." The near-zero jamming reading is a **measurement artifact, not calm**: the GPSJam/NACp method detects *jamming* (degraded accuracy), not *spoofing* (false-but-confident position), and E-Med EW is overwhelmingly spoofing. The kinetic war (rocket/UAS exchange) and the naval picture are both invisible to Velocity's sensors.

### 2.3 Ukraine–Russia — NW Black Sea / Crimea (focus_area 45.3N, 33.0E, 200 nm)

| Signal | Velocity result |
|---|---|
| Aircraft | 24, **all** on the Romania/Bulgaria civil corridor; **zero over Crimea/Odesa/Kerch** (closed airspace). |
| Jamming | **0 cells** — but the region was served by the OpenSky **snapshot tier, which nulls NACp/NIC**, so jamming detection was *blind*, not negative. |
| Vessels | **0** (Black Sea Fleet, grain corridor — invisible). |
| `threat_level` | **low / score 0.** |

**Assessment (grounded):** This is the clearest illustration of the core flaw: **an active war zone reporting "low threat" because Velocity can't see into it.** ADS-B doesn't show closed-airspace military or drones; the jamming tier was degraded; AIS is absent. Separately, Velocity's *news* layer reports a record Ukrainian drone strike on Moscow — a kinetic event the sensor layers have no channel for.

### 2.4 Where Velocity actually lights up — the Baltic / Gulf of Finland (the Russia–NATO grey zone)

`intel_brief` (global) returned **25 incidents, top threat HIGH**, almost all clustered 23–28°E / 59–60°N: GPS-jamming footprints co-located with "dark"/AIS-anomalous vessels, intermittent **spoofing** incidents, and a large Norway **military-vessel-proximity** incident (`MIL BRK25 within 15–21 km of vessels ATLANTIC / THUN RELIANCE`, score 165–173). This is real, relevant Russia–NATO grey-zone activity — and it dominates the global picture **purely because it's the one theater with overlapping keyless ADS-B + AIS coverage.** It is *not* one of the three named wars.

---

## 3. Feature-by-feature stress test & ratings

Scale: 10 = excellent / trustworthy; 5 = works with real caveats; ≤3 = broken or misleading.

### MCP / analytic tools

| Feature | Rating | Verdict |
|---|---|---|
| `get_situation` | 8 | Fast, cheap orient (10.6k ac, 4.3k vessels, 320 jam cells). Military count (8) wrong; counts don't signal coverage bias. |
| `intel_brief` | 6 | Real fusion, every claim cites a signal, honest `coverage_caveat`. **But** coverage bias isn't normalized → ~always N. Europe; **dark-vessel `basis` string is factually wrong** (see §4.2). |
| `focus_area` | 7 | Great primitive (dedicated fetch + full bundle). **But** "always-fresh dedicated fetch" silently **fell back to `snapshot` for 2 of 3 regions** (Hormuz, Black Sea) with no freshness warning. |
| `query_aircraft` | 7 | Flexible filters work. `category=military` returns **5 globally** (severe under-tag); ground objects `TWR/GND/GO` emitted as `airliner`. |
| `query_vessels` | 6 | Works where AIS reaches (N. Europe); **0** in all 3 theaters. "dark" conflates *no-static-identity* with *SAR-no-AIS*. |
| `gps_jamming` | 7 | Sound GPSJam method, honest "inferred not RF." Quality is **tier-dependent** (snapshot tier nulls NACp → blind); detects jamming, not spoofing. |
| `aircraft_density` | 8 | Clean grid, peak-cell, per-cell GNSS. No notable issues. |
| `locate_emitter` | 7 | Honest CEP/confidence/"diffuse" labeling. Severity-weighted centroid biases toward **traffic density** (landed on Abu Dhabi airport). |
| `anomalies` | 6 | Reasonable triage; `threat_level` can read low for blind war zones. |
| `detect_deception` | 4 | Excellent concept ("am I being fed?"), **inert exactly where needed** — 0 in E-Med & Hormuz; only fires in N. Europe (needs AIS + track history that are absent elsewhere). |
| `aircraft_dossier` | 4 | Pattern-of-life crippled: only ~1 h server-side track, **speed math broken** (0 kn computed over a 276 km bbox), AWACS assessed "nominal." |
| `vessel_dossier` | 5 | Works in N. Europe; **proved the dark-vessel mislabel** (MMSI 230628000 flagged "dark/AIS-off" while actively broadcasting `sog 16.1` via digitraffic). |
| `deep_analyze` | **9** | Standout. Calibrated, evidence-grounded, ruled out multipath via ground-station NACp=11, **refused to assert unseen naval activity**. Caveat: re-fetches its own bundle, so cited callsigns differ from your query (reproducibility gap). |
| `news_analysis` | 7 | Real debias (verified ≥2-source vs attributed vs rhetoric; bias/propaganda flags). **But** event clustering **duplicates** events and drops militarily-relevant ones (Israel–Hezbollah) to confidence 0 / 0 sources. |
| `fact_check` | feature **9** / MCP wrapper **2** | Endpoint is excellent (verdict + confidence + cited headlines). **MCP wrapper is broken:** it POSTs a GET-only route → 405 → reports a misleading `"backend_unreachable / auto-start did not come up."** |
| `aoi_imagery` | 6 | Honest availability check. Maxar VHR is **event-gated → empty at Bandar Abbas & Sevastopol**; only 10 m Sentinel remains = too coarse for building-level BDA. |
| `area_baseline` | 6 | Sound z-score design; cold-start "insufficient" (honest), needs repeated polling. |
| `whats_changed` | 7 | Useful new/escalated/resolved watch diff; functioned correctly. |
| `incident_history` | 6 | Real per-incident time series; very verbose, shallow right after boot. |
| `lookup_aircraft` | n/t | Not individually exercised (selection/dossier paths covered identification). |
| `data_sources` | 8 | Refreshingly honest ("`true` = configured, not proven working"). Exposed the AIS cold-start clearly. |

### Backend / infra

| Item | Rating | Verdict |
|---|---|---|
| ADS-B breadth | 8 | `/api/adsb/global` served **11,403** features; world icons render. Meets the ≥8k guardrail. |
| CelesTrak `/api/space/gp` | 9 | Real `FORMAT=tle` (stations 24, starlink 2000, valid `TLE_LINE1/2`). 2 h cache. Correct per guardrails. |
| `/api/sim/reason` | 8 (−2 security) | Returns calibrated, schema-shaped reasoning. **Unauthenticated, no rate limit**; expects dict scenario/outcome. |
| News endpoints | 8 | `/api/news/{analysis,factcheck,feed}` all live and GET. |
| Imagery routes | 6 | `/api/imagery/{aoi,catalog,tiles}` wired; bounded by Maxar event-gating. |
| Reconstruction (gsplat `langat2_recon`) | 2 | **Orphaned**: 566 MB, **untracked AND not gitignored**, no route/MCP/import; `run_reconstruction` exists only in a docstring. `git add -A` footgun. |
| Quality gates | 9 | `pytest` 260 passed; `pnpm -r typecheck` green. |

### Frontend (live)

| Item | Rating | Verdict |
|---|---|---|
| Globe render | 8 | Yellow airliner **SVG icons (not dots)**, heading-rotated, labeled; quakes; 60 FPS; **0 console errors**. |
| Layers wired | 8 | `aviation.adsb.global` 1991, `maritime.keyless` 2000, `aviation.adsb.live.mil` **52**, `hazards.usgs.quakes`, `aoi-theater`. |
| CommandBar | 8 | Resolved `4ca892` → `RYR63XE @48.22,15.91`, flew camera, placed reticle. |
| Selection track | 7 | `__selectionTrack` populated **2 points** + magenta polyline rendered (sacred req met). Full EntityPanel detail not click-verified (Cesium not exposed for synthetic canvas pick). |
| SIM UI | 8 | Rich war-game: Swarm/Landing/Attack, map launch+target, force params, **control-link models** (FPV-RF jammable / FPV-fiber jam-proof / one-way GPS-INS / loitering / MALE), EW & terrain. |
| Satellites (orbital) | n/v | Backend + adapter correct, but the **orbital layer isn't reachable** from the "SAT" button (that's a 3D-imagery basemap toggle) or the Panels drawer in my pass — `/api/space/gp` never fired. Discoverability gap. |
| Auth gate | 4 | Overlay says *"globe stays blank until you sign in"* while the globe is **fully populated** (keyless). Dead/misleading gate in local mode. |
| `/ws/alerts` | 5 | WebSocket "closed before connection established" (keyless); `/ws/adsb` connects fine. |
| `clock.shouldAnimate` | n/n | `false` at load → interpolation glide won't play until started. |

---

## 4. Design flaws (prioritized critique)

**P1 — Coverage bias is not encoded into the numbers.** `threat_level`, `score`, and the global `intel_brief` are dominated by Northern Europe and read "low/empty" for blind war zones. The `coverage_caveat` is prose the model may ignore; it should be a **per-AOI coverage-confidence value** that down-weights scores and is shown beside every threat level. *Today, "low threat, Black Sea" is dangerously misleading.*

**P2 — "Dark vessel" semantics are wrong and the provenance string lies.** Vessels actively broadcasting AIS (live `sog/cog` via digitraffic) are labeled **"dark/AIS-off vessel … SAR radar contact with no matching AIS."** Two independent tools (`intel_brief`, `vessel_dossier`) confirm the contradiction. The real condition is "AIS position present, *static* name/type message missing." This is the fastest way to lose an analyst's trust. Fix the label *and* the `basis` text.

**P3 — Military classification is broken for a defense tool.** `query_aircraft(military)` = 5; frontend `live.mil` = 52; they disagree 10×, and both miss obvious mil types (E-3 AWACS, KC-135) that are tagged `airliner` — even within the same `ae*` US-mil hex block. Military air is the core entity class here; it needs a real type/hex/callsign table, reconciled between backend and frontend.

**P4 — Jamming ≠ spoofing, and the product only does jamming.** The two theaters where EW matters most (E-Med, Hormuz) are spoofing-dominated, which the NACp-degradation method cannot see, and `detect_deception` can't fire on sparse snapshots. Net: the EW picture is **systematically under-reported in contested airspace**.

**P5 — `focus_area` hides freshness fallback.** "Dedicated always-fresh fetch" silently became `load_mode:"snapshot"` for 2 of 3 theaters (rate-limited upstream). The bundle should surface a clear "DEGRADED: served from snapshot, NACp may be null" banner.

**P6 — Pattern-of-life has no memory.** ~1 h server-side retention + broken speed computation make `aircraft_dossier`/`vessel_dossier` near-useless for behavior analysis. Persist tracks for days.

**P7 — Engineering hygiene / security.** 566 MB orphaned, untracked, un-ignored `langat2_recon`; `/api/sim/reason` unauthenticated and unrate-limited.

**P8 — Frontend trust/UX.** Dead sign-in gate copy; `/ws/alerts` fails keyless; orbital-satellite layer undiscoverable; narrow (mobile) default layout for a desktop analyst tool.

---

## 5. Missing capabilities a defense analyst needs

1. **Global AIS (the #1 gap).** Every conflict chokepoint is naval-blind. Make AISStream always-on (or add a commercial/Spire/GFW feed). Without it, "maritime intelligence" is Northern-Europe-only.
2. **Spoofing detector** that works on snapshots: flag aircraft whose reported position is kinematically inconsistent with their track, or clusters snapped onto an airport — the dominant EW mode in the Middle East.
3. **Coverage-confidence overlay** on every AOI/incident (blind vs quiet).
4. **Persistent historical tracks** (days, not ~1 h) for genuine pattern-of-life.
5. **VHR / tasking imagery + surfaced SAR change-detection.** `sar_damage.py` exists but isn't exposed as a tool/route; Maxar event-gating leaves most conflict sites at 10 m. Promote SAR log-ratio BDA to a first-class MCP tool.
6. **Order-of-battle layer:** mil-hex → unit/base attribution, plus a **NOTAM / closed-airspace layer** (so "empty Crimea airspace" is explained, not silently scored low).
7. **Kinetic-event fusion:** ADS-B can't see rockets/drones; fuse FIRMS thermal + geocoded events to put Israel–Hezbollah / Ukraine strikes on the map.
8. **Vessel entity resolution:** MMSI → name/flag/type registry (most vessels return `name:null`).
9. **Reporting/export:** one-click incident dossier (PDF/GeoJSON) and saved AOIs across sessions — there is currently no analyst output path.
10. **Wire or remove the 3D reconstruction (gsplat) pipeline** — right now it's dead weight implying a capability the product doesn't ship.

---

## 6. What works well (don't regress these)

- **`deep_analyze` grounding discipline** — calibrated, cited, refuses to over-claim. Best-in-class.
- **`news_analysis` / `fact_check` debiasing** — verified-vs-attributed separation, rhetoric/propaganda flags, premise correction.
- **`sim/reason`** — probability-weighted, system-aware strike outcomes.
- **Honest self-labeling** throughout: `data_sources` ("configured ≠ working"), `locate_emitter` ("not RF DF"), `intel_brief` provenance/`coverage_caveat`, evidence `kind: measured|inferred`. This intellectual honesty is the product's best instinct — the fix for the P1/P2 flaws is to push that honesty *into the scores*, not just the prose.
- **Clean engineering baseline** — 260 tests green, typecheck green, 0 console errors, 60 FPS, SVG icons + smooth selection.

---

## 7. One-line scorecard

> **Velocity is a high-quality air-and-EW intelligence instrument with an outstanding reasoning layer and honest provenance, hamstrung for *war* analysis by (a) naval/AIS blindness in every active theater, (b) coverage bias that scores blind zones as calm, and (c) a military-classification + dark-vessel labeling layer that an adversary-aware analyst cannot yet take at face value. Fix the coverage-confidence encoding, the dark-vessel label, and military tagging, and it crosses from "impressive demo" to "trustworthy desk tool."**
