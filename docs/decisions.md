# Operator decisions & platform history

This is the full rationale and post-mortem log behind the invariants in
`CLAUDE.md`. CLAUDE.md carries the *what* plus a pointer to the enforcing
check; this file carries the *why*, the dates, and the failures that taught
each lesson. If you are about to change a guarded behavior, read its entry
here first — several were rejected and re-litigated more than once, and the
guard tests cite this file.

Executable guards (fail loud instead of relying on prose):

- `apps/web/src/globe/invariants.test.ts` — renderMode opts, upsert-by-id,
  SVG palette, withWsKey.
- `apps/web/eslint.config.js` — apiFetch-only fetch, no removeAll in
  PollGeoJsonAdapter.
- `apps/api/tests/test_invariants.py` — semaphore=8, global_snapshot() for
  internal consumers, FORMAT=tle, jemalloc scrub, ≥8k live floor.
- `apps/api/tests/test_adsb_viewport_stable.py`, `test_adsb_hot_blob.py` —
  stable decimation, pre-rendered world blob.
- `scripts/verify.sh` — one command for all of it (`--live` adds feed probes).

---

## Icons

- **Every aircraft and vessel renders as its category SVG**, never as a bare
  Cesium `point`/dot, never as a blue circle. The category dispatch lives in
  `apps/web/src/globe/adapters/styles.ts` (`aircraftStyle`, `vesselStyle`).
- Aircraft categories (with their colors):
  - airliner — `#facc15`
  - private  — `#2dd4bf`
  - helicopter — `#c084fc`
  - glider — `#93c5fd`
  - military — `#f59e0b`
  - emergency squawk — `#ef4444`, pulsing
- Vessel categories (with their colors):
  - cargo — `#14b8a6`
  - tanker — `#d97706`
  - fishing — `#5eead4`
  - passenger — `#38bdf8`
  - military — `#f59e0b`
  - sailing — `#a5f3fc`
  - pleasure — `#4ade80`
  - tug — `#c084fc`
  - SAR — `#ef4444`
  - dark-vessel candidate — `#ef4444`, diamond
- Aircraft icons rotate via `track_deg` → `-Cesium.Math.toRadians(track_deg)`.
- Vessel icons rotate via `cog` (or `heading` fallback).
- Selection magenta polyline `#d946ef` width 4 + black outline width 6.

## Refresh smoothness

- **Aircraft and vessels must update in place — never disappear and reappear**.
  `PollGeoJsonAdapter` uses upsert-by-id (`getById` → update billboard image /
  rotation / position), NOT `removeAll() + add()`. Any change that re-creates
  entities on every poll is a regression and must be reverted.
- **Aircraft TELEPORT to each fix (operator request 2026-06-21).** Each poll snaps
  the aircraft straight to its newest REAL reported position via
  `ConstantPositionProperty` — no interpolation, no glide — so the map shows live
  ADS-B truth instantly. The operator explicitly chose this over the prior glide,
  with full knowledge it had been rejected twice before (see memory
  `adsb-motion-glide-to-fix`). Do NOT "fix the jump" back to a glide.
- **NEVER synthesize/predict aircraft motion BY DEFAULT — real observed fixes only.**
  Teleport shows ONLY real fixes; do NOT add interpolation, forward-extrapolation, or
  dead-reckoning to "smooth" it ON THE DEFAULT PATH — that re-introduces the fake
  motion the operator rejected. The glide model (`upsertAircraftSamples`) was REMOVED
  in the teleport change; reverting to glide is a `git` revert, not a rewrite.
- **SANCTIONED EXCEPTION — opt-in dead-reckoning (operator request 2026-06-28).** There
  is a settings toggle "Keep planes moving between updates" (`aircraftDeadReckon`
  in `apps/web/src/state/settings.ts`, **OFF by default**). When the operator turns it
  ON, `PollGeoJsonAdapter` replaces the teleport with `deadReckonPosition` — a
  FlightRadar24-style forward-projected glide along the last `track_deg` at the last
  `velocity_ms`, capped at `DEAD_RECKON_HORIZON_S` then HOLD. Positions while ON are
  ESTIMATED, surfaced by the `PredictedMotionBadge` on the map. This is INTENTIONAL and
  operator-approved with full knowledge of the rejections above — do NOT delete it as a
  "synthesis regression". The DEFAULT (toggle off) still teleports to real fixes only.
