# PREFLIGHT — pre-release checklist & readiness review

_Generated 2026-06-16. Status lines are **measured**, not asserted (per CLAUDE.md:
no "global/complete/polished" without a probe that turn)._

> **Brand:** Velocity — projectvelocity.org · **License:** AGPL-3.0-or-later

## Shipped this pass (2026-06-16)

- ✅ Named **Velocity** (README title, `index.html`, showcase line).
- ✅ **AGPL-3.0** `LICENSE` + `NOTICE` (per-upstream attribution incl. NC feeds).
- ✅ `GET /api/export` (GeoJSON + CSV, bbox clip) — verified live (9,283 aircraft).
- ✅ `/api/intel/sources` honesty fields (`key_gated_note`, `degraded`).
- ✅ README: ephemeral-state callout, keyless-vs-keys table, honest "58 feeds".
- ✅ `.gitignore` guard for `opencode.jsonc` / `*.env`.
- ✅ **Boot + visual QA** — globe renders thousands of category-colored aircraft,
  0 console errors. Hero screenshot captured.
- ✅ **Round 2 (improve):** KML export + export `limit`; `/api/space/gp` cap;
  `/sources` lists all 7 key-gated feeds; favicon → console errors 1→0.
- ✅ Gates green after all changes: **210 pytest pass**, ruff clean, tsc clean.

## Rigorous audit — verified live (2026-06-16)

Re-reviewed adversarially against the running stack (api :8000 + web :5173).

- **API surface (20 endpoints hit live):** all 200 with real data — mil 139,
  jamming 200 cells, brief **25 fused incidents**, keyless vessels 4,668,
  digitraffic 1,061, satellites 15,697, quakes 249, cables 714, news 259, export
  (geojson+csv) verified. Two first-pass "issues" cleared: `events/all` 422 =
  correct required-param validation (frontend calls it right); cyber outages
  `{items:[],note:"CLOUDFLARE_TOKEN not configured"}` = correct graceful-degrade.
- **Fusion depth — NOT stubs (read the code):** incidents = ≥2-domain convergence
  + union-find/seed clustering + cited narrative; jamming = real GPSJam rule
  (nac_p<8/nic<7, 1° bins); emitter = severity-weighted centroid + CEP, honestly
  labelled "not RF DF, ~tens of km"; deception = dup-MMSI/teleport/spoof-cluster;
  baseline = rolling z-score. The DEEP labels hold.
- **Honesty sweep — clean:** no unbacked global/complete/parity claims in
  code/docs; `events.py` explicitly disclaims completeness.
- **Security — clean:** no eval/exec/os.system/shell=True/pickle/yaml.load/
  verify=False; subprocess is list-form uvicorn spawn; SSRF surfaces gated
  (cams = server catalog, imagery = provider whitelist + date validation); auth
  uses timing-safe `compare_digest`; both WS handlers `require_ws_key` BEFORE
  `accept`; SQLite fully parametrized (the f-string WHERE holds only literal
  clauses + `?`).
- **Interaction QA — PASS** (deferred CLAUDE.md mandate, proven via `__viewer`):
  click → panel + magenta track ≤4s; click-empty → clears; 15s soak → no blink.

**Findings:**
1. _(open — coverage limitation)_ Vessel AIS is REGIONAL (N. Europe/Baltic, ~4.7k
   keyless). The Strait of Hormuz marquee case has **0 keyless AIS** — dark
   vessels there are SAR-only. README table is honest; keep launch copy honest.
2. ✅ FIXED — `/api/space/gp` now takes `limit` (default 2000) + reports
   `count`/`returned`; full set stays cached, truncated per request so
   satellite.js can't choke on ~16k orbits. Unit-tested.
3. ✅ FIXED — `/api/intel/sources` `key_gated` now lists all 7 gated feeds (added
   `acled_events`, `cloudflare_outages`, `openaip`). Verified live + tested.
4. _(new, open)_ `/api/space/gp` has **no stale-on-failure fallback**: when the 2h
   cache misses and CelesTrak 403s a datacenter IP (observed live), the layer 502s
   instead of serving the last good set. Mirror the ADS-B sticky-snapshot pattern.

## Measured snapshot

| Metric | Value | How measured |
|---|---|---|
| Age | 6 days | first commit 2026-06-10 → 2026-06-16 |
| Commits | 98 (93 primary author) | `git log` |
| Velocity | ~16 commits/day, peak 41 (06-14) | `git log` cadence |
| Code | ~24.2k LOC (web 10.4k TS/TSX + api 13.8k Py) | `wc -l` |
| Backend routes | 31 modules (added export), ~60 endpoints | route grep |
| Agent API surface | 20 `/api/intel/*` endpoints + 22 MCP tools | route grep + README |
| Fusion engine | 13 modules, 2.8k LOC | `wc -l app/intel` |
| Upstream sources | 58 distinct hosts (~45 logical) | host grep |
| API tests | **210 passed in ~2.2s** (was 199; +11 export/space/sources) | `pytest -q` |
| Type safety | web + shared `tsc --noEmit` **clean** | `pnpm -r typecheck` |
| Live aircraft (boot) | 9,283 and climbing toward ~13k | live `/api/adsb/global` |

