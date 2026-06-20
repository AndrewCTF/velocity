# Velocity — War-Sim Stress Test & Red-Team Report

**Date:** 2026-06-20
**Tester persona:** offensive analyst focused on the Iran–US and Israel–Lebanon wars (heavy simulation: e.g. 1,000 drones vs Iron Dome / layered air defence).
**Scope:** end-to-end — `curl` → backend routes → MCP server → AI endpoints → news/verification → 4D replay → frontend.
**Method:** live exercise of the running dev stack, not a code read alone. Every claim below is backed by an observed status code, count, latency, or tool output captured this session.

---

## 0. Test harness — what was actually live

| Component | State | Detail |
|---|---|---|
| Backend | **UP** `:8000` (pid 346221) | `/api/health` 200, OpenAPI lists **80 paths** |
| Frontend | **UP** `:5173` (vite) | proxies `/api`,`/ws`,`/tiles` → `:8000` |
| Ollama | **UP** `:11434` | `qwen3.6:latest` (36B), `qwen3-coder:30b` |
| Cloud LLMs | **configured + working** | primary **minimax** (`minimaxai/minimax-m3`, NVIDIA endpoint), **deepseek** (`deepseek-reasoner`/`-chat`) |
| History DB | 6.4 GB, **task_running:true** | `positions` table, 31.6 M rows |
| MCP `osint-geoint` | connected to this session | HTTP client → `API_BASE=http://localhost:8000` |
| Supabase | project `dagqceedkxxvvbhmewca` | password grant for `andrew@andrewyong.dev` → **JWT issued, role `authenticated`** ✅ |