- **A position-unchanged SKIP must still refresh the entity PropertyBag — skip only the
  RESTYLE, never the bag (2026-06-30).** `PollGeoJsonAdapter`'s teleport + deadReckon
  `!fresh` branches `continue` when a contact's lat/lon is within `AIRCRAFT_POS_EPSILON_M`;
  they set `existing.properties = new Cesium.PropertyBag(props)` BEFORE the `continue` so
  freshness counters (`seen_pos_s`/`seen_at`/`last_contact`) + facets stay live for the
  entity panel + histogram. Skipping the bag froze "Last seen" on every cached/resending
  contact. `EntityPanel`'s snapshot re-render gate likewise keys on a signature that
  INCLUDES `seen_pos_s`/`last_contact`, not position alone, or the panel freezes for steady
  contacts. Restyle (styleFn + dim + billboard GPU write) stays skipped — that is the perf win.
- VESSELS still glide via `SampledPositionProperty` + `LinearApproximation`
  (slow movers) — do not change that. Aircraft smoothness, if ever wanted again,
  comes from delivering REAL fixes faster + steadier, never from inventing positions.
- `requestRenderMode: true` must stay on, BUT `maximumRenderTimeChange: 0`
  (GlobeCanvas viewer opts) so the scene re-renders every frame the simulation
  clock advances — that is what makes `SampledPositionProperty` interpolation
  play SMOOTHLY between fixes instead of hopping once per poll (the "teleport"
  report). When the timeline is paused the clock is frozen and the scene idles —
  requestRenderMode still saves GPU. Do not set `maximumRenderTimeChange` back to
  `Infinity`. Follow (`camera.ts`) flips `requestRenderMode` off for its duration
  and restores it.
- **SANCTIONED EXCEPTION — opt-in idle render governor (design §5.1, 2026-07-02).**
  Settings toggle "Idle render governor" (`continuousRenderGovernor` in
  `state/settings.ts`, **OFF by default**). While OFF, `maximumRenderTimeChange`
  stays `0` exactly as above. When ON, GlobeCanvas' governor (`evalGovernor`,
  250 ms tick + on moveEnd) relaxes it to `Infinity` ONLY in the genuinely-idle
  case (world view, teleport aircraft, frozen vessels, nothing selected, no sim,
  and no registered `renderNeeds`), and holds `0` whenever ANYTHING animates. Any
  doubt → `0`. Operator-approved; do NOT delete as a regression, and do NOT flip
  its DEFAULT to ON without an on-hardware fps sign-off.
- **World-view decimation MUST be STABLE across polls.** At near-global zoom the
  frontend asks `/api/adsb/global?limit=20000` (no bbox); `viewport_filter`
  (`routes/adsb.py`) serves the full union (a ~13k snapshot ships WHOLE) and only
  decimates if the union exceeds 20000 — then keeps a deterministic subset keyed
  by `md5(feature id)` (live tier first). It must NOT use a positional stride:
  the snapshot's order/count shift every refresh, so a stride resampled a
  DIFFERENT 4000 each poll → 112% id churn / 2.5 s measured → the upsert frontend
  churned entities and aircraft sat frozen at world view. Never key the sort on
  an age field (`seen_pos_s`/`seen_at`) — those tick every snapshot and
  reintroduce the churn. Guarded by `tests/test_adsb_viewport_stable.py`.

## Refresh cadence

- ADS-B global: 1 s frontend poll (`registry/defaults.ts` `ttlSec: 1`), backend
  sticky snapshot on a 1.0 s target cycle (`_SNAPSHOT_TARGET_CYCLE_S`), each
  fan-out wall-clock-capped at 10 s (`_FANOUT_BUDGET_S`). The 1 s poll is cheap
  (hot route serves the sticky snapshot in microseconds). Do not raise the poll
  above 10 s.
- **Backend is HOT at boot.** `main.py` lifespan calls `adsb_routes.start_snapshot()`
  so the refresher fills `_LATEST_SNAPSHOT` before the first browser request.
  Without it the first `/api/adsb/global` runs a 1–10 s synchronous fan-out under
  `_SNAPSHOT_BOOTSTRAP_LOCK` (the "takes seconds to start loading" stall).