**Verdict: the spine is real, tested, and runs.** Gaps below are
go-to-market/hardening, not "does the core work."

## Go / No-Go by release type

- **Show HN / open-source launch (self-host):** GO after remaining P1 (demo +
  video). The story (keyless multi-INT fusion + AI-agent MCP) is launch-worthy.
- **Hosted public demo:** NO until the abuse/cost guard lands — a public
  Cesium+upstream-proxy box gets hammered and rate-limited.
- **"Beat Flightradar24 / MarineTraffic":** NO, ever. Wrong frame — you lose every
  single-domain silo. Position on fusion + agent access.

## P0 — blockers before ANY public release

- [x] **Boot + visual QA + interaction** — DONE 2026-06-16, verified live via
      `window.__viewer`. Globe renders ~4.1k category-colored aircraft (yellow
      airliners, red emergency — NOT dots), 9,049 total entities, 0 console errors.
      Click aircraft → EntityPanel + magenta `#d946ef` track (800 pts) ≤4s; click
      empty → clears; 15s soak → count flat (4116), pinned id persists (upsert, no
      blink). Two hero shots captured.
- [x] **Name chosen: Velocity** (projectvelocity.org) — stamped in README title,
      `index.html`, showcase line. Internal `@osint/*` pkg names left as-is.
- [x] **Secrets hygiene — verified clean.** No API key committed or in git history
      (tracked-tree grep + `git log --all -S`). A prior *untracked* `opencode.jsonc`
      held a DeepSeek key; not in the repo. Guarded via `.gitignore`. Rotate that
      key if it ever left this machine.
- [x] **Persistence story stated.** README opens with an unmissable "Phase-1 state
      is ephemeral" callout. Shipping real persistence = Phase 2 (deferred).
- [x] **LICENSE + NOTICE shipped.** AGPL-3.0 + per-upstream attribution; `license`
      field set in all 3 `package.json` + `pyproject.toml`.

## P1 — should-fix for a credible launch

- [ ] **Hosted 2D-dark demo** (no GPU needed) behind a rate-limit. 3D mode wants
      20GB VRAM (README honest about this) — don't make first contact require an
      RTX 4070. 2D-dark on integrated graphics is the funnel.
- [ ] **One killer 60s video**: type a question to the MCP agent → globe answers
      (jamming cells light up / dark vessel flagged). The viral unit.
- [ ] **Abuse/cost guard** for hosted: per-IP rate limit + upstream budget caps.
      _DEFERRED — needs care: slowapi was removed before (CLAUDE.md); revisit
      together with the hosted-demo work so it's tested, not bolted on._
- [x] **`/api/intel/sources` honesty** — added `key_gated_note` ("set ≠ working")
      + a `degraded` block for datacenter-IP-dead firehoses. Verified live.
- [x] **Export** — `GET /api/export?fmt=geojson|csv|kml&kinds=&bbox=&limit=` with
      download headers; geojson + csv + **kml** (Google Earth/GIS) verified live;
      `limit` bound added. 6 hermetic tests. _PDF still open._
- [x] **README keyless-vs-keys table** — "What you get with zero keys".

## P2 — nice-to-have / post-launch

- [ ] Saved workspaces / shareable deep-link view URLs.
- [ ] Replay / time-scrub (Phase 2) — timeline route exists, no persisted history.
- [ ] Annotations / drawing / measurement tools.
- [ ] Multi-user auth + roles (today: single shared API key by design).
- [ ] Mobile/responsive 2D fallback (today: desktop WebGL2 only).
- [ ] A11y pass (keyboard nav, contrast, reduced-motion).
- [ ] Onboarding empty-state + guided "tour the Black Sea / Hormuz".
- [ ] Export: add KML + a brief PDF situation report.

## Feature depth — honest tiers

- **DEEP (production-grade, multi-source, failover, tested):** ADS-B pipeline
  (1.5k LOC, OpenSky breadth ∪ airplanes.live grid, dedup, failover, ~13k
  aircraft, NACp/NIC jamming); cross-domain incident fusion; intel analytics; MCP
  (22 tools, e2e-tested, hosted at /mcp).
- **SOLID:** AIS (Digitraffic + keyless + AISStream WS), SAR dark-vessels, GPS
  jamming, dossiers, deception detection, emitter geolocation, baselines, LOD1 3D.
- **MEDIUM:** events (GDELT/ACLED/EONET), news + fact-check, cyber outages,
  webcams, imagery.
- **THIN / degraded-by-design:** FIRMS + ACLED (key-gated), single-shot firehoses.

The "58 sources" is **breadth**; the **moat is the ~10 deep ones + fusion + the
agent API.** Lead with depth, not source count.

## Launch kit (showcase)

- One-liner: _"An all-source intelligence globe that fuses aircraft, ships,
  satellites, SAR, GPS-jamming, cyber outages and news into one live picture —
  free, keyless, self-hostable — and hands the whole thing to an AI agent over
  MCP."_
- 3 hero screenshots: (1) global ADS-B + jamming heat; (2) Hormuz dark-vessel SAR
  flag; (3) war-damage LOD1 3D. (#1 captured this pass.)
- HN title idea: _"Show HN: I gave an AI agent eyes on the whole planet — free,
  no API keys"_.
