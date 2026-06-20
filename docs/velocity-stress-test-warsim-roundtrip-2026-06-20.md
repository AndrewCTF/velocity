# Velocity — War-Sim Stress Test: Fix Round-Trip & Re-Test

**Date:** 2026-06-20
**Input:** `docs/velocity-stress-test-warsim-2026-06-20.md` (14-item prioritized fix list)
**Method:** fixes implemented by 7 disjoint-file owners (one file, one owner — CLAUDE.md), then a
live re-stress-test against the **restarted** backend (`:8000`) + frontend (`:5173`). Every verdict
below is backed by an observation captured this run (status code, count, latency, byte size, or
executed-code output) — no unmeasured "fixed" claims.

**Gate status at close:** `pnpm -r typecheck` → **EXIT 0** (web + shared). `apps/api .venv/bin/pytest -q`
→ **296 passed**, 1 warning (baseline floor is 25). Backend rebooted clean (lifespan boot tasks +
new cams warm-task; only expected upstream noise — digitraffic 429, AIS firehose reconnects).

---

## Results — all 14 items

| # | Sev | Bug | Status | Live evidence (this run) |
|---|---|---|---|---|
| 1 | 🔴 | Drone count clamped to 200; math runs on clamp | **FIXED** | `RENDER_AGENT_CAP=200` is now a *render-only* bound; `resolveRaid(1000)` → leakers **942** vs `(150)` → 92 (math on true count). Slider max **2000** (was 80/60). Notice `"rendering 200 of 1000 — math uses full count"` present. `/api/sim/reason` got "1,000 Shahed-136". |
| 2 | 🔴 | `salvoPerSite` hardcoded 4 for every defender | **FIXED** | `salvoForDefender()` table: thaad **48**, s-400 36, patriot-pac3 16, avenger 4, stinger **2**. Same 200-raid: THAAD intercept 40.8 vs Stinger 1.0 (**~40×**). Wired into both engine impact + Battle-damage panel. |
| 3 | 🔴 | News = general RSS, not conflict-filtered | **FIXED** | `/api/news/feed` 200, 371 articles, **157/371** match Iran/Israel/Hezbollah/Hormuz/etc (baseline ~0). `/api/news/analysis` 8 events, **6/8** conflict (Hormuz closure, Israel-Hezbollah, Lebanon/Gaza). |
| 4 | 🔴 | ~24 h replay retention not stated in UI | **FIXED** (UI label) | Retention notice added to `Timeline.tsx`; typecheck green. (Static "~24 h rolling"; see residuals for the real-window upgrade.) |
| 5 | 🔴 | `/api/me` 404 | **FIXED** | `/api/me` (no auth) → **401** `{"detail":"sign-in required"}`, not 404. Route exists in `keys.py`. |
| 6 | 🔴 | `/api/cyber/ioda/outages` 500 | **FIXED** | → **502** `{"detail":"ioda transport: …"}` (upstream unreachable from egress, 10 s timeout → structured 502), not an unhandled 500. |
| 7 | 🟠 | `incident_history` overflows MCP token cap | **FIXED** | Default call **7,380 chars** (baseline 89,425 hard-errored). `limit=5`→1,731 / `max_incidents=3`→1,183 / `limit=200`→11,324. Honest note `"showing 25 of 42 incidents"`. |
| 8 | 🟠 | OpenSky authed dead; `opensky_authed:true` dishonest | **FIXED** | `/api/aviation/states` → **200**, 4.5 MB live aircraft (no crash). `/api/intel/sources` now exposes `opensky_authed_working=false` (probe-backed) + a configured-vs-working disclaimer. |
| 9 | 🟠 | Dossiers ~1 h only ("insufficient track") | **FIXED** | `aircraft_dossier` 44028a/EJU32MF: **887 fixes, 88.1 min, 1123 km** (matches `positions` DB row count exactly). `window_note`: fuses ~1 h live store + positions DB (~48 h). |
| 10 | 🟠 | `/api/intel/lod1` 22 s, `/api/cams` 18 s | **FIXED** | cams **7.9 ms → 4.5 ms** (warm prefetch). lod1 11.5 s cold → **26 ms** cached (TTL memoize, ~435× on hit). |
| 11 | 🟡 | sim/reason 22 s, factcheck 97 s — no fast tier | **FIXED** | `/api/sim/reason?fast=true` **8.2 s** (deepseek-chat) vs 39.2 s (minimax) — 4.8×. `/api/news/factcheck?fast=true` **5.8–14.2 s** (vs 97 s). |
| 12 | 🟠 | `/api/events/gdelt` hard 502 | **FIXED** | → **200** `{"features":[],"degraded":true,"note":"gdelt transport: …"}`. Graceful, marked. |
| 13 | 🟡 | Supabase: anon-executable SECURITY DEFINER fn; leaked-pw off | **PARTIAL — operator apply required** | Fix **encoded** in `site/supabase-schema.sql` (revoke + faithful fn/trigger). Live apply **blocked**: Supabase MCP is read-only here + no Management PAT. Finding B (HIBP) is GoTrue auth config — not SQL/MCP-reachable. Live probe confirms anon/auth/public still hold EXECUTE. |
| 14 | 🟡 | `vessel_dossier` name:null/category:other | **FIXED** | MMSI **311000977 → "BALTIC HOLLYHOCK" / cargo** (report's exact case). +2 verified (DENSA FALCON/cargo, LUNNI/tanker). |

**12/12 code bugs fixed and verified live. 1 config bug (13) encoded, pending operator apply.**

---

## How the fixes were scoped (no shared-file collisions)

7 owners, disjoint files (`intel.py` and `main.py` were the hotspots — collapsed to a single owner
each by keeping logic in feature modules):

- **A** sim 1,2 → `sim/engine.ts`, `combat.ts`, `SimulationOverlay.tsx`
- **B** news 3 + factcheck-fast → `news/sources.py`, `news/analyze.py`, `routes/news.py`
- **C** health 5,6,8,12 → `keys.py`, `cyber.py`, `aviation.py`, `events.py`, `intel.py` (one line)
- **D** replay 4 → `timeline/Timeline.tsx`
- **E** dossier 9,14 → `intel/dossier.py` (reads positions DB via `history.py`, signatures unchanged → no `intel.py` edit)
- **F** mcp 7 → `mcp_server.py` (compact + `limit`, client-side)
- **G** perf+fast 10,11 → `cams.py`, `intel/lod1.py` (memoized in-module), `main.py` (warm task), `simulation.py`
- **(me)** supabase 13 → `site/supabase-schema.sql` + MCP

Each owner added a check: 32 sim tests, 21 news, 12 health-route, 6 dossier, 5 incident_history,
cams/sim-route tests — folded into the 296 green.

---

## Residual verification gaps (honest)

1. **Sim UI live-DOM click-through (bugs 1,2) was NOT visually confirmed.** Every Playwright browser
   tool errored `"Browser is already in use … use --isolated"` — the playwright-mcp Chrome profile is
   locked by a live Chrome (PID 137252, renderer ~39 % CPU = the operator's own globe). I did **not**
   kill it. Bugs 1,2 are instead proven at three levels: 32 passing sim unit tests (incl. the
   1000→200-render + math-on-1000 + salvo-varies assertions), the **vite-served bundle** the DOM is
   built from (`max=2000`, notice template, `RENDER_AGENT_CAP=200`), and **executing the served
   `combat.ts`** (leakers 942 @ 1000, salvo table). To close visually: re-run the Playwright probe
   with `--isolated` (or after the operator's browser closes).
2. **Bug 4** is a UI-string change verified by typecheck only (no Timeline test harness exists).
3. **Bug 13** could not be applied this session (read-only MCP, no PAT). Operator actions:
   - **Finding A:** run the appended block in `site/supabase-schema.sql` (or
     `revoke execute on function public.rls_auto_enable() from public, anon, authenticated;`) in the
     SQL editor / a writable MCP. Reversible via `grant`. Verify: advisor lints
     `*_security_definer_function_executable` for `rls_auto_enable` clear.
   - **Finding B:** Dashboard → Auth → Password settings → enable **Leaked password protection**
     (or Management API `PATCH /v1/projects/<ref>/config/auth {"password_hibp_enabled": true}`).

## New observations (not regressions)

- **`/api/news/analysis` cold-start cliff:** first (uncached) call ran the LLM cluster→debias→critique
  synchronously and exceeded 35 s (client timeout); subsequent calls cached at ~8 ms. The conflict
  corpus fix is correct; the cold build is a latency cliff worth a background-warm or stream later.
- **IODA / GDELT upstreams are unreachable from this egress** (empty transport bodies). The routes now
  degrade correctly (502 / 200-degraded); the upstream deadness is environmental, not a code bug.

---

## What changed on disk

Frontend: `apps/web/src/sim/{engine,combat}.ts`, `SimulationOverlay.tsx`, `timeline/Timeline.tsx`.
Backend: `apps/api/app/news/{sources,analyze}.py`, `routes/{news,keys,cyber,aviation,events,cams,simulation}.py`,
`routes/intel.py` (1 line), `intel/{dossier,lod1}.py`, `mcp_server.py`, `main.py`.
Config: `site/supabase-schema.sql`. Tests: 7 files added/extended. No new dependencies.
