# CLAUDE.md — invariants for any agent editing this repo

Method + architecture map: `.claude/skills/osint-platform-dev/`. Full decision
history, dates, and post-mortems: `docs/decisions.md` — read the entry before
changing any guarded behavior. When files disagree, this one wins.

Most invariants below are enforced by executable guards; `bash
scripts/verify.sh` runs all of them (`--live` adds feed probes against :8000).
A guard failure means an operator decision regressed — fix the code, or revoke
the decision deliberately by changing BOTH the guard and this file.

## Operating rules

1. **Evidence over assertion.** Never write done/works/fixed without the
   command + output, screenshot, or file:line THIS turn. Tag claims
   proven-live / plumbed-unverified / not-built. The words global / complete /
   full / parity are banned without a live count this turn.
2. **Query the knowledge graph first.** `graphify-out/graph.json` (~10k nodes,
   auto-rebuilt by a global post-commit hook) answers "what calls X / where
   does Y live / how do these relate" — `graphify query "<question>"`. Then
   **read the real signatures** of the 3-4 files you'll depend on before
   writing code against them; the graph orients, source is ground truth.
3. **Find the reuse first.** ~80% of any new feature already exists as a
   substrate (stores, bus, adapters, brief fusion). Extending beats rebuilding.
4. **Change the minimum, name what you skipped.** Every regression here came
   from a confident "cleanup" of code whose history the editor didn't know.
5. **"Stale/slow/empty" → probe the BACKEND first** (diff two
   `/api/adsb/global` pulls on `seen_pos_s`; sidecar `:8090`/`:8093` health —
   `scripts/verify.sh --live` does both). The frontend faithfully mirrors a
   frozen blob; no frontend change fixes a backend problem.

## Sacred invariants → guards

Icons / labels:
- Category SVG icons only, never bare points; palette + dispatch in
  `globe/adapters/styles.ts`; shared label style in `labelStyle.ts`
  (callsign→reg→ICAO24, name→MMSI). → `apps/web/src/globe/invariants.test.ts`
- Aircraft rotate by `track_deg`, vessels by `cog`/`heading`. Selection
  polyline `#d946ef` w4 + black outline w6; `tracks.ts` dedup keeps ≥1 push
  per 60 s or 5° so the polyline always has ≥2 points.

Refresh / motion:
- `PollGeoJsonAdapter` upserts by id — never `removeAll()+add()`.
  → eslint rule + `invariants.test.ts`
- DEFAULT aircraft motion = TELEPORT to real fixes; never synthesize motion on
  the default path (operator rejected glide/dead-reckoning repeatedly).
  Sanctioned opt-in exceptions — do NOT delete as regressions:
  `aircraftDeadReckon` toggle (OFF default) and `continuousRenderGovernor`
  toggle (OFF default), both in `state/settings.ts`. → `docs/decisions.md`
- Position-unchanged SKIP still refreshes the entity PropertyBag; only the
  restyle is skipped. Vessels keep their `SampledPositionProperty` glide.
- `requestRenderMode: true` + `maximumRenderTimeChange: 0` in GlobeCanvas
  viewer opts. → `invariants.test.ts`
- World-view decimation = stable `md5(id)` subset, never positional stride,
  never age-keyed. → `tests/test_adsb_viewport_stable.py`

Cadence / backend:
- 1 s poll + sticky snapshot (1.0 s cycle, 10 s fan-out budget); backend hot
  at boot (`start_snapshot()` in lifespan); world payload = pre-rendered
  gzipped `_HOT_BLOB`, `/ws/adsb` push primary + HTTP poll fallback.
  → `tests/test_adsb_hot_blob.py`
- Frontend polls on an absolute wall-clock grid (`scheduleNext`), not
  `ttl - elapsed`.
- Internal consumers call `global_snapshot()`, never the `adsb_global()` route
  handler in-process. → `tests/test_invariants.py`
- Global snapshot carries **≥8 000 aircraft** (~13 k normal): OpenSky breadth
  (1 pull/UTC-day, cached) + airplanes.live grid overlay (densify only).
  → `OSINT_LIVE_PROBE=1` in `tests/test_invariants.py`