- **World-view payload is pre-rendered, not per-request.** The refresher builds a
  gzipped blob of the FULL snapshot (capped at `_WORLD_LIMIT` = 20000) ONCE per
  cycle (`_build_hot_blob` via `asyncio.to_thread`) and stores `_HOT_BLOB`/`_HOT_ETAG`.
  `adsb_global` serves those bytes verbatim for any no-bbox request that carries a
  limit, with `Content-Encoding: gzip` + ETag/304 — constant-time (p50 ~4 ms
  measured). Do NOT move decimation/serialize/gzip back onto the request path —
  that per-request CPU was the "short long short long" cadence. Guarded by
  `tests/test_adsb_hot_blob.py`.
- **`/ws/adsb` push is the PRIMARY live transport.** The refresher fans `_HOT_BLOB`
  to all subscribers (`_broadcast_blob`, per-send timeout + drop-on-error) each
  cycle; client cadence is server-timed (~1.0 s). `require_ws_key` BEFORE `accept`;
  sends the blob on connect for instant first paint. Browser inflates with
  `DecompressionStream('gzip')` → `render()`. HTTP poll = fallback + zoomed bbox
  path; `PollGeoJsonAdapter` suppresses it only while `wsActive && isWorldView()`.
- **Frontend cadence is an absolute wall-clock grid**, NOT `max(ttl - elapsed, 250)`.
  `scheduleNext` books each tick against `nextAt += ttl` so a slow poll's `elapsed`
  no longer leaks into the gap; re-anchors after an overrun instead of sprinting.
- Internal consumers of the snapshot (jamming, intel, analytics, correlate) MUST
  call `global_snapshot()`, never the `adsb_global()` route handler in process —
  the handler's `Query(...)` defaults reach `viewport_filter` and 500 ("'>' not
  supported between instances of 'Query'"). This broke the jamming layer.
  Guarded by `tests/test_invariants.py`.
- Vessel breadth: two GLOBAL MMSI-keyed sources run together and dedup
  (freshest-wins on `vessel:<mmsi>`):
  1. **ShipXplorer** — DIRECT httpx, NO browser (`app.ais_keyless._run_shipxplorer`,
     `data.shipxplorer.com/live` world bbox @ zoom 6, ~32k incl. satellite AIS,
     measured 2026-07-05). Needs browser-ish `Referer`/`Origin` headers or it
     500s; NOT Cloudflare-gated. Cheapest source (one ~190 KB request/poll).
  2. **MyShipTracking headless-browser sidecar** (`tools/ais-myshiptracking-feeder`,
     `:8093/vessels.json`, ~22k measured 2026-07-05), polled every 30 s.
  `app.ais_sidecar` also registers MarineTraffic `:8092` (SHIP_ID-keyed,
  Cloudflare-throttled) + VesselFinder `:8091` — SHIP_ID-keyed feeders must NOT
  run alongside an MMSI source (different id namespace → double-renders). Only
  ONE SHIP_ID feeder may be enabled, only in place of the MMSI sources.
  AIS Digitraffic: 30 s (Baltic only). AISStream WS: on-demand only (API cap).
  Sentinel-1 SAR dark-vessel layer (`maritime.sar.hormuz`): 6 h poll.

## Aircraft count + sources

- **The global snapshot must carry ≥8 000 aircraft** in steady state (~13 k
  normal). A drop to a few hundred/thousand is a regression — see the
  airplanes.live rate-limit post-mortem. Live guard:
  `OSINT_LIVE_PROBE=1 pytest apps/api/tests/test_invariants.py`.
- The feed is a UNION of tiers, deduped by `aircraft:<icao24>`
  (`apps/api/app/routes/adsb.py:_do_global_fanout`), freshest wins:
  1. **OpenSky `/states/all`** — the ~13 k breadth source. Works keyless;
     falls back authed→anonymous on 429. Pulled once on boot, then once per
     UTC day at 00:00 UTC (`_opensky_cached` / `_utc_day`), cached + served
     between pulls (~4 credits/day).
  2. **airplanes.live `/v2/point` grid** (`_GLOBAL_GRID`, 130+ cells) —
     dense-region freshness overlay, time-boxed (8 s). Densify only — never thin.
