# Velocity (projectvelocity.org) — US–Iran dogfood + feature audit

**Date:** 2026-06-21 (~00:00–00:15 UTC)
**Operator persona:** conflict journalist, account `andrew@andrewyong.dev` (tier reported `enterprise`, status `active`).
**Surface tested:** the **hosted** product only — the live website, `https://projectvelocity.org/api/*` through the Cloudflare Worker with the account's Supabase JWT, and the **hosted** MCP at `https://projectvelocity.org/mcp` (JSON-RPC over streamable-HTTP). The local `uv run` MCP variant was **not** used, per the brief.
**Scenario:** US–Iran war + peace-deal coverage — ADS-B + maritime activity over the Strait of Hormuz / Persian Gulf / Iran; GPS jamming; drone & invasion simulations; satellite imagery; SAR→3D reconstruction; the agent/MCP.

> Honesty note: every number below was measured this session. Where a thing could not be tested, it says so. Marketing words ("global/complete") are avoided. A few findings may still be wrong — they are reproducible, so check them.

---

## 0. TL;DR — ranked findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | **Critical** | **Hosted MCP is non-functional for intel — 21/22 tools return `backend_401`.** The MCP front-door authenticates the *client* correctly, but the server's own self-hop to `http://localhost:8000/api/intel/*` is unauthorized. | `get_situation` → `{"error":"backend_401","url":"http://localhost:8000/api/intel/situation"}` (self-verified). |
| 2 | **Critical** | **Maritime is blind in the Gulf.** 0 vessels anywhere near Hormuz; the only keyless fallback (Sentinel-1 SAR dark-vessel) is **503**. The maritime half of a Hormuz story is unavailable end-to-end. | `/api/maritime/snapshot` 5,140 vessels, 0 in the Gulf; `/api/intel/dark-vessels/sar` → 503 "cdse credentials not configured"; AOI watch "Strait of Hormuz = 1". |
| 3 | **High** | **3D reconstruction is down in prod.** SAR→LOD1 building extrusion 503/500 for every AOI; no Iran AOI in the curated list anyway. | `/api/intel/lod1?aoi=beirut-dahieh` → 503; `…?bbox=<Hormuz>` → 500; landing page shows "0 buildings reconstructed / 0 collapse candidates". |
| 4 | **High** | **The LLM reasoning layer is slow and unreliable.** Three independent paths confirm it. | In-app agent: runtime **81.5s**, "the reasoning model did not return a clean final"; MCP `deep_analyze` fast tier **91s → `analysis:null`** ("deepseek call failed"); backend `/api/intel/agent` SSE hit 40s with no final event. |
| 5 | **High** | **Bulk export / ADS-B scoping ignore the bbox.** A journalist scoping to the Gulf silently gets the whole planet. | `/api/export?bbox=<Gulf>` byte-identical to no-bbox (6.07 MB, 11,648 feats, 113 in-bbox); `/api/adsb/global?bbox=<Gulf>` → 11,568 feats, 11,444 outside. |
| 6 | Medium | **Drone-swarm count silently clamps to 200** though the slider allows up to 2000. | Set Drones = 1000 → `AIRBORNE 200` (held; not mid-spawn). |
| 7 | Medium | **`/ws/alerts` WebSocket is down**, "alerts may be stale"; alerts buffer empty. | Persistent `WS · down` status pill all session. |
| 8 | Medium | **Aircraft dossier speed not clamped / ICAO collision** — a C-130 reported at Mach 1.8. | `/api/intel/dossier/aircraft/CNV3190` → `speed_kn.max = 1183.2`. |
| 9 | Medium | **IODA internet-outage signal is down** (502) and Cloudflare-Radar outages unconfigured — both war-relevant. | `/api/cyber/ioda/outages?entity=Iran` → 502; `/api/cyber/cloudflare/outages` → "CLOUDFLARE_TOKEN not configured". |
| 10 | Low | **App boot fires ~6 authed calls before the token is attached → 401 on first paint**; panels recover on next refresh. | Console: 401 on `news/analysis`, `jamming/alerts`, `imagery/catalog`, `intel/brief`×2, `intel/watch`, `timeline/density`; same endpoints 200 with token. |
| 11 | Low | **`/api/search` gazetteer returns empty** for named scenario places. | `/api/search?q=Bandar Abbas` → `{"results":[]}`. |
| 12 | Low | **`vessel_dossier` MCP schema rejects an integer MMSI** (typed `string`). | `vessel_dossier(422000000)` → "Input should be a valid string". |
| 13 | Low | **Landing-page "live snapshot" counters stuck at 0** (aircraft/vessels/jamming/incidents/feeds/agent-tools). | Marketing section shows `0` while the hero hard-codes 13,041 / 58. |