- Upstream burst semaphore stays **8**; `_parse_ac` rejects non-JSON bodies
  (airplanes.live throttles with HTTP 200 + text/plain); `load_cell` RAISES on
  all-host failure. → `tests/test_invariants.py`
- AIS = ShipXplorer direct httpx (needs `Referer`/`Origin`) + MyShipTracking
  sidecar `:8093`, MMSI-deduped. SHIP_ID-keyed feeders (MarineTraffic,
  VesselFinder) must never run alongside an MMSI source.
- Satellites: `/api/space/gp` requests `FORMAT=tle` (JSON variant → 0 sats);
  client SGP4 via `SampledPositionProperty` is real physics, exempt from the
  no-synthesis rule; propagation stays chunked. → `tests/test_invariants.py`
- Keyless layers keep working with no API key: ADS-B grid, Baltic AIS,
  MyShipTracking, ShipXplorer, USGS quakes, Carto basemap, CelesTrak. FIRMS
  degrades gracefully without MAP_KEY.

Auth:
- `apiFetch` / `withWsKey` wrap every browser→backend call; raw `fetch` only
  for third-party hosts via scoped eslint ignore. → eslint +
  `invariants.test.ts`
- WS handlers call `require_ws_key` BEFORE `accept`.

Ontology (2026-07-07, docs/decisions.md#ontology-local-first-store-2026-07-07):
- The ONLY backend = local SQLite (`intel/ontology_local.py`, via
  `get_registry()`); the Supabase/PostgREST ontology backend was deleted the
  same day (operator invoked the kill criterion). Ontology/situations/maps
  routes must keep working keyless (`current_user_or_local`).
  → `tests/test_ontology_local.py`
- `objects.props` stays the exact last-written blob (wholesale replace,
  removals included — the frontend round-trip contract); provenance lives in
  the append-only `assertions` table, written by `upsert`'s diff /
  `assert_props`. Never make upsert merge.

## Environment facts / traps

- Backend tests from the **repo ROOT** (from `apps/api` the `.env` auth
  resolves → wall of 401s):
  `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q`
  Baseline: **1294 passed + 1 skipped** (the skip is the opt-in live probe;
  measured 2026-07-11 on branch w5-places-airspace-enrichment after the
  places/airspace enrichment wave, up from 1209 on roadmap-first-users).
  Never commit below the baseline you inherited; update this number when you raise it.
- `pnpm -r typecheck` green at every commit boundary. `bash scripts/verify.sh`
  = typecheck + lint + web unit + api tests in one command.
- Boot: `bash scripts/run-api.sh` from repo ROOT (:8000, jemalloc preload —
  never `M_ARENA_MAX=2`; sidecar children scrub `LD_PRELOAD`, guarded). Vite
  :5173. Kill servers by port: `scripts/kill-port.sh <port>`. Restart the
  backend ONCE and wait — repeated restarts get the egress rate-limited.
- Upstreams: adsb.lol 451s non-browser UAs; airplanes.live throttles with
  HTTP 200+text; firehose URLs dead from datacenter egress; OpenSky is the
  breadth source; CelesTrak 403-rate-limits bursts (2 h cache).
- Playwright: pass FUNCTIONS to `page.evaluate`, never strings. Headless
  cannot measure GPU fps — verify fps on hardware or say unverified. Live
  DEV globals: `window.__viewer` / `__Cesium` / `__useSelection`.

## Subagents

One file, one owner — serialize edits to shared files. A subagent touching
`styles.ts`, `PollGeoJsonAdapter`, `tracks.ts` dedup, or `requestRenderMode`
must preserve the invariants above (the guards fail loud regardless).

## Verification before claiming done

`bash scripts/verify.sh` green. For UI claims: boot the app, drag to Europe —
hundreds of category icons (not dots); click an aircraft — EntityPanel +
magenta track within 4 s; click empty — both clear; 30 s with no blink-off.
