# Project Velocity — Bug-Fix Round-Trip (fix + re-stress-test)

**Follow-up to** `velocity-stress-test-2026-06-20.md`. **Method:** 3 background workflows — (1) investigate (8 read-only agents mapping each bug → file:line + fix spec), (2) fix (11 agents, **one owner per file**, disjoint → safe parallel, per CLAUDE.md), (3) second-pass fix for 2 regressions + verify. Backend restarted between rounds; every fix re-probed live via the MCP tools + backend.

**Quality gates after all changes: `pytest` 260 passed, `pnpm -r typecheck` green** (verified by the workflow verify-stage, twice).

---

## Scorecard — 11 of 11 addressed, all verified live

| # | Bug (from stress test) | Status | Live evidence (before → after) |
|---|---|---|---|
| A | `fact_check` MCP "broken" (thought POST→GET 405) | **Not a bug** (corrected) | Wrapper is already GET `?claim=` (`mcp_server.py:733`→`_get`). The 405 was *my* manual `-X POST` curl; the real failure earlier was a transient cold-start timeout mislabeled "backend_unreachable". Re-tested warm → `verdict:true, conf 0.9`, cited. |
| B | Dark-vessel label false ("SAR radar contact with no matching AIS" for AIS-broadcasting vessels) | **Fixed ✅** | `intel_brief`: old `"dark/AIS-off"` **absent**, old `"SAR radar contact…"` **absent**, new `"incomplete AIS identity"` **present**. (`incidents.py` strings; `analytics.py` condition was already correct, untouched.) |
| C | Military under-tagged (MCP=5, missed AWACS/tankers) | **Fixed ✅** | `query_aircraft(military)` **5 → 30**; now correctly typed C17/C130J/A400/A124/KC-46/F900/B737-Navy with callsigns RCH/CFC/PAT/RRR/GAF/CNV. (`geo.py` classifier: FAA mil hex `0xADF7C8–0xAFFFFF` + mil type codes + mil callsign prefixes; `adsb.py` tags `source="adsb_mil"`.) |
| D | Airport ground objects emitted as `airliner` | **Fixed ✅ (with caveat)** | `SWEEPER2/AGL08/LDR9/GO*/TWR/GND` (ADS-B emitter category C0–C3) now filtered out of Hormuz. Parked real airframes with blank callsigns (`@@@@@@@@`, type A21N) correctly **retained** (they are aircraft). Caveat: the OpenSky breadth tier (`opensky.py states_to_geojson`) bypasses `_aircraft_geojson`, so OpenSky category 16–19 surface objects aren't filtered — but /states/all doesn't emit airport ground vehicles; an `opensky.py` follow-up would close it fully. |
| E | `aircraft_dossier` speed math (0 kn over 276 km) | **Fixed ✅** | Two-pass: removing the dt guard first over-corrected to `max 102318 kn`; final clamp (`MIN_SEG_DT_S=5s` floor + `MAX_PLAUSIBLE_KN=1200` ceiling) → KC-46 `ae63b5` (gnss-degraded, spoof jumps) now `max 492.7 kn`, sane. (`dossier.py _track_stats`.) |
| F1 | `focus_area` silent snapshot-fallback (no freshness warning) | **Fixed ✅** | Hormuz bundle now returns `"degraded":true,"freshness_note":"Served from the global ~2s snapshot … NACp/NIC may be null so jamming detection is degraded."` (`analytics.py area_intel`, `aoi.py fetch_area`). |
| F2 | Threat score doesn't encode coverage (blind zones read "low") | **Fixed ✅ (additive)** | `intel_brief` now carries `coverage_confidence: low` for maritime-relevant briefs outside Northern Europe; `anomalies` gains `coverage_confidence`. Scores/thresholds untouched (no test breakage) — confidence is *surfaced beside* the level, the intended design. (`incidents.py`, `analytics.py`.) |
| G | `/api/sim/reason` unauth + no rate limit | **Fixed ✅** | `@router.post("/reason", dependencies=[Depends(require_api_key)])` (`simulation.py:56`) — gated when a key is configured, permissive in keyless local (consistent with the rest of the app). |
| G | 566 MB `langat2_recon` untracked & not gitignored | **Fixed ✅** | `git check-ignore` → `.gitignore:54 apps/ml/fusion/langat2_recon/` (+ `*.mp4`, colmap/dense, gsplat_repo, output). `git add -A` footgun closed. |
| H | Dead sign-in gate ("globe stays blank") in keyless mode | **Fixed ✅** | Reload: `signInBlankCopyPresent:false` while globe is full (adsb 1996 / maritime 2000). Overlay now suppressed when live data is present. (`App.tsx AuthNotice`.) |
| H | `/ws/alerts` WebSocket error spam (keyless) | **Fixed ✅** | Console **3 → 2 warnings**; the `/ws/alerts "closed before connection established"` entry is gone (skips the socket when no key). 0 errors. (`AlertSubscriber.tsx`, guards on `hasApiKey()`.) |
| H | CelesTrak orbital layer undiscoverable | **No code change** | The `space.celestrak.*` layers already render in the layer rail under the **Space** group (off by default); they're just distinct from the "3D sat" basemap button. Documented, not a code defect. |

---

## What was deliberately NOT changed (out of scope for "fix the bugs")

These stress-test findings are **data-availability / design limits, not code defects**, and aren't fixable by editing this repo:

- **Global AIS / naval blindness in conflict theaters** — needs a keyed/commercial AIS feed (AISStream always-on or Spire/GFW). Code can't conjure coverage.
- **Spoofing detection in Hormuz/E-Med** — `detect_deception` is data-bound (needs AIS + track history absent there); the NACp method detects jamming not spoofing. A real spoof detector is a feature, not a bug-fix.
- **VHR/BDA imagery** — Maxar event-gating is upstream; surfacing `sar_damage.py` as a tool is a feature add.
- **`aircraft_dossier` shallow history (~1h)** — the *speed math* bug is fixed; deeper retention is a storage design change.

The F2 coverage-confidence fix is the *additive* first step toward the P1 critique (blind-vs-quiet); it exposes confidence without rewriting the scoring model.

---

## Files changed (working tree — tests green, not committed)

Backend: `apps/api/app/intel/incidents.py`, `intel/analytics.py`, `intel/geo.py`, `intel/dossier.py`, `intel/aoi.py`, `routes/adsb.py`, `routes/simulation.py`. Repo: `.gitignore`. Frontend: `apps/web/src/App.tsx`, `alerts/AlertSubscriber.tsx`. (`layer-rail/LayerRail.tsx` inspected, no change needed.)

**Net:** 10 real bugs fixed + verified, 1 false alarm corrected (fact_check), both quality gates green. Ready to commit on request.