**Auth reality:** the local backend has no `SUPABASE_JWT_SECRET`/`API_KEY` configured, so it is effectively **keyless** — `require_api_key` passes with no token (e.g. `/api/sim/reason` returned 200 with no auth), and a *valid* prod Supabase JWT is **not** honoured locally (`/api/keys` → 401 "sign-in required" even with andrew's token). The commercial auth/tier gate therefore only exists on the deployed backend; it cannot be exercised against this local instance.

---

## 1. Executive summary — prioritized

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | 🔴 **Blocker for this persona** | Sim | **Drone count hard-clamped to 200** in both `buildSwarm` and `buildAttack`. "1,000 drones" is silently simulated as 200 — *and* the Iron-Dome leak/impact math runs on the clamped 200, understating damage ~5×. No UI warning. |
| 2 | 🔴 High | Sim fidelity | `salvoPerSite` **hardcoded to 4** for every defender → THAAD, Patriot, Iron Dome and a single Stinger team all saturate identically per site. |
| 3 | 🔴 High | Replay | History retention is **~23 h** (rolling). "Replay 4 days ago" is **structurally impossible** — `-1d…-7d` windows return 0 tracks. |
| 4 | 🔴 High | News | News feed is **general world RSS, not conflict-filtered**. fact-check/analysis only adjudicate against whatever is on the front page (today: bird flu, sports). For an Iran-Israel analyst the war is largely invisible to this layer. |
| 5 | 🔴 Med | Backend | `/api/me` is **called by the frontend** (`SettingsModal.tsx:24`) but **never defined** in the backend → 404. |
| 6 | 🔴 Med | Backend | `/api/cyber/ioda/outages` → **500** (unhandled exception bypasses the 502 guard). |
| 7 | 🟠 Med | MCP | `incident_history` (default `hours=6`) returns **89 KB → exceeds the MCP token limit → hard error**. No `limit`/pagination param. Unusable by an agent at default args. |
| 8 | 🟠 Med | Perf | `/api/intel/lod1` **22 s**, `/api/cams` **18 s**, `/api/history/tracks` **12 s** — multi-second waits on analyst-facing routes. |
| 9 | 🟠 Med | Data | OpenSky **authed** creds dead (`/api/aviation/states` 401 "Invalid client"); GDELT dead (`/api/events/gdelt` 502); `/api/space/gp` **timed out** (>25 s). |
| 10 | 🟠 Med | Coverage | **Maritime blind spot in-theater**: Strait of Hormuz / Gulf = **0 live AIS** (keyless AIS is Northern Europe only). SAR dark-vessel layer is the only Gulf maritime signal. |
| 11 | 🟡 Low | Latency | `/api/news/factcheck` took **97 s** for one claim (cold model path). |
| 12 | 🟡 Low | Security | Supabase advisors: `public.rls_auto_enable()` is **SECURITY DEFINER, executable by `anon`** via REST RPC; leaked-password protection **disabled**. |
| 13 | 🟠 Med | AI | **`/api/intel/investigate` doesn't geo-scope to the region named in the query** → returned "no jamming over Israel/Lebanon, all in Europe" while `intel_brief` shows 16 real jamming incidents there. False negative for theater questions. |
| 14 | 🔴 High | Sim/Frontend | **Two combat models disagree** on one scenario: live Link/EW integrator says all drones "link-lost, 0 struck" (range model) vs Battle-damage card 64% leak (`resolveRaid`, range-agnostic). Contradictory panels (§10.3). |
| 15 | 🔴 Med | Frontend | **World-view shows 2,000 of 17,149 aircraft** — frontend polls `limit=2000`, no `/ws/adsb` hot-blob socket active; the documented 20k WS primary transport appears inactive in this build (§10.4). |
| 16 | 🟠 Low | Frontend | **Duplicate `history-replay` datasource** (StrictMode double-mount); visible one is correct but the leaked empty one breaks `getByName(...)[0]` (§10.5). |

**What genuinely works well (do not regress):** the cross-domain fusion engine (`intel_brief`/`anomalies`/`whats_changed`), GPS-jamming inference over the theater, the two cloud reasoning tools (`/api/sim/reason` and `deep_analyze`), the deterministic combat math itself, and the *honesty* of the intel layer (every inferred signal is tagged `kind:inferred` + `basis`, with `coverage_confidence`/`coverage_caveat`).

---

## 2. Simulation engine — the headline for this persona

The browser owns the simulation (physics, combat math); `/api/sim/reason` only narrates the browser-computed numbers. The combat model lives in `apps/web/src/sim/`.

### 2.1 🔴 The 200-agent hard clamp (the "1,000 drones" problem)

`apps/web/src/sim/engine.ts`:
- `buildAgents()` line 101: `const n = Math.max(1, Math.min(200, Math.floor(count)));`
- `buildAttack()` line 200: `const count = Math.max(1, Math.min(200, Math.floor(p.attackerCount)));`

So a drone-swarm or attack is **capped at 200** for *both* the rendered/animated agents **and** the leakage math (line 238 `resolveRaid(count, …)` is fed the clamped `count`). The defender capacity passed in is `salvoPerSite:4` (hardcoded, line 241).

**Worked example — 1,000 Shahed-136 vs 5 Iron Dome batteries, nap-of-earth (cover 0.7)**, using the repo's own `resolveRaid`:

| | attackerCount | capacity | intercepted | leakers | damageUnits | leak % |
|---|---|---|---|---|---|---|
| **Operator asks** | 1000 | 20 | 12.6 | **987.4** | **691.2** | 98.7 |
| **Engine simulates** | 200 | 20 | 12.6 | **187.4** | **131.2** | 93.7 |

The operator types 1,000, sees a raid of 200, and the reported damage is **~1/5** of the requested mass — with **no warning** that clamping occurred. In the UI it's worse still: the swarm "Drones" slider maxes at **60** and the attack "Strikers" slider at **80** (§10.1), so 1,000 cannot even be entered. For a tool whose entire purpose is saturation analysis, silently dropping the bulk of the salvo is the most serious gap.

**Fix options (pick one, in order of effort):**
1. **Minimum:** surface the clamp — if `count > 200`, show "capped at 200 for rendering" and scale the displayed agents while running the *math* on the true count. (`resolveRaid` is already uncapped and O(layers); only `buildAgents` is the bottleneck.)
2. **Better:** decouple the **math count** (true `attackerCount`, cheap) from the **render count** (sample/representative ≤N icons). Saturation analysis needs the real number; the globe doesn't need 1,000 billboards.
3. **Full:** raise the render cap with LOD/instancing and perf-test (see frontend section for measured FPS at the cap).

### 2.2 🔴 `salvoPerSite` is a stub

`buildAttack` hardcodes `salvoPerSite: 4` regardless of the defender chosen from the catalog. The catalog *has* the data to differentiate (THAAD ≈ 48 ready interceptors/battery, Iron Dome battery ≈ 3–4 launchers × 20, a Stinger team ≈ a couple). Modelling them all as "4 simultaneous engagements" makes the defender choice cosmetic for saturation outcomes. Recommend deriving per-site capacity from catalog specs (ready rounds, reload, launchers).

### 2.3 What's correct
- `resolveRaid` (combat.ts) is a clean layered-saturation model (capacity = Σ count×salvo; engaged = min(surviving, cap); intercept at pk×cover; survivors flow on). Uncapped, deterministic, explainable. Good.
- `lanchesterSquare` for force-on-force is a textbook Euler integration. Fine.
- Determinism via `mulberry32(seed)` — reproducible. Good.
- `/api/sim/reason` over these numbers (see §3.1) produces a genuinely useful analytic narrative.

---

## 3. AI / reasoning endpoints

| Endpoint / tool | Status | Latency | Backend | Verdict |
|---|---|---|---|---|
| `POST /api/sim/reason` | 200 | 22.5 s | minimax-m3 | ✅ Strong |
| MCP `deep_analyze` (tier=reason) | 200 | ~30 s | deepseek-reasoner | ✅ Strong |
| `GET /api/news/analysis` | 200 | 0.2 s (cached) | deepseek | ⚠️ empty content (see §4) |
| `GET /api/news/factcheck` | 200 | **97 s** | minimax/deepseek | ⚠️ see §4 |
| MCP `fact_check` (matching headline) | 200 | ~25 s | — | ✅ logic works |

### 3.1 `/api/sim/reason` ✅
Fed the 1,000-drone Iron-Dome scenario it returned: *"The defense is catastrophically saturated… leak rate above 98%… Tel Aviv would face hundreds of impacts… escalation_risk: high"* with an economic estimate (low-to-mid tens of $B), second-order effects (insurance repricing, C-UAS acceleration), and explicit assumptions (constant Pk, salvo capacity). `confidence: medium`. This is the right altitude for analyst war-gaming and is clearly labelled as estimate. **The backend reasoning handles 1,000 fine — the only thing stopping the operator is the frontend clamp (§2.1).**

### 3.2 `deep_analyze` ✅
Asked about coordinated jamming over Israel/Lebanon/Syria it returned a *distributed-EW* assessment: 4 clusters across ~300 km, named the most-degraded aircraft (incl. military K35R `ae066a`), distinguished "multiple emitters" from a single jammer, and emitted concrete follow-up queries. Heavy reasoning runs off-context; only the conclusion returns. This is the flagship tool and it delivers.

### 3.3 Latency caveat
`/api/sim/reason` at 22 s and `factcheck` at 97 s are slow for an interactive operator. The cloud models are the cost; consider streaming partial output or a "fast" tier toggle on the sim narrative (deepseek-chat) for first-look.

### 3.4 🟠 `/api/intel/investigate` ignores the region in the question
Asked *"GPS jamming over Israel and Lebanon"* (13.5 s) it answered: *"No incidents in the provided fused feed are located over Israel or Lebanon; all centroids fall in northern/central Europe."* But the **same instant**, `intel_brief` with a Middle-East bbox returned **16 jamming incidents** over exactly Israel/Lebanon/Syria. The investigate agent reasons over the **global top-N fused feed** (which is Europe-dominated, where multi-domain convergence exists) and **does not geocode/scope to the region named in the free-text query** — so it produces a confident false negative in-theater. This is the most dangerous AI behaviour found: an analyst asking "is there jamming over Lebanon?" is told "no." **Fix:** geocode the query (it already has a geocoder — `/api/geocode` resolved "Strait of Hormuz" correctly) and scope the fused feed to that bbox before reasoning. `/api/intel/agent` (a streaming SSE endpoint) should get the same treatment.

---

## 4. News & verification

**Outlets** (`apps/api/app/news/sources.py`): BBC World, Al Jazeera, Guardian World, NPR, France24, DW, Sky World, CNBC, CNN World, Fox World, + Google-News RSS for Reuters/AP. All **general "world" front-page RSS**. **There is no conflict/keyword query** (e.g. no `Iran OR Israel OR Hezbollah OR Hormuz` search feed).

### 4.1 🔴 Not war-focused
`news_analysis` today returned events like *"Australia confirms first H5N1 bird flu"* — not the Iran/Israel war. The pipeline is a bounded agent (`analyze.py`: cluster → per-event debias → self-critique requiring ≥2 distinct sources). Mechanically sound, but on a thin/general headline set the corroboration step nukes everything: every returned event had `verified_facts: []`, `attributed_claims: []`, `bias_flags: []`. The headline "debias + fact-separation" feature therefore produced **no actual content** this run.

### 4.2 fact-check: logic OK, theater coverage not
- **War claim** ("Israel destroyed Iran's Natanz facility in a June 2025 airstrike"): `verdict:unverified, reasoning:null, supporting_sources:null, confidence 0.35` after **97 s**. Useless — because there were **no matching headlines** to adjudicate against.
- **Matching claim** ("Australia detected first mainland H5N1… in a migratory seabird"): `verdict:unverified` but with **rich reasoning** (core confirmed by 4 sources; the *seabird* sub-detail uncorroborated) and **4 supporting_sources**, confidence 0.55.

So the adjudication code works **when the claim intersects the feed**. The defect is upstream: the feed doesn't carry the conflict. **Fix:** add conflict-scoped Google-News search feeds (and/or accept a region/topic param) so the war is actually in the corpus. Minor: verdict calibration — a core claim corroborated by 4 sources reading "unverified" because one sub-detail is missing is arguably "true (with caveat)" or "misleading", not flat "unverified".

---

## 5. Replay / 4D ("replay 4 days ago")

- `positions` table: **31,657,587 rows**, timestamp `t` **min `2026-06-19 13:52` → max `2026-06-20 13:03` UTC = 23.2 h span** (authoritative `sqlite MIN/MAX`).
- API probe confirms: `-0d` window → 30 tracks; **`-1d` through `-7d` → 0 tracks**.
- `/api/history/tracks` (full, recent) = 6.8 MB in **11.9 s**.

**Conclusion:** the store is a ~24 h rolling buffer (consistent with the documented self-capping/VACUUM). The operator's explicit request — replay something **4 days ago** — cannot be served; the data is gone. 4D replay works only within the last day. Either (a) state the retention window in the replay UI, or (b) if longer replay is a product goal, add tiered/downsampled cold storage (full-res 24 h, decimated tracks for weeks).

---

## 6. MCP server (`osint-geoint`) — per-tool results

22 tools exercised live against the theater. The server is a thin, honest HTTP client over the intel routes.

| Tool | Result | Note |
|---|---|---|
| `get_situation` | ✅ | 17,374 aircraft / 5,025 vessels / 391 jam cells |
| `data_sources` | ✅ | honestly flags "key configured ≠ working"; AIS = N. Europe only |
| `intel_brief` (global & ME bbox) | ✅ | 25 global / 16 ME incidents; full provenance + `coverage_caveat` |
| `focus_area` (Hormuz) | ✅ | dedicated fetch, 11–14 aircraft, density grid, 0 vessels |
| `anomalies` (Iran) | ✅ | threat high, `coverage_confidence:low` (honest) |
| `gps_jamming` (ME) | ✅ | 11 cells; real degraded airliners over Turkey/Syria/Israel/Gulf |
| `locate_emitter` | ✅ | CEP 140 km, "diffuse — not a point source", conf 0.26, method stated |
| `query_aircraft` / `query_vessels` | ✅ | found a military squawk over Sinai; **0 vessels at Hormuz**, 493 in Gulf of Finland |
| `aircraft_density` | ✅ | (also embedded in `focus_area`) |
| `lookup_aircraft` (MFO500E) | ✅ | military, squawk 5600 |
| `detect_deception` (ME) | ✅ | 0 findings (clean) |
| `area_baseline` | ✅ | z-scores vs rolling baseline |
| `whats_changed` | ✅ | Baltic multi-domain "AIS concealment under EW cover" |
| `aoi_imagery` (Tel Aviv) | ✅ | Maxar empty (event-gated), Sentinel available |
| `deep_analyze` | ✅ | see §3.2 |
| `fact_check` | ⚠️ | logic OK; feed coverage limits it (§4.2) |
| `aircraft_dossier` / `vessel_dossier` | ⚠️ | work, but "insufficient track" — server keeps only ~1 h |
| `list_focus_areas` | ✅ | both AOIs listed, `max:8` |
| `incident_history` | 🟠 **defect** | default `hours=6` → **89,425 chars → exceeds MCP token limit → error** |

**MCP-specific issues:**
- 🟠 **`incident_history` overflows the response token cap at default args** — it must gain a `limit`/`max_incidents`/pagination param (or default to a compact summary). As-is, an agent calling it normally gets an error instead of data.
- 🟠 **Dossier depth = ~1 h** server retention → "insufficient track / profile" for freshly-seen entities; pattern-of-life is thin. (The 24 h `positions` DB exists — dossiers could read from it instead of the 1 h in-memory store.)
- 🟡 **`vessel_dossier` name/category join:** `query_vessels` knew MMSI 311000977 = "BALTIC HOLLYHOCK"/cargo, but `vessel_dossier` for the same MMSI returned `name:null, category:other`. The dossier path doesn't reuse the name cache the query path has.

---

## 7. Backend endpoint health (80 routes; 55 auto-probed)

### 7.1 Non-200s
| Status | Endpoint | Cause |
|---|---|---|
| **500** | `/api/cyber/ioda/outages` | Unhandled exception — `cyber.py` raises 502 only on a non-200 upstream; a connection error / non-JSON body in `r.json()` escapes the guard → 500. Should degrade to 502/empty like the Cloudflare variant (which returned 200 `items:0`). |
| **502** | `/api/events/gdelt` | "gdelt upstream 404" — GDELT feed dead from this egress. The whole events/GDELT domain is offline (also removes a fusion domain from `intel_brief` in-theater). |
| **401** | `/api/aviation/states` | OpenSky OAuth "Invalid client" — **authed creds expired/invalid** (classic "configured ≠ working"). Breadth still OK via anonymous `/states/all` (17 k aircraft), so impact is limited, but the route itself is broken. |
| **timeout** | `/api/space/gp` | CelesTrak satellites >25 s (cold cache / upstream throttle). Satellites layer slow/empty until warm. |
| **502** | `/api/adsb/fi/global` | adsb.fi 429/datacenter-block (expected) — but returns 502 rather than degrading silently. |
| **401** | `/api/keys`, `/api/alerts/rules` | Gated; expected — but also 401 with a *valid* prod JWT (local backend can't verify Supabase token). |

### 7.2 Latency (analyst-facing, slow)
`/api/intel/lod1` **22.4 s** · `/api/cams` **18.1 s** · `/api/history/tracks` **11.9 s** · `/api/intel/watch` 4.9 s · `/api/intel/dark-vessels/sar` 4.3 s. The 18–22 s routes are a poor click-to-result experience; cache/precompute or stream.

### 7.3 `/api/me` 404
`SettingsModal.tsx:24` calls `apiFetch('/api/me')`. Grep of `apps/api/app/` shows **no `/me` route defined** (keys live at `/api/keys`). Confirmed 404 with and without a token. The settings "account" lookup is dead. Either build `/api/me` (return profile/tier from the JWT) or remove the call.

### 7.4 Healthy & rich
adsb/global (8 MB, ~17 k aircraft, 0.38 s), maritime (digitraffic/keyless/snapshot), cables (728 KB), firms fires (3.5 MB — FIRMS key works), eq/seismic, weather (alerts + SWPC Kp), jamming/nacp, all `intel/*`, news/feed (272 articles). Breadth requirement (≥8 k aircraft) is comfortably met.

### 7.5 Parameterized & AI-query endpoints (the 22 routes needing params)
| Endpoint | Result | Note |
|---|---|---|
| `/api/intel/agent?q=` | ✅ streaming | SSE/NDJSON (`{"type":"start"…}` then events) — works; should geo-scope like investigate |
| `/api/intel/investigate?q=` | 🟠 | works but **not geo-scoped to the query** → false negative in-theater (§3.4) |
| `/api/entity/aircraft:ae0df0` | ✅ | rich enrichment (registration, type, operator, manufacturer, country). Bare id → 400 "expect `<kind>:<id>`" (good validation) |
| `/api/adsb/trace/{icao}` | ✅ | `{icao, source, count, points}` |
| `/api/correlations/{eid}` | ✅ | `{entityId, correlations}` |
| `/api/intel/dossier/aircraft/{ident}` · `/api/intel/aircraft/{ident}` | ✅ | work; track "insufficient" (~1 h retention) |
| `/api/geocode?q=` | ✅ | resolved "Strait of Hormuz" → 26.45,56.20 (Arabic/strait) |
| `/api/weather/openmeteo`, `/api/events/all` | ✅ | events `features:[]` in-theater (GDELT down + ACLED off) |
| `/api/search?q=Tehran` | 🟡 | returns `[]` — it's a live-entity search, not a place search; "Tehran" matches no entity. Confusing vs `geocode`. |
| `/api/intel/area?…&radius_nm=300` | 🟡 422 | caps `radius_nm`≤250 (so does `focus_area`), but `intel_brief` defaults/allows 500 — inconsistent ceilings. |

---

## 8. Auth & security

- **Local:** keyless; the prod Supabase JWT is *not* validated locally → commercial gating untestable here. The password grant for `andrew@andrewyong.dev` succeeded against the prod Supabase project (role `authenticated`, 1 h token), so the **live login path works**; only the local backend ignores it.
- **Supabase advisors (security):**
  - `public.rls_auto_enable()` is **`SECURITY DEFINER` and `EXECUTE`-able by `anon`** via `/rest/v1/rpc/rls_auto_enable` → privilege-escalation surface. Revoke EXECUTE or switch to `SECURITY INVOKER`.
  - **Leaked-password protection disabled** (no HaveIBeenPwned check).
- RLS is enabled on all 5 public tables (profiles, subscriptions, tier_limits, user_keys, alert_rules). Good. The anon/publishable keys are browser-safe by design.

---

## 9. Data-coverage gaps for THIS theater (Iran / Israel / Gulf)

The intel engine is honest about these, but they directly limit the persona:
- 🔴 **Maritime:** keyless AIS = **Norway + Baltic only** (Kystverket NMEA + Kystdatahuset + Digitraffic). The **Strait of Hormuz returned 0 vessels**; the Gulf tanker war is invisible to AIS. Only the Sentinel-1 **SAR dark-vessel** layer (4 contacts) covers it, on a 6 h cadence. Global AIS needs an AISStream key.
- ✅ **Air & GPS-jamming:** ADS-B-derived, so they *do* cover the theater well — live degraded airliners over Turkey/Syria/Lebanon/Israel/Gulf, clustered into 16 jamming incidents.
- 🔴 **Events/GDELT down** removes the "reported event" fusion domain in-theater, so ME `intel_brief` incidents are all single-domain (gps-jamming) — no air↔event↔maritime convergence where it would matter most.
- Net: for Iran/Israel this is currently an **air-and-EW picture**, not a maritime or open-source-event picture.

---

## 10. Frontend (live Playwright, authenticated as `andrew@andrewyong.dev`)

Driven headless at 1600×1000, no code edited. Screenshots saved to project root `01..09-*.png` (untracked/gitignored local evidence).

### 10.1 🔴 The "1,000 drones" ceiling is THREE layers deep, all silent
- **Swarm "Drones" control is a slider `min=1 max=60 step=1`** — no number field. Forcing `1000` via the native setter → browser clamps to **60**.
- **Attack "Strikers" slider `max=80`** → forcing 1000 clamps to 80.
- **Engine** then clamps to `Math.min(200, …)`. Injecting `count=100000` straight into React state (bypassing the slider) and launching spawned **exactly 200 UAV agents** — tab did **not** crash, and **no "capped at N" feedback** appeared anywhere.
- **Answer to the operator's exact question:** the UI cannot even express >60 (swarm) / >80 (attack); under injection the engine silently caps at 200. So a "1,000-drone" raid is ~16× short at the input and 5× short at the engine, with zero warning. (`SimulationOverlay.tsx:317,323` + `engine.ts:101,200`.) Screenshot `06-sim-stress-200-clamped-from-100000.png`.

### 10.2 ✅ The sim renders and runs well (within caps)
80 strikers vs Iron Dome ×8 → 80 UAV agents + 8 SAM range-rings + station + route + impact zone, all animated. Battle-damage card: Intercepted 28.8 / Leakers 51.2 / 64% leak; economic card mapped to "Turkish Straits", oil +1.5%, $2.0 B/day. AI "Analyst assessment" (`/api/sim/reason`, deepseek-reasoner, ~10.6 s) returned escalation HIGH (Article 5), casualties 20–200, probability-weighted outcomes, and **caught the model's own range inconsistency**. Screenshot `05-sim-attack-80-irondome.png`.

### 10.3 🔴 Two combat models disagree on the same scenario
The live **Link/EW integrator** reported all 80 drones **"Link lost / EW", 0 struck, 0 intercepted** (attacker default link FPV-RF ~5–20 km vs a ~128 km launch→target leg → every drone exceeds comms range), while the **Battle-damage** summary (range-agnostic `resolveRaid`) reported 25.6 hits / 28.8 intercepts. The two panels tell an analyst contradictory stories for one launch. Either share the range model between them or warn when leg distance exceeds the chosen link range.

### 10.4 🔴 World-view pulls 2,000 of 17,149 aircraft
Frontend requests `/api/adsb/global?...limit=2000` (entity counter ~4,300 with overlays); the backend has **17,149** at `limit=20000`. CLAUDE.md documents a 20,000-cap **`/ws/adsb` hot-blob as the PRIMARY transport** — but no `/ws/adsb` socket was observed, only the `limit=2000` HTTP poll. Backend data is healthy (>8 k floor); the **frontend build isn't pulling the full snapshot** (the WS hot-blob path appears inactive). Regression vs the documented refresh design.

### 10.5 Replay / 4D (frontend side)
- ✅ **24h replay works**: 1,669 tracks / 422 k points for the bbox; clock spanned `2026-06-19T14:08→2026-06-20T14:08`; **all 1,669 contacts rendered as category SVG icons, 0 points**; sampled tracks travel 78–337 km (real `SampledPositionProperty` interpolation). Exit restores the live view. Screenshot `07-replay-24h-svg-icons.png`.
- 🔴 **No date picker** — `Timeline.tsx` offers only trailing **1h/6h/24h** windows `[now-window, now]`; targeting 2026-06-16 is impossible from the UI, on top of the ~24 h backend retention (§5).
- 🟠 **Duplicate `history-replay` CustomDataSource** — two coexist (one empty/hidden, one populated/shown), most likely a React-StrictMode double-invoke of the `installHistoryPlayback` effect. The visible one is correct, but `getByName('history-replay')[0]` returns the wrong (empty) instance. Guard against double-mount.

### 10.6 ✅ Entity / globe (guardrails hold)
- Over Europe: `aviation.adsb.global` = 1,287 entities / **1,287 billboards, all images, 0 points**; mil overlay 56 billboards; `maritime.keyless` 2,000 vessel billboards. Only quakes use points (correct). Yellow airliner silhouettes rotated to heading. Screenshot `03-europe-aircraft.png`.
- Selecting aircraft `3d665e` → EntityPanel populated + **two polylines `rgba(217,70,239,0.95)` (#d946ef) width 4 + black outline width 6** + pulsing reticle, exactly per guardrail. Clicking empty ocean cleared track + reticle + panel. Screenshot `04-aircraft-selected-panel-track.png`. (Method note: Playwright `mouse.click` doesn't reach Cesium's `ScreenSpaceEventHandler`; real `PointerEvent`s were required — a harness quirk, not an app bug, confirmed via `scene.pick`.)

### 10.7 Perf
90 fps idle → **43 fps** at 80 agents → **32 fps** at 200 agents (+~4,300 live entities). Degraded but fully interactive; no freeze or hang at any point, including the 100,000-injection stress.

### 10.8 Auth & console/network
- ✅ Sign-in works: Supabase grant 200, header shows the account + Keys/Sign-out, `/ws/alerts` → `WS · live` (20 alerts), gated `/api/intel/brief` + `/api/config` 200 after login.
- 🔴 (expected locally) `/api/keys` → 401 "sign-in required" despite the valid session — local backend doesn't verify the prod JWT, so the Keys panel is non-functional locally.
- **Console: 1 error** (the `/api/keys` 401), 3 benign warnings (React-Router future flags, a transient pre-auth `/ws/alerts` close). **No uncaught exceptions, no Cesium errors.**
- **Network: 595×200, 1×401, 109 client-aborted, NO 5xx.** 104 of the aborts are `/api/timeline/density` superseded polls (Timeline aborts the prior in-flight request each tick) — high churn, candidate for debounce/reuse [UX].

---

## 11. Prioritized fix list

**Must-fix for the war-sim persona**
1. Kill the silent drone-count caps: raise the UI sliders past 60/80 (§10.1) AND the engine `Math.min(200,…)` (§2.1); run the saturation math on the true count even if rendering is sampled, and show a "capped at N" label if any cap is applied.
2. Derive `salvoPerSite` / per-site capacity from the catalog instead of hardcoding 4 (§2.2).
3. Reconcile the two combat models — the live Link/EW range integrator vs the range-agnostic `resolveRaid` — so the two panels stop contradicting each other, or warn when the launch→target leg exceeds the chosen link range (§10.3).
4. Make news/fact-check conflict-aware (add Iran/Israel/Hezbollah/Hormuz search feeds or a topic param) (§4).
5. Geo-scope `/api/intel/investigate` (and `/api/intel/agent`) to the region named in the query before reasoning — currently produces confident false negatives in-theater (§3.4).
6. Replay: add a date/range picker (§10.5) + state the ~24 h retention; add cold storage if multi-day replay is a goal (§5).

**Should-fix (correctness/robustness)**
7. Restore the documented `/ws/adsb` 20k hot-blob transport so the world view shows the full ~17 k snapshot, not 2,000 (§10.4).
8. Define `/api/me` or remove the frontend call (§7.3).
9. Wrap `/api/cyber/ioda/outages` upstream call so failures degrade to 502/empty, not 500 (§7.1).
10. Add `limit`/pagination (or compact-by-default) to `incident_history` so it doesn't exceed the MCP token cap (§6).
11. Guard `installHistoryPlayback` against StrictMode double-mount so only one `history-replay` datasource exists (§10.5).
12. Refresh/rotate the OpenSky authed credentials or stop advertising `opensky_authed:true` (§7.1).
13. Back dossiers with the 24 h `positions` DB so pattern-of-life isn't "insufficient" (§6).

**Nice-to-have**
14. Precompute/stream `/api/intel/lod1` (22 s) and `/api/cams` (18 s) (§7.2).
15. Fast-tier toggle for `/api/sim/reason` & `factcheck` latency (§3.3); debounce the `/api/timeline/density` poll (104 aborts/session, §10.8).
16. Fix the GDELT/events upstream or mark it degraded (§7.1).
17. Supabase: revoke anon EXECUTE on `rls_auto_enable()`; enable leaked-password protection (§8).
18. `vessel_dossier` should reuse the name/category cache that `query_vessels` has (§6).