- Upstream burst semaphore is **8** (`_UPSTREAM_SEMAPHORE`): airplanes.live
  rate-limits above ~8 concurrent calls and answers with HTTP 200 + a
  `text/plain` body (NOT just 429) — `_parse_ac` must reject non-JSON bodies,
  and `load_cell` must RAISE (not cache empty) on all-host failure. Do not
  "simplify" either away. Guarded by `tests/test_invariants.py`.
- The single-shot firehose URLs (`_FIREHOSE_URLS`) are dead from most egress
  IPs (airplanes.live `/v2/all*` 404, adsb.lol 451, adsb.fi 403), tried
  opportunistically with a 30 s dead-skip. OpenSky is the real breadth source.

## Labels

- Every aircraft: callsign → registration → ICAO24. Every vessel: name → MMSI.
- Shared style in `apps/web/src/globe/adapters/labelStyle.ts` (`labelFor`,
  `aircraftLabelText`, `vesselLabelText`). Bold IBM Plex Mono 11px, dark pill,
  fill+outline. Do not duplicate or fork.

## Satellites (CelesTrak)

- Curated group layers (`space.celestrak.*` in `registry/defaults.ts`), keyless,
  off by default. `LayerCompositor` parses the group from the endpoint query.
- **Positions are SGP4-propagated client-side** from CelesTrak TLEs by
  `SatelliteAdapter` (`satellite.js`). SGP4-from-current-TLE IS a satellite's
  authoritative position — REAL physics, NOT the forbidden ADS-B motion
  synthesis. The no-extrapolate aircraft rule does NOT apply to orbits.
- **Motion model = `SampledPositionProperty` fed by SGP4-sampled orbit windows.**
  Do NOT revert to reassigning `ConstantPositionProperty` every tick (the 5 s
  hop). Propagation + `twoline2satrec` are CHUNKED across frames; never
  bulk-propagate synchronously (~100 ms hitch at the `MAX_SATS` 4 k cap).
- Backend `/api/space/gp` MUST request **`FORMAT=tle`**: the OMM JSON variant
  omits `TLE_LINE1/2` → ZERO satellites rendered. Browser UA + 2 h cache
  (CelesTrak 403-rate-limits bursts). Guarded by `tests/test_invariants.py`.

## Keyless layers (must work with no API key)

ADSB.lol + airplanes.live grid, Digitraffic Baltic AIS, MyShipTracking sidecar
(:8093), ShipXplorer (`Referer`/`Origin` headers), USGS quakes, Carto Dark
Matter via `/tiles/basemap`, CelesTrak via `/api/space/gp` (`FORMAT=tle`).
NASA FIRMS needs MAP_KEY — degrade gracefully when missing.

## Auth

- `apiFetch` and `withWsKey` wrap every browser → backend call. No raw
  `fetch`/`new WebSocket`. Guarded by eslint + `invariants.test.ts`.
- WS handlers call `require_ws_key` BEFORE `accept`.

## Ontology: local-first store (2026-07-07)

Phase 1 of `docs/roadmap-ontology-2026-07.md`. The ontology's backend is now
**local SQLite** (`data/ontology.db`, `intel/ontology_local.py`), reached via
`get_registry()`. Guard: `apps/api/tests/test_ontology_local.py`.

**Kill criterion invoked same day (operator, 2026-07-07):** the roadmap's
dual-backend design shipped first (SQLite default, PostgREST remote when
Supabase configured + signed in), then the operator decided "fully local now —
bye bye Supabase" and the PostgREST ontology backend (`OntologyRegistry`, its
URL helpers and row coercers, ~180 lines) was deleted the same day. SQLite is
the ONLY ontology store. Scope of the deletion: the ontology object/link
store only — Supabase-backed subsystems outside the ontology (BYOK
`user_keys`, `target_board`, `alert_rules`, `action_log` audit appends) are
untouched and still degrade with 503 when Supabase is unset (their local
treatment is Phase-4 territory). `scripts/ontology_export.py` remains as the
one-shot importer for anyone with old Supabase rows. If a remote backend is
ever re-earned, `get_registry()` is the seam.