---

## 1. What works well (measured — credit where due)

The core observation/fusion stack is healthy; the failures are mostly at the *edges* (Gulf-specific feeds, the LLM step, the MCP deploy).

- **ADS-B union is healthy.** `/api/intel/situation`: **11,462–11,568 aircraft** (≥8k guardrail held), airborne ~10.2k, 27–38 military, 335 GNSS-degraded, 0 emergencies. Globe rendered thousands of correctly-categorised SVG icons at 14 fps world / 59–74 fps zoomed.
- **GPS jamming + emitter geolocation is real and correctly placed over the Gulf.** Intel tab localized an emitter at **≈ 23.74, 59.66 ± 31.3 km** (Gulf of Oman, off the Iranian coast) and flagged cells like `[58,24] 44/44 aircraft degraded`, `[59,22] 22/44`, `[58,22] 21/21`. This is the GPSJam (NACp/NIC) method working live in-theatre.
- **Cross-domain fusion geo-scopes correctly** (contradicts a prior session's "not geo-scoped" note): `/api/intel/brief?bbox=<Gulf>` → 8 incidents, **all 8 inside** the bbox; `/api/intel/investigate?bbox=<Gulf>` → 8 incidents, **all centroids in Hormuz**; `/api/intel/aircraft?bbox` → all returned contacts in-bbox.
- **News corroboration / debias engine is genuinely useful for a journalist.** The News tab scored each headline by outlet corroboration: *"Iran claims Strait of Hormuz closure"* → **0 % · SINGLE SOURCE · 0 outlets** (correctly flagged uncorroborated); *"US & Iran schedule talks in Switzerland"* → **55 % · ✓ CORROBORATED**. `/api/news/analysis` is Iran/war-filtered (5 of 7 events). `/api/news/factcheck` returned a sourced "misleading" verdict.
- **War-game Attack mode is the standout feature.** Real strike catalog (Shahed-136/Geran-2, IAI Harop, ZALA Lancet-3, Switchblade 300/600, Bayraktar TB2, MQ-9, F-35A, Su-35, …) vs a real air-defence catalog (S-300, S-400, Pantsir-S1, Patriot PAC-3, THAAD, Iron Dome, NASAMS, …). A 20-unit Shahed-136 run produced a probabilistic BDA — **INTERCEPTED 5.2, LEAKERS 14.8, "74 % leak", DEFENCE CAPACITY 8** — plus an **economic-impact** model (oil **+10.4 %**, **$1.9 B/day** trade disrupted at Hormuz) and a geo-aware LLM "analyst assessment" that correctly named Bandar Abbas, the 50 kg warhead, and rated escalation HIGH.
- **EW/link realism in Swarm mode.** FPV-RF control over a ~75 km corridor → 10 of 12 drones "LINK LOST / EW"; switching to MALE-satcom → 0 link losses. Range-aware control model.
- **Tiles are healthy.** `/tiles/basemap`, `/tiles/sat`, `/tiles/terrain` all 200 (basemap z4 in 60 ms, 27 KB). Negative API tests return clean **422** (no 500s) on bad input.
- **The in-app analyst console degrades gracefully** — when the LLM final fails, it still shows the 6 cited fused incidents rather than erroring out.

---

## 2. BUGS (specific, reproducible)

**B1 — Hosted MCP self-hop is unauthorized (21/22 tools dead).** `tools/call` for every proxying tool returns
`{"error":"backend_401","detail":"{\"detail\":\"unauthorized\"}","url":"http://localhost:8000/api/intel/…"}`.
Layering proof: a garbage Bearer → MCP `initialize` HTTP 401; the account JWT → 200; `/api/health` → 200 (backend up); the same `/api/intel/situation` serves 200 to the website with the JWT but 401 to the MCP self-hop. So the backend rejects whatever credential the MCP server presents. This matches the documented deploy requirement (the container needs `API_KEY` for the self-hop **and** `SUPABASE_JWT_SECRET`) — one or both are unset/wrong in prod. **This is the single most important finding** because the MCP is exactly what the brief asked to exercise, and it is the product's advertised agent surface.

**B2 — `/api/intel/dark-vessels/sar` → 503** "cdse credentials not configured". The project's own guardrail calls this "the only keyless vessel coverage for the Strait of Hormuz." For the Iran scenario it is dead, and the UI still lists the Hormuz/Bab-el-Mandeb/Gulf-of-Aden/Suez SAR layers as available.

**B3 — `/api/intel/lod1` 503 (curated) / 500 (bbox).** `?aoi=beirut-dahieh` → 503; `?bbox=53.18,27.45,59.82,30.30` (Hormuz, from "Load 3D buildings here") → 500. No buildings or collapse candidates ever render. The headline "SAR damage → LOD1 3D" capability is unavailable in prod (consistent with the landing page's own "0 reconstructed / 0 candidates").

**B4 — `/api/export` ignores `bbox` and `layer`.** `?format=geojson&layer=aircraft&bbox=<Gulf>` returned byte-for-byte the same 6,074,407-byte body as the no-arg export (11,648 features, only 113 in the Gulf). You cannot export an AOI; "export the Iran picture" dumps the planet.

**B5 — `/api/adsb/global` drops a supplied bbox.** With `min_lon=47&min_lat=24&max_lon=57&max_lat=30&limit=5000` it returned 11,568 features, 11,444 outside the bbox. (The no-bbox world view shipping whole is intentional; a *supplied* bbox being ignored is the bug.)

**B6 — Swarm drone count silently clamps to 200.** Slider `max=2000`; set 1000 → `AIRBORNE 200` and held there (STRUCK 0 / LINK-LOST 0 with satcom, so not attrition). The UI implies up to 2000; the engine simulates ≤200. (Prior memory's "1000 impossible" persists; the cap moved 60→200 but the slider/engine mismatch remains.)

**B7 — `/ws/alerts` WebSocket down.** Persistent `WS · down` ("alerts may be stale"); the Alerts buffer stayed empty (0 critical/high/medium/low) even though the bottom bar showed 100+ "alerts" accruing. Alerts are not reaching the panel over the socket.

**B8 — Aircraft dossier speed not clamped / ICAO collision.** `/api/intel/dossier/aircraft/CNV3190` (type C130) → `speed_kn.max = 1183.2` (~Mach 1.8), profile "loiter-then-dash", 9,156 km over 4,513 fixes. Either a teleport-across-gap speed or one hex mapped to multiple airframes; the pattern-of-life a journalist would cite is corrupted.

**B9 — IODA outage signal 502 / Cloudflare outages unconfigured.** `/api/cyber/ioda/outages?entity=Iran` → 502 (origin error, 16.7 s); `/api/cyber/cloudflare/outages` → empty, "CLOUDFLARE_TOKEN not configured". Internet-shutdown detection — a primary war indicator — is unavailable.

**B10 — Boot auth race.** On first paint the app fires `news/analysis`, `jamming/alerts`, `imagery/catalog`, `intel/brief` (×2), `intel/watch`, `timeline/density` **before** the Bearer is attached → six visible 401s; the same endpoints 200 once the token is present. Panels show empty/error until the next refresh.

**B11 — `/api/news/analysis` intermittently 524.** Returned 200 in ~1.8 s early on, then a Cloudflare **524** (origin timeout > 100 s) on a later refresh. The news agent is heavy (348 headlines / 12 sources / 5 steps) and occasionally blows the Worker timeout.

**B12 — `/api/search` empty for named places.** `?q=Bandar Abbas` → `{"results":[]}` (14 bytes). The gazetteer/entity search doesn't resolve obvious scenario locations; the lat,lon search box also did **not** re-fly the camera when I entered Tehran coords (camera stayed on the prior AOI).

**B13 — `vessel_dossier` MCP schema bug.** `mmsi` is typed `string`; passing the natural integer `422000000` is rejected with "Input should be a valid string" before the call runs. Agents will send numeric MMSIs and always trip it.

**B14 — `/api/intel/emitter` has no required-arg guard.** Omitting lat/lon returns a 200 "global" emitter with a nonsense `cep ≈ 7,304 km` instead of 422 — easy to misread as a real fix.

**B15 — Landing-page "live" counters stuck at 0.** The `05 — LIVE` snapshot and several section stats render `0` (aircraft, military, vessels, jamming, incidents, cables, "fused feeds", "agent tools (MCP)", "buildings reconstructed"). The count-up animation/fetch isn't firing while the hero hard-codes 13,041 / 58.

---

## 3. MISSING (the scenario needed it; there is no feature/param)

- **Any vessel coverage near Iran.** AIS is Baltic/Northern-Europe only (Digitraffic FI / Kystverket / AISStream). `query_vessels(bbox=Gulf)` correctly returns 0 because there is nothing to return. With the SAR fallback 503 (B2), there is **no working maritime feed for a tanker-war / Hormuz story** — the AOI watch makes this stark: Hormuz/Bab-el-Mandeb/Suez/Gibraltar/Panama all show **1** contact while Skagerrak shows **516** and Malacca **75**.
- **A geo-scope on `/api/jamming/alerts`.** It returns 50 alerts with no bbox/lat-lon filter, and currently **0 of them fall inside Iran** — even though `/api/intel/emitter` and `/api/intel/jamming` find dense Hormuz jamming. The alert feed and the intel-jamming feed disagree on *where* jamming is, and you can't scope the alerts to the strait.
- **An Iran AOI in War-damage 3D.** The curated list is Beirut, S. Lebanon, Gaza, Khan Younis, Rafah, Mariupol, Bakhmut only. There is no Natanz/Bushehr/Bandar Abbas/Tehran preset, and the "Load 3D buildings here" path 500s (B3), so a journalist cannot reconstruct an Iranian facility at all.
- **Multi-day / dated replay.** Replay is a "~24 h rolling buffer … no cold storage." A war + peace-deal timeline spans weeks; there is no date picker and nothing older than ~24 h.
- **Time/geo scope on fact-check.** `fact_check(claim)` takes only free text — no `as_of` or lat/lon to bound the verification window.

---

## 4. NEEDS-EXTENSION (works, but too shallow / capped / slow for the job)

- **LLM reasoning latency + reliability** (see F4). The flagship "ask the planet a question" feature took 81.5 s and fell back to a template; `deep_analyze` fast tier hung 91 s → null. It needs a hard upstream timeout, a fallback model, and a contract that distinguishes "no data" from "LLM failed."
- **`/api/intel/aircraft` caps at 50 returned** (124 matched over the Gulf). A journalist sees < half the traffic; no honored page/limit param surfaced.
- **High fusion-route latency:** brief 14.5 s, watch 14.2 s, investigate 20.4 s, factcheck 19.4 s, aircraft dossier 34.7 s, **vessel dossier 45.2 s** (first attempt timed out at 40 s). The dossiers are effectively unusable interactively.
- **`/api/news/analysis` is thin** — 7 events for a running two-front conflict (it *is* correctly filtered, just shallow), and heavy enough to 524 (B11).
- **`/api/adsb/live/emergencies` took 17 s to return an empty FeatureCollection** — disproportionate for an empty result.
- **Incident history is fixed at `window_hours: 6` / 30 snapshots** — no way to pull a multi-day history (couples to the missing cold storage above).
- **Feed-health panel tracks 5 groups** (aviation.adsb ×3, usgs ×1, maritime.keyless ×1) against a marketed **58 feeds** — most of the catalog isn't surfaced as live health, so an operator can't see at a glance what's actually flowing.

---

## 5. "Is it possible?" — simulation vs the real world & terrain

The brief asked to run drone/invasion sims and judge feasibility against terrain and reality. What the platform can and can't support:

**What the sim does well.** The **Attack** model is grounded in real systems and gives a defensible quantitative answer. For a 20-ship Shahed-136 salvo at Hormuz it returned a ~26 % intercept / ~74 % leak rate against a thin (2× Avenger) defence, then layered an economic read (oil +10.4 %, ~$1.9 B/day) — all consistent with real-world facts (Iran fields Shahed-136/Geran-2; the Gulf states and US field Patriot/THAAD/NASAMS; Hormuz carries ~20 % of seaborne oil with no easy bypass). The **Swarm** EW model is range-aware in a realistic way (FPV-RF loses control at distance; satcom doesn't). So as a *first-order* feasibility/escalation tool, "is it possible" gets a credible, cited answer.

**Where feasibility is NOT actually modelled — terrain.** This is the real gap for the brief's "compare to terrain" ask:
- `/api/config` reports `cesiumIonToken: ""` and `enableGoogle3D: false`. The 3D scene showed **no terrain relief** in the AOI; the only imagery under the camera was low-resolution Sentinel-2 (≈ z14 cap) — a blurry blob at facility scale.
- The sim's **"Nap-of-earth — terrain-follow + LOS masking"** toggle is explicitly labelled "(needs 3D terrain)". With no terrain elevation loaded, terrain-following and line-of-sight masking have nothing to compute against. So the sim can *say* a drone hugs the terrain, but it isn't masking against real elevation — the headline "compare to terrain, is it possible?" question can't be fully answered in the hosted build.
- The **Landing (invasion) mode is under-built**: its only parameters are Speed and Start-alt — no force size, waves, craft/troop count, or beachhead geometry (Swarm at least has a count). It's a single glide vector, not an amphibious/air-assault model.

**Net:** the sim answers feasibility *statistically and economically* well, but not *geographically* — it lacks the 3D terrain it advertises, so terrain-masking, LOS, and facility-level targeting are aspirational in prod.

---

## 6. What I could NOT test, and why

- **MCP intel data quality / overflow** — blocked by the universal `backend_401` (B1); no proxying tool returned data. Re-run the 22-tool suite once the MCP credential is fixed.
- **SAR→LOD1 building/candidate counts** — `/api/intel/lod1` 503/500 everywhere (B3).
- **Actual before/after imagery diff** — `/api/imagery/aoi` returned (14.7 s) but Maxar is event-gated → empty over Natanz; I didn't exercise a Sentinel date known to be covered.
- **Whether the LLM agent ever returns a clean final under load** — it didn't in 3 attempts; it may on a quiet AOI.
- **Satellite (CelesTrak) layer visually** — backend `/api/space/gp?group=stations` is healthy (TLE), but I didn't toggle the orbit layer on the globe.

---

## 7. Suggested fix order (cheapest-impact first)

1. **Fix the MCP backend credential** (B1) — restore `API_KEY`/`SUPABASE_JWT_SECRET` on the backend so the self-hop authenticates, or have the MCP forward the caller's JWT. Unblocks the entire agent surface.
2. **Configure CDSE creds** (B2/B3) — restores Hormuz SAR dark-vessels *and* the LOD1 3D path, the two most scenario-relevant dead features.
3. **Honor `bbox` on `/api/export` and `/api/adsb/global`** (B4/B5) — core "scope to my AOI" workflow.
4. **Put a hard timeout + fallback on the LLM step** (F4/B11) and stream a final-or-error contract.
5. **Reconcile the drone slider with the engine cap** (B6) and **fix the boot auth race** (B10).
6. **Add a geo-scope to `/api/jamming/alerts`** and at least one Gulf AIS source (paid feed / own receiver) so the maritime half exists.

---

## 8. The article I could actually file

> Written the way the tool encourages — claims tagged by what Velocity could and couldn't corroborate this session. Everything attributed to "Velocity" is a live reading at ~00:10 UTC 2026-06-21.

**Jamming, not ships: what an open-source globe could (and couldn't) see in the Hormuz crisis**

As Tehran and Washington traded a closure claim and a peace-talks announcement this week, I put the open-source picture through Velocity, a hosted intelligence globe, to see how much of the story is visible from public sensors alone.

The clearest signal was electronic, not naval. Over the Strait of Hormuz and the Gulf of Oman, Velocity's GPS-jamming layer — built from aircraft self-reported navigation integrity — lit up: cells off the Iranian coast where **44 of 44**, **21 of 21**, and **22 of 44** tracked aircraft reported degraded GNSS, and a fused incident localising a jamming emitter to roughly **23.7 °N, 59.7 °E (± 31 km)**, in the Gulf of Oman. The platform promoted that to its top "high" incident automatically, correlating the GPS loss with an AIS gap in the same waters.

The aircraft picture was rich — Velocity was tracking ~11,500 aircraft worldwide, a few dozen flagged military — but the **maritime picture over the Gulf was essentially empty**: the platform's AIS coverage is concentrated in Northern Europe, and its keyless radar fallback for Hormuz was offline during my session. So for the specific question everyone is asking — are tankers actually still moving through the strait? — this tool could not show me the ships. Worth stating plainly rather than implying coverage that wasn't there.

On the claims themselves, the platform's news desk was useful precisely because it refused to take sides: Iran's "Strait of Hormuz closed" announcement scored **0 % corroboration — a single source, zero corroborating outlets**, while the **US–Iran talks in Switzerland** scored **55 %, corroborated** across multiple outlets. The headline drama was the least-supported claim; the diplomacy was the better-sourced one.

Finally, the "is it possible" question. Velocity's war-game put a 20-strong Shahed-136 salvo against a light Gulf air defence and estimated roughly a **quarter intercepted, three-quarters leaking through**, with a knock-on of about **+10 % on oil and ~$1.9 B/day** of disrupted trade if the strait were truly contested — a plausible first-order read, given Iran's drone inventory and Hormuz's ~20 % share of seaborne oil. What it could not do was test the *terrain*: with no 3D elevation loaded, its own "fly nap-of-the-earth, mask line-of-sight" feature had nothing to hide behind. The escalation maths is credible; the geography is still aspirational.

The honest verdict on the tooling: the cross-domain *fusion* — jamming, aircraft, news corroboration, an escalation model — is real and fast. The gaps are at the edges that this particular crisis needs most: ships in the Gulf, and ground truth on the map.