- **Deliberate contract revoke.** `/api/ontology/*`, `/api/situations`,
  `/api/maps` used to 401 on a keyless boot (`current_user` demands a
  Supabase token) and 503 with a fake user (store unconfigured) — the reason
  the GRAPH page was photographed empty. These routes now use
  `current_user_or_local`: when Supabase is *entirely* unconfigured the
  caller (already past ApiKeyMiddleware) gets the shared `local` identity and
  the SQLite store. With Supabase configured, behavior is exactly
  `current_user` — prod droplet unchanged. Consequence accepted: a
  static-API_KEY deployment shares ONE `local` graph (single-operator
  platform). The old 401/503 tests were rewritten to the local contract the
  same day.
- **Assertions, not just blobs.** Every object property change is also an
  append-only row in `assertions(object_id, prop, value, source, confidence,
  observed_at, valid_until, derivation)` — *who said this, when, how sure*.
  The `objects.props` column stays the exact last-written blob (wholesale
  replace, removals included) because InvestigationCanvas + the
  situations/maps/COP/annotation stores round-trip it verbatim; the diff into
  assertions happens inside `upsert`. Merge-style evidenced writes use
  `assert_props` (never removes props). Removals are tombstones
  (`value=null`, `derivation={"op":"remove"}`). Dedup is on (value, source):
  the same source repeating adds nothing; a different source stating the same
  value is corroboration and is kept.
- **Budgets:** per-object cap `ontology_max_assertions_per_object` (2000,
  oldest deleted first) + soft byte cap `ontology_db_max_bytes` (2 GB, drop
  oldest 10% + VACUUM, checked ≤1×/hour or per 500 writes). If the write rate
  fights these caps, the Phase-2 significance filter is wrong — tighten it,
  don't raise the caps.
- **`traverse`/`path_between` live in the `_GraphWalk` mixin** — pure BFS
  over `get` + `_links_touching`, shared by both backends, so the BFS matrix
  in `test_ontology_path.py` covers both.
- **`list_by_kind` + `delete` absorbed into the registry** from the
  direct-PostgREST blocks in `routes/situations.py` / `routes/maps.py`
  (which filter on `props->>kind`, NOT the kind column — workspace ids
  aren't in `_KNOWN_KINDS`). Local `delete` cascades (assertions + touching
  links); remote delete stays object-row-only (no cascade in that schema).
- **Migration:** `scripts/ontology_export.py` pulls Supabase rows → the local
  store; props become single assertions with `source='migrated'`.
- Phase-1 boundaries, named: assertion history on the remote backend returns
  501; no Supabase-side schema change; daily-summary compaction not built
  (plain oldest-first delete). Kill criterion stands: if the operator never
  signs in remotely after Phase 3, delete the PostgREST path deliberately.

## Foundry layer (2026-07-08 → 2026-07-09)

The BYO-data layer (`apps/api/app/foundry/`, `apps/web/src/foundry/`, plan +
frozen contract in `docs/foundry-plan.md`). Core loop: upload → transform
(step DSL) → build (DAG, staleness, cycle-reject) → data-quality checks →
bind into the local ontology (auto-sync after every version). Scope is
**keyless single-operator local SQLite** — multi-tenant ACL/MLS, distributed
compute, streaming CDC, and connector catalogs are **out** by operator
decision (roadmap-ontology-2026-07.md §6), and re-opening them needs a new
decision, not a "cleanup".

**2026-07-09 hardening wave** — a 9-agent assessment (Palantir PDFs + code
audit) then two adversarial Opus review rounds drove the layer to operational
capacity for its scope. What that wave established, and must not regress:

- **Row-level quarantine / dead-letter.** A `filter`/`derive` expression that
  RAISES on one row (e.g. `'hello' - 5`) quarantines that row and continues —
  it must never abort the whole build. The `QuarantineSink` collects them, the
  build records a `quarantined` count, and the rows persist to the
  `dead_letter` table (latest build only; cleared on a clean rebuild).
  `record_dead_letter` runs **after** `add_version` succeeds, so a
  check/row-cap rejection can't wipe the live version's dead-letter. →
  `tests/test_foundry_v5.py`
- **Non-lossy ingest.** `_cast_scalar` casts int/float only when the string
  round-trips exactly (so "007"/"+1"/"1e999"→str, never a mangled id or a
  non-finite float that breaks JSON). Column type-pinning (`types` upload
  field) forces a column's type. → `test_foundry_v5.py`
- **Regex safety.** `_safe_pattern` RAISES (→ quarantined, loud) rather than
  returning a silent sentinel, and rejects catastrophic-backtracking shapes
  via a **balanced-paren structural detector** (`_is_catastrophic`) — it
  catches nested forms like `((a+))+` that a flat regex misses, and must NOT
  false-positive on anchored/bounded patterns (`(ab*c)+`, `(a{2,5})+`,
  trailing groups). NB: use tuple membership for the next-char test —
  `"" in "*+"` is `True`. `regex_replace` runs on the full value (no
  truncation). ReDoS can't be bounded at runtime: `re` holds the GIL and steps
  may run off the main thread (no `signal.alarm`), so the guard is
  compile-time. → danger/safe matrix in `test_foundry_v5.py`
- **`_step_sort`** uses a total-order key that never raises on mixed
  (JSON/NDJSON) column types. **Sequence repetition** (`str/list * int`) is
  capped (`_MAX_SEQ_REPEAT`) so a data-controlled multiplier can't OOM.
- Malformed uploads → 422 (parse errors wrapped in `parse_upload`), not 500.
  PUT /checks reassigning `dataset_id` clears the check's stale `check_results`.
- DSL added `dedup` + `cast` steps; endpoints added Data Docs
  (`/datasets/{id}/docs`), one-hop column lineage
  (`/datasets/{id}/column-lineage`), dead-letter, and a file-arrival `cascade`
  build on upload.

**Second review round (same day) — regex hardening + FE overhaul.** A second
adversarial pass showed the structural ReDoS detector still leaked
(trailing-optional `(\w+\s?)+`, lazy `(a+?)+`, alternation `(a|a)+`). A purely
structural detector cannot be complete, so the fix is defense-in-depth, NOT a
bigger heuristic:
  1. **Regex patterns must be string LITERALS** (enforced in `_validate`) — a
     dataset column value can never supply the pattern, which kills the
     data-driven-ReDoS vector and lets the literal be screened at SAVE time.
  2. The detector was widened (flags a quantified group whose body ENDS in OR
     STARTS with an unbounded-quantified atom) and now RAISES at save (loud), so
     a dangerous/invalid literal 422s before any build. Residual
     overlapping-alternation is an operator footgun on a single-operator local
     process, documented in `transforms.py`.
  Also fixed: `_coerce_to` float pin now applies the `math.isfinite` guard;
  `update_check` clears `check_results` ONLY on an actual dataset reassignment
  (not on every rename/toggle). The FOUNDRY frontend was rebuilt on a shared
  Workshop vocabulary (`web/src/foundry/ui.tsx`: ViewHeader, StatTile, Tabs,
  TypeChip, LogView, health affordances) — icon nav rail, tabbed dataset detail
  surfacing lineage + dead-letter, status-colored lineage DAG (stale = amber),
  entity-resolution toggle on bindings. All token-driven (light/dark safe).
  Baseline: **917 backend tests** (up from 877); web 201; verify.sh green.

**Parity wave (2026-07-09) — Data Health SLAs + analytic transforms.** Closed
in-scope real-Foundry gaps: two check types — `freshness{column,max_age_s}`
(newest parsed timestamp within max_age; epochs ms/µs/ns-normalized; far-future
outlier cells dropped so one typo/clock-skew value can't mask stale data) and
`schema_contract{columns[],types?}` (required-columns + per-column type match,
judged on ACTUAL cell values so an all-null column or integer-valued floats
don't false-fail) — and two analytic transform steps: `window`
(row_number/rank/lag/running_sum, per-partition, order-preserving; rank/lag/
running_sum require `order_by`) and `pivot` (long→wide; RAISES if a pivot value
collides with an index column name rather than clobbering the key). A focused
Opus review found 4 defects in this wave (all fixed + tested). Deferred, named:
**Ontology Actions** (the `intel/actions.py` verbs layer exists but audits to
the deleted Supabase `action_log` — needs a local-store audit rewrite) and
**dataset branches** (linear versions today). Baseline **939 backend tests**;
web 201; verify.sh green; pivot/window/freshness proven-live vs :8000.

## Lessons from past sessions (post-mortems)

### Never claim coverage/parity without a measurement
A session called the keyless AIS firehose "global" in code, commit, and
`/api/intel/sources` — it was Norway-only. Another asserted ~13k aircraft was
"the full picture" — it was ~60% of FlightAware. The words global / complete /
full / already covered / parity are banned unless a live probe with a COUNT
backs them up that turn.

### "Configured" ≠ "working"
`opensky_authed: true` because creds were *set* — but expired; every call
401'd. To claim a source works, hit it and read the status/count.

### Exhaust the data-source search before declaring a ceiling
"Keyless aircraft caps at ~12.7k" was wrong: open mirrors
(`globe.theairtraffic.com`, `skylink.hpradar.com`), the adsb.lol full-snapshot
quirk, and a headless-browser bridge existed. "Whole globe" means try harder.

### Feed hygiene
- Feeds pull in a BACKGROUND task (`_pull_due_feeds`) per-feed; a slow body
  never blocks the fan-out. `theairtraffic` = freshness primary (~10k, ~1.6 s
  median age, pulled ~8 s). readsb `aircraft.json` bodies are several MB —
  ~5-8 s cadence is the bandwidth balance.
- adsb.lol answers HTTP 451 to a non-browser User-Agent — send a real browser
  UA. airplanes.live/adsb.fi/adsb.one Cloudflare-block datacenter IPs.
- AISStream has an API cap — ON DEMAND only (started on `/ws/ais` connect).
- The ADS-B sidecar readFn must FORWARD `nac_p`/`nic`
  (`tools/adsb-globe-feeder/index.js`) — dropping them left `/api/jamming`
  with ZERO cells for days (2026-07-05).
- Sidecar children must SCRUB `LD_PRELOAD`/`MALLOC_CONF`
  (`adsb_sidecar.py`/`ais_sidecar.py`): inherited jemalloc kills the Chrome
  zygote (error_code=1002) → 0 aircraft → frozen blob (2026-07-04). Guarded by
  `tests/test_invariants.py`.

### Playwright
- Pass FUNCTIONS to `page.evaluate`, not strings — a template-string "reader"
  silently returns the function object and the sidecar serves 0 aircraft.
- The globe-feeder keeps ONE page open; zoom to world once, read the store,
  nudge ~once/30 s. Do not re-move the map per read.
- Headless Playwright CANNOT measure real GPU fps (software raster). It can
  measure main-thread longtasks during a scripted pan. Never claim an fps win
  from a headless number.

### Process / shell
- `pkill -f` doesn't match `node index.js` argv. Kill by PORT holder:
  `scripts/kill-port.sh <port>`. Fresh log file per run.
- apps/api uvicorn has NO --reload; restarting 3× got the egress 429'd by
  airplanes.live → cold-boot crawls. Restart ONCE, verify in-process, WAIT.
- Backend boot: `bash scripts/run-api.sh` from repo ROOT (jemalloc LD_PRELOAD;
  bare uvicorn hit ~54 GB glibc-arena thrash; NEVER set `M_ARENA_MAX=2` — it
  made memory WORSE). Stale Playwright-MCP lock: `rm
  ~/.cache/ms-playwright-mcp/*/Singleton{Lock,Cookie,Socket}`.
- Backend tests from the repo ROOT, never `apps/api` (there `.env` auth
  resolves and every request 401s).

### Frontend performance (2026-06-30)
World-view <10 fps is GPU/per-frame-render bound (~15k billboards+labels),
NOT React. FPS work targets the render path (decimate/cull at world zoom, LOD
labels, cap the moving set), not panels. Shared perf modules:
`globe/entityStats.ts` (one idle walk → `useEntityStats`),
`globe/frameBudget.ts`, `explorer/facets.ts`.

### "Not refreshing / Last seen climbing" = backend first (2026-06-30)
Diff two `/api/adsb/global` pulls N s apart on `seen_pos_s`: median can read
fresh while <5% CHANGES over 8 s — a frozen HOT_BLOB (fan-out burning its
budget on a 429 storm). The frontend faithfully mirrors a frozen blob.
`scripts/verify.sh --live` runs this probe.

### Boot race (2026-06-30)
API lifespan blocks `accept` until the snapshot warms (~15-25 s);
`transport/config.ts` retries with backoff. `/api/config` is keyless — a
config error is transport/timing, never auth.

### Commit / doc voice
Human-style commit messages; a global commit-msg hook strips AI attribution.
Write what was measured ("union climbs to ~14k"), not marketing ("now
global"). Repo root tidy: no dev screenshots committed, docs under `docs/`,
app art is SVG in code.
