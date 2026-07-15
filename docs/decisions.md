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
- Vessel breadth: two GLOBAL MMSI-keyed sources run together and dedup on
  `vessel:<mmsi>` — LAST-WRITE-WINS, not freshest-wins (see the 2026-07-15
  post-mortem below; `ObservationStore.add_many` assigns `_latest[id]`
  unconditionally). Every publisher must therefore stamp an HONEST `t`; an
  optimistic one both steals the MMSI and pins itself in retention:
  1. **ShipXplorer** — DIRECT httpx, NO browser (`app.ais_keyless._run_shipxplorer`,
     `data.shipxplorer.com/live` world bbox @ zoom 6, ~32k incl. satellite AIS,
     measured 2026-07-05). Needs browser-ish `Referer`/`Origin` headers or it
     500s; NOT Cloudflare-gated. Cheapest source (one ~190 KB request/poll).
     Polled live, so wall-clock `t` is honest for it.
  2. **MyShipTracking headless-browser sidecar** (`tools/ais-myshiptracking-feeder`,
     `:8093/vessels.json`, ~22k measured 2026-07-05), polled every 30 s. Serves a
     CACHE: `/vessels.json` carries `last_good`/`age_s` and the poller stamps `t`
     from `last_good`, refusing any union older than
     `ais_myshiptracking_sidecar_max_age_s` (180 s).
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

## OSINT World Series country catalog (2026-07-10)

Harvested all 53 country toolkits listed at unishka.com/osint-world-series
into per-country datasets (`app/osint/country_data/<code>.json`), served
behind one generic parameterized endpoint set (`/api/osint/countries`: list,
detail, graph preview, authenticated ingest) and linked into the shared
ontology graph via a single `build_graph()` that mints `country:<code> ->
resource:<code>:<slug> -> domain:<host>` — a national registry resolves to
the SAME `domain:` node the existing digital-OSINT `investigate()` fan-out
already enriches, so country toolkits get investigation for free instead of
a parallel enrichment path. New **Countries** rail panel lists toolkits by
region and ingests a country's linked graph into the Investigation canvas.

Bundled in the same branch snapshot (not this PR's main scope, but shipped
alongside): the keyless OSINT source-expansion connector modules
(`app/osint/sources/*`) and initial Foundry upload/nav/poll UI work later
deepened by the 2026-07-10/11 Foundry entries below.

Guards: `apps/web/src/osint/CountriesPanel.test.tsx`,
`apps/web/src/osint/OsintEntityPanel.test.tsx`. Spec: `docs/country-osint-spec.md`,
`docs/osint-sources-plan.md`. At merge: web unit 226 passed, API pytest 1069
passed + 1 skipped.

## MCP short/long tool variants + plugin packaging (2026-07-10)

**Context budget decision.** The heavy MCP tools were returning full payloads
by default (`query_aircraft` measured 47,374 B) which burns a calling agent's
context for little marginal signal. Tools now take `detail='short'` (a
token-frugal digest, the DEFAULT) or `detail='long'` (the full bundle). The
shaper (`apps/api/app/intel/shape.py`) runs entirely in the MCP layer — it
caps long arrays to the top few items with a companion `<field>_total`,
truncates verbose strings, and flags what it trimmed — so the guarded
`/api/intel/*` HTTP routes are untouched and unshaped. `deep_analyze` pulls
`long` internally so the reasoning path always sees the full picture.
Measured savings at merge: `query_aircraft` 97%, `query_vessels` 96%,
`aircraft_density` 95%, `gps_jamming` 91%, `anomalies` 77%; `get_situation`
0% (already small, faithful passthrough).

**Packaged as an installable plugin.** The repo became a plugin marketplace
(`.claude-plugin/marketplace.json` → `plugin/osint-geoint/`) bundling the MCP
server, an `osint-intel` skill, three slash commands, and an
`osint-watch-officer` agent. The plugin launches the venv Python directly
(`python -m app.mcp_server`) so one manifest works on Windows/macOS/Linux;
installers ship for each (`install.sh`/`.command`, `install.ps1`/`.cmd`).

Guards: `apps/api/tests/test_mcp_detail.py`,
`apps/api/tests/test_plugin_manifest.py` (manifest resolves, POSIX installers
keep their exec bit, `install.ps1` stays ASCII). **Not verified**: the
Windows installers are review-validated only — no PowerShell host to execute
them on at merge time.

## Photo geolocation pipeline (2026-07-10)

New `apps/ml/geolocate/`: estimates where a photo was taken **from image
content** when EXIF/GPS metadata is stripped — the gap left by metadata-only
geolocation tools, which return nothing on such images. Five stages, each
tagged with an honesty level rather than claimed uniformly proven:
A forensics (EXIF/GPS, perceptual-hash dedup, classical scene-type, pluggable
VLM cue extraction) → B geo-prior (data-driven cue→region KB +
log-opinion-pool fusion, worldwide, no country hardcoded) → C retrieval
(keyless live OSM/Overpass co-occurrence, CLIP cross-view vs
Panoramax/KartaView, DEM skyline — live but weak/OOD on rural-forest queries)
→ D pose (render-and-compare 6-DoF pose vs a satellite-derived Gaussian
splat/DSM, reusing `fusion/recon`'s `rpc_stereo`, DSM+shadow fallback;
proven on WorldView-3/MVS3DM: 3.8 m / 0.15° pose recovery) → E report
(calibrated per-level confidence with `proven`/`plumbed`/`heuristic` tags;
**caps AOI/pose confidence to 0 under forest canopy** — a physics limit
stated honestly rather than a guessed pin).

Keyless by default; torch/GPU stages isolated to the CUDA venv (see memory
`cuda-yolo-sidecar-env`). Guard: `apps/ml/geolocate/tests/` (107 tests,
e.g. `test_contracts.py`, `test_report.py`, `test_crossview.py`). Architecture:
`docs/photo-geolocation-pipeline.md`. Worked example in
`docs/geo-assessment-testset.md` — raw evidence images intentionally NOT
committed.

## Workflows + City 3D apps, grouped navigation, Foundry deepening (2026-07-10 → 2026-07-11)

Top navigation reworked into grouped tabs (Live / Analyze / Data / Product /
3D) to make room for two new apps without flattening the tab bar further.

- **Workflows** — a user-authored DAG pipeline builder over live platform
  data. 16 block types at ship, including subprocess-sandboxed Python (CPU/
  memory rlimits + wall-clock kill), read-only SQL over an in-memory SQLite,
  and LLM blocks, plus per-workflow persistent memory, schedules, and run
  history. Local SQLite store, keyless.
- **City 3D** — a keyless gaussian-splat scene viewer. The Spark/THREE
  viewer was EXTRACTED out of Reconstruction Studio into a shared
  `SplatView` (`apps/web/src/studio/SplatView.tsx`) so both apps use ONE
  implementation — do not fork a second splat renderer for either app.
- **Foundry** deepened with a dataset map view (lat/lon autodetect), ad-hoc
  SQL, and monitors that raise plain or LLM-summarized alerts on new
  versions, row conditions, or failed checks.

Nine frontend correctness fixes landed in the same PR; two are guarded
permanently and must not regress:
- **LOD1 buildings floated/sank in 3D-satellite mode.** The cesium-martini
  terrain provider exposes no tile availability, so
  `sampleTerrainMostDetailed` is unusable — building bases now clamp to
  `scene.globe.getHeight`, re-clamped on every terrain tile-load drain so
  they track the height as tiles refine coarse→fine. Verified live over
  Beirut Dahieh: 410/410 sampled buildings settled within 2.5 m of terrain.
  Guard: `apps/web/src/lod1/lod1Layer.test.ts`.
- **`SplatView` must dispose its WebGL context on scene switch**
  (`forceContextLoss` + `SparkRenderer` disposal) — without it City 3D
  blanked after ~16 scene swaps.
- Workflows editor block ids must stay unique against the CURRENT draft — a
  module-level counter that reset on page reload could regenerate an
  existing id, and the backend rejects a save with a duplicate id (422).

Guards: `apps/web/src/foundry/foundry.workbench.test.tsx`,
`apps/web/src/workflows/workflows.test.tsx`,
`apps/web/src/state/appView.test.ts`. Runtime store `data/workflows.db` is
gitignored, never committed. Plan doc: `docs/dashboard-workflows-plan.md`.

This PR was frontend + `.gitignore` only; the backend suite (1163 passing at
branch state) was not re-run as part of it. A wall-clock-flaky backend test
that predated this merge slipped into master through it and was de-flaked
the same day: `test_dossier.py::test_dossier_merges_db_history_with_live_fix`
asserted the live fix's `age_s <= 5`, which fails on a slow/loaded CI runner;
it now asserts by the live fix's distinct seeded position instead, since that
was the actual intent (freshest fix wins `last_fix`, not a stale DB row).

## Workflows external-actuation control blocks + MAVLink bridge (2026-07-11)

**Decision: Workflows could only read/transform internal platform data; this
adds a way to act OUTWARD.** Four new blocks in a new `control` category
(block count 16 → 20): `op.http` (request any server; response becomes rows,
once or per-row), `control.webhook` (POST rows to a URL), `control.drone`
(command a drone/UAV via a ground-control server: `goto` auto-nav to each
row's lat/lon, plus takeoff/land/rtl/orbit/follow/arm/disarm/pause), and
`control.device` (any controllable relay/gimbal/PTZ/rover).

**Safety model** (`apps/api/app/workflows/control.py`) — do not weaken any of
these without a new operator decision:
- Preview NEVER actuates: dry-run returns only the would-be envelope.
- Run-wide dispatch budget (200) plus a per-block `max_dispatch` cap.
- `WORKFLOWS_CONTROL_ENABLED=0` kill switch; optional
  `WORKFLOWS_HTTP_ALLOW_HOSTS` allowlist.
- Bearer auth is sourced by ENV-VAR NAME — the token itself is never stored
  in the workflow spec. IPv4-pinned HTTP client (same reason as
  `upstream.get_client`; see memory `host-ipv6-broken`).

**MAVLink bridge** (`apps/api/app/mavlink_bridge.py`) is a ready-made control
server translating the `drone.command` envelope into standard MAVLink for a
vehicle or SITL. `plan_mavlink()` is a pure, testable envelope→intent
mapping; `MavlinkLink` lazily imports `pymavlink` and **degrades to
log-only** (echoes planned commands, sends nothing) with no `pymavlink` or
connection string — a drone workflow can be built and rehearsed with no
hardware. Runs as a lifespan-managed sidecar (`app/mavlink_sidecar.py`, OFF
by default) or standalone (`python -m app.mavlink_bridge`); `pymavlink` is an
optional extra (`pip install -e '.[mavlink]'`).

Guards: `apps/api/tests/test_workflows_control.py` (19),
`apps/api/tests/test_mavlink_bridge.py` (14). Wire contract:
`docs/workflows-control-blocks.md`. Proven live:
`control.drone(goto)` → the real bridge → HTTP 200, planned
`SET_POSITION_TARGET_GLOBAL_INT` (25.28, 55.32, 120 m).

PR #31 ("Workflows city foundry overhaul") merged immediately after this one
as a squash-merge of a branch whose history had already landed on master —
its tree is byte-identical to this commit (`git diff` against its parent is
empty). It added no new files, code, or guards.

## Keyless whole-world 3D city (2026-07-11)

**Constraint: no free whole-planet Gaussian-splat STREAM exists keyless.**
Google/Apple planet-scale 3D is keyed mesh, not splats, and ToS-restricted
against extraction — surveyed in `docs/gaussian-splat-free-sources.md`. Two
keyless paths shipped instead of waiting on that gap to close:

1. **Globe: "Auto-fill as I pan (keyless)."** Extrudes OSM building
   footprints (public Overpass mirrors, no key) for the current viewport
   whenever the camera settles below 100 km, debounced and move-gated so the
   mirrors aren't hammered. Reuses the existing replace-in-place LOD1 loader,
   so memory stays bounded and revisits hit its 12 h cache.
2. **City 3D: "Splat this city."** Stitches a satellite chip for any
   lat/lon from the keyless `/tiles/sat` proxy (Sentinel-2 + Esri, no key)
   and runs it through the EXISTING feed-forward recon engine
   (`POST /api/recon/jobs mode=mapany`, MapAnything) to produce a real
   Gaussian splat in the Spark viewer. No backend change — pure reuse of the
   recon pipeline (`apps/web/src/city/satToSplat.ts`).

**Honesty constraint, do not silently drop:** single-view feed-forward
yields a 2.5D relief splat, and the UI must say so — true multi-view towers
need per-city imagery that isn't keyless/global (Reconstruction Studio /
`POST /api/recon/sat` cover that case instead). Recon endpoints fail closed
unauthenticated, so local generation needs `ALLOW_UNAUTHENTICATED=1` plus the
GPU lab (`apps/ml/fusion/.venv`).

Guards: `apps/web/src/city/CityApp.test.tsx`, `apps/web/src/state/stores.test.ts`.
Proven live: OSM auto-fill extruded 9k buildings over Manhattan with zero
clicks; "Splat this city" over Manhattan produced 268,324 Gaussians in ~6 s.
Same PR also repointed the README Quick Start clone/cd at
`osint-geospatial-console` (matching the `origin` remote and plugin
manifest) and clarified AIS coverage caveats — hygiene only, no guard.

## Replay motion: interpolation between recorded fixes is sanctioned (2026-07-11)

History replay (`HistoryPlayback.ts`, installed from `Timeline.tsx`) renders
`SampledPositionProperty` with `LinearApproximation` between RECORDED REAL
fixes for aircraft and vessels alike. This is deliberate and stays: the
no-synthesis rule above is scoped to the default LIVE path; replay draws
only recorded fixes and was validated in the 2026-06-20 warsim stress test
(`docs/velocity-stress-test-warsim-2026-06-20.md`, 24h replay PASS). Two
failure modes this entry forbids: (1) "fixing" replay to teleport-only —
unrequested, and a naive `CallbackProperty` swap breaks trail rendering
(`PathGraphics` samples the position property); (2) citing replay as
precedent for adding glide/dead-reckoning to the live default path — still
banned there. Guard: the W1 replay guard test asserts ≥2-point tracks on a
replayed window (file named in `docs/replay-flagship-plan.md`).

## Keyless alert push: local rule store + Discord/webhook sinks (2026-07-11)

W3 of `docs/roadmap-users-2026-07.md` ("demand rank #2, mostly wiring"). Prior
state (verified at the time): `intel/watch.py::_list_enabled_rules` returned
`[]` whenever `settings.supabase_url` was unset, and firing additionally
required a browser to have opened `/ws/alerts` (which calls
`register_session`) — so an operator-defined watch rule was dead on a keyless
boot even though the evaluator loop itself was already started at boot
(`watch.start()` in `main.py`'s lifespan). The 2026-07-07 ontology entry above
had explicitly named `alert_rules` as still-503/Supabase-only, deferred to
"Phase-4 territory" — this is that deferred work, pulled forward per the
roadmap's demand ranking.

- **Local rule store** (`intel/alert_rules_local.py`): same idiom as
  `ontology_local.py`/`history.py` — WAL SQLite under `./data/alert_rules.db`,
  `override_db_path()` test hook, `user_id`-scoped rows (the shared `"local"`
  identity on a keyless boot). Two tables: `alert_rules` and an append-only
  `alert_deliveries` log (the durable proof a sink push happened, readable via
  `GET /api/alerts/deliveries` with no browser attached).
- **`routes/alert_rules.py`** now selects backend on `not
  settings.supabase_url` (the exact predicate `watch.py` already used) —
  Supabase REST when configured (byte-for-byte unchanged behavior), the local
  store otherwise. Auth changed from `current_user` to `current_user_or_local`
  (the same contract revoke the ontology routes made 2026-07-07): a keyless
  boot gets the `local` identity instead of a dead 401; a Supabase-configured
  deployment is unchanged. `CHANNELS` gained `discord` / `webhook`, each
  requiring a `sink_url` validated with `workflows/control.py::check_url` at
  creation time (fail fast on a bad URL, not on first firing).
- **`intel/watch.py::evaluate_all`**: when no session is registered AND
  Supabase is unset, it now cheaply probes the local store
  (`_list_enabled_rules(UserCtx("local",""), s)`) and, only if a rule exists,
  synthesizes an implicit `local` session for that sweep — so the zero-rule
  case (a fresh install) stays a single fast SQLite read and never touches a
  snapshot/brief (same cost as the old no-op; the existing
  `test_evaluate_all_noop_without_sessions` still passes unmodified). A rule
  now fires with no WS session and no Supabase.
- **Delivery** (`intel/watch.py::_deliver_sinks`): reuses
  `workflows/control.py::send` (the IPv4-pinned, never-raising HTTP primitive)
  rather than the Workflows-block `dispatch` wrapper — there is no
  preview/dry-run or per-run dispatch budget concept for a standing alert, so
  bypassing that layer is deliberate, not an oversight. Discord gets
  `{"content": "[label] message"}` (its incoming-webhook contract); generic
  `webhook` gets the `alert_object` props as a `{"type": "watch.alert", ...}`
  envelope. Every attempt — success or failure — is logged to
  `alert_deliveries`, isolated so a bad sink can never stall the sweep
  (mirrors `_persist_firing` / `_maybe_cue`).
- Verified live (not just unit-tested): a rule created in the local store,
  evaluated with zero registered sessions and default (blank) Supabase
  settings, delivered a real HTTP POST to a real localhost receiver and logged
  the attempt — see the guard tests below for the mocked-network version of
  the same path.
- Guards: `apps/api/tests/test_watch.py` (`test_list_enabled_rules_reads_local_store_when_supabase_unset`,
  `test_evaluate_all_fires_keyless_local_rule_and_logs_delivery`),
  `apps/api/tests/test_alert_rules.py` (keyless CRUD + the Supabase-configured
  path kept exercised via targeted `get_settings` patching — `get_settings` is
  `@lru_cache(maxsize=1)` process-wide, so `monkeypatch.setenv` cannot move it
  once memoized; patch the name each module imports instead).
- Not done (named, not silently dropped): email channel is still unimplemented
  (route validates it, nothing sends it); no retry/backoff on a failed sink
  POST (logged as a failure, not retried — a flaky notifier is worse than
  none, per the roadmap's kill criterion, so this stays a future increment
  rather than rushed); no per-rule rate limiting on delivery (a loitering
  contact still only fires on ENTER/EXIT transitions, so this is bounded by
  the existing no-spam geofence design, not a new gap).

## Evidence locker + case→report export (2026-07-12)

Roadmap `docs/roadmap-practitioners-2026-07.md` P1+P2. The investigation loop
worked until you had to *prove* something: you could flag/promote entities and
build Situations, but nothing turned a case into a checkable document, and there
was no chain-of-custody capture primitive. Both now exist, backend-first.

- **Evidence = content-addressed ontology objects.** `app/intel/evidence.py`
  mints `evidence:<sha256>` where the SHA-256 is over the exact captured bytes
  at ingest — the hash IS the identity, so a mutated blob cannot masquerade as
  the original (its id changes). Immutable blob bytes live under
  `settings.evidence_dir` (`./data/evidence`, on the existing `osint_data`
  volume), sharded by the first two hex chars, written atomically
  (`.partial`→rename). The object (metadata + custody) lives in the ontology
  store; `props.kind="evidence"` so `list_by_kind` sees it (same convention as
  `situation`). `evidence` was added to `ObjectKind`/`_KNOWN_KINDS` in
  `intel/ontology.py`.
- **Custody rides the assertions table.** Every custody event (created,
  re-observed, linked, …) is one append-only assertion under the `custody` prop
  via `assert_props` — the substrate was built for exactly this; do NOT rebuild.
  The materialized blob keeps only the latest event; the chain is
  `get_assertions(id, prop="custody")`. Because the object id is the content
  hash, the ingest fact survives even if the per-object assertion cap
  (`ontology_max_assertions_per_object`, 2000) ever trims old custody rows.
- **Capture paths** (`routes/evidence.py`, all keyless — evidence capture is
  deliberately NOT an `is_compute_path` prefix so a bare `docker compose up`
  preserves evidence without `ALLOW_UNAUTHENTICATED`): URL fetch (stores the raw
  response bytes + status + selected headers; full headless render+screenshot is
  a documented stretch, per the kill criterion), file upload (hash + original
  bytes preserved), base64 screenshot attach, and **feed-freeze** (canonical
  JSON of an entity's live state → notarize a moment of the live world; unique
  to a self-hosted archive). The blob route re-verifies the hash and **409s on
  tamper** rather than serving bad evidence.
- **Case → report** (`app/intel/case_export.py`, named to avoid the unrelated
  entity-pattern-of-life `intel/dossier.py`): `POST
  /api/situations/{id}/export?fmt=html|json|pptx` walks the situation's 1-hop
  children, their sourced assertions, and attached evidence into a report where
  **every claim carries a provenance footnote** ("asserted by <source> at
  <observed_at>") and every exhibit shows its SHA-256 + a hash-of-hashes
  manifest. The HTML claim tables are driven purely off assertions (source +
  observed_at are non-null columns), so the "zero unfootnoted claims" invariant
  holds by construction. PPTX reuses python-pptx (503 if absent, mirroring
  `report_pptx`). Optional AI narrative is rendered ONLY inside the
  `AI_LABEL` block — the accepted-AI-use red line (labeled draft + human
  sign-off) is enforced at render, not trusted to the caller.
- **Attach** links `situation --evidence--> evidence:<sha>` (mirrors
  `situations.link_child`), so `traverse(depth=1)` surfaces exhibits in the
  situation detail and the export walks them.
- Guards: `tests/test_evidence.py` (12 — hash/custody/tamper/dedup/feed-freeze/
  manifest + full route surface incl. an offline URL capture) and
  `tests/test_case_export.py` (9 — bundle/every-claim-footnoted/AI-label/PPTX +
  routes). Baseline 1507 → 1533. `conftest._isolate_evidence_dir` points the
  blob dir at a temp dir per test (route handlers read the cached
  `get_settings()`, so this mirrors `override_db_path`).
- Not done (named): `evidence_of` inversion in `actions.py:191` left alone (its
  own incident→target semantic, own tests — out of this slice's scope); URL
  capture is byte-faithful but not a rendered screenshot; server-side LLM
  drafting is client-driven (frontend generates + human edits, export only
  renders the labeled result) so export stays deterministic + keyless.

## Rot-fix wave: dead probe, compose binding, email channel (2026-07-12)

Findings from the same-day state-of-project audit
(`docs/audits/2026-07-12-state-of-project.md`), all small and behavioral:

- **verify.sh `--live` vessel probe was dead since birth**: it GET
  `/api/ais/global`, which has never existed (AIS is WS-push only,
  `routes/ais.py`), so its bare `except` printed "skipped" on every run — a
  guard that could never fire. Now reads keyless `/api/status`
  `vessel_count` (the unified store's live count) and FAILS if the field
  disappears. Lesson repeated from the Supabase-backend deletion: a probe
  that can only skip is not a probe.
- **docker-compose.yml published nginx on all interfaces** while its own
  comment justified `ALLOW_UNAUTHENTICATED: 1` as "loopback-only". Now
  `127.0.0.1:8080:80`; exposing wider is a deliberate operator override or
  `docker-compose.prod.yml` (which fails closed). Open-mode compute routes
  (LLM, Workflows dispatch) were LAN-reachable on any `docker compose up`
  before this.
- **`email` alert channel rejected at creation** (400 with an explicit
  message) instead of accepted-and-never-delivered — closes the "Not done"
  named in the 2026-07-11 keyless-alerts entry the honest direction until a
  sender exists. Guard: `test_alert_rules.py::
  test_create_rejects_email_until_a_sender_exists`. Baseline 1539 → 1540.
- NOT changed, deliberately: watch-officer in-memory briefs (docstring
  documents restart-rederivation and `incident_store` diff state is also
  process-memory, so the story holds — the audit's first draft misread this
  as rot); replay interpolation; anything guarded above.

## Backend test baseline history

The current baseline lives in `CLAUDE.md` (Environment facts) and stays a
three-line fact there. One line per wave, newest first — when the CLAUDE.md
number changes, the displaced line lands here.

- **1708 +1 skip** — 2026-07-15, platform-hardening-and-copy-pass: AIS
  cache-freshness wave (frozen `:8093` union refused instead of republished as
  live, sidecar reuse/supervision/kill-escalation, honest AIS status feed).
- **1696 +1 skip** — 2026-07-15, platform-hardening-and-copy-pass:
  security-hardening wave (unauthenticated `/api/workflows` code-exec closed via
  the compute fail-closed gate, `/mcp` rate limit, `op.http` strict-SSRF opt-in,
  workflows.db + alert_rules.db retention caps).
- **1687 +1 skip** — 2026-07-15, dashboard-copy wave (house prose style for
  model output that renders in the dashboard, `test_prose_style.py`).
- **1675 +1 skip** — 2026-07-14, ui-typography-wcag-sidebar: aircraft
  predicted-motion wave (freshest-observation snapshot union + along-track
  no-reverse guards, `test_adsb_no_reverse.py`).
- **1662** — 2026-07-14: AI-workspace wave (dedicated AI hub app — agent +
  Watch Officer + engine/models; Watch Officer status/elaborate routes;
  sharper selection-brief prompt; end-to-end AI-route tests).
- **1645** — 2026-07-14: keyless data-layers wave (12 new feeds:
  hazards/env/oceans/space-weather/energy-infra/aviation, wired across
  route + MCP + globe layer + ontology).
- **1630** — real-place strike-areas wave (geoBoundaries admin-polygon
  resolver + feed iso3/shape_level enrichment + AreaAdapter polygons).
- **1583** — intel-depth wave (2026-07-13).
- **1540** — rot-fix wave (2026-07-12).
- **1539** — evidence-locker hardening wave.
- **1536** — selection-brief enrichment-fusion wave.
- **1533** — evidence-locker + case-export wave (2026-07-12).
- **1507** — bug-fix wave (PR #38, 2026-07-12).
- **1294** — w5-places-airspace-enrichment (2026-07-11).

## Lessons from past sessions (post-mortems)

### A cached tier that stamps wall-clock time is immortal AND wins (2026-07-15)
The exact ADS-B `seen_pos_s` lesson recorded in *Aircraft predicted motion*
above ("a cached tier reports 0.3 s forever"), repeated in the AIS path ten days
after that fix landed. Found by reading `/tmp/ais-sidecar-myshiptracking.log`,
not by any alarm — nothing was red.

The MyShipTracking feeder's browser lost the site at 12:54 UTC. By design it
replays its last good world sweep (`pump()` keeps `latest` when a sweep is below
the vessel floor), and `/vessels.json` served that union under `now =
Date.now()` — the SERVE time. `_publish_myshiptracking` then stamped
`t=time.time()` on all 22 837 of them, every 30 s, forever. Measured before the
fix, 27 minutes in:

- Two `:8093` pulls 45 s apart: `now` advanced 45.1 s, **0 of 22 837 vessels
  moved**. `/health` said `age_s: 868` — the honest stamp existed and nobody
  read it.
- **21 944 of 57 174 vessels (38%) in `/api/maritime/snapshot` were the frozen
  cache**, every position matching it exactly, served as live.
- ShipXplorer — live, global, MMSI-keyed — won **0** of the MMSIs the frozen
  tier carried. Because `ObservationStore.add_many` is last-write-wins and the
  30 s poller always wrote last with a fresh `t`, the stale tier deterministically
  clobbered the live one, and the fresh `t` meant retention never evicted it.
- `/api/status` read **green**, "58012 vessels": the AIS feed had no age check
  (ADS-B has `aircraft_age_s`), and the other sources' real vessels hid the hole.

Three defects, one story — a freshness signal that existed but was dropped at
every boundary. Fixed: `/vessels.json` carries `last_good`/`age_s`; the poller
stamps `t` from `last_good` and REFUSES a union older than 180 s (going silent
lets the frozen fixes age out so live sources retake the MMSI); `/api/status`
degrades and says so.

Two structural traps this exposed, both fixed the same day:
- **`_already_healthy` accepted any 200.** A wedged feeder answers 200 forever,
  so every restart re-adopted the frozen tier — no restart could clear it. It
  now refuses a union older than the poller's cap and evicts the port holder.
  (`age_s: null` = warming, still healthy — never fight the first sweep.)
- **Nothing supervised the sidecars.** `start()` ran once at lifespan boot, so a
  feeder that died later stayed dead until the next restart with the tier
  silently empty — the same trap already known for the ADS-B twin on `:8090`.
  It bit again here: a restart's `start()` ADOPTED the outgoing backend's
  sidecar (still listening, health 200) moments before that backend's `stop()`
  killed it. `ais_sidecar.supervise()` now re-`start()`s any enabled feeder that
  stops serving (proven live: SIGKILL → respawned in 44 s). Related: `stop()`
  only escalated to SIGKILL for a SPAWNED child, so a reused wedged pid got
  SIGTERM and ignored it (measured: still LISTENing 12 s later, gone 2 s after
  SIGKILL) — every pid now routes through the escalating `_kill_pid`.

Guards: `tests/test_ais_keyless.py` (stamp + refuse), `tests/test_ais_sidecar_reuse.py`
(reuse/supervise/escalate), `tests/test_status.py` (honest AIS feed).

**The transferable rule:** any tier that can serve a CACHE must publish the age
of the data, not the age of the response, and its consumer must refuse it past a
cap. `now` at the serve boundary is not a freshness signal. When a store is
last-write-wins, an optimistic timestamp is a correctness bug, not a rounding
one.

STILL LATENT, by choice — the VesselFinder (`:8091`) and MarineTraffic (`:8092`)
feeders carry the identical `lastGood` + 180 s replay pattern, and
`_publish_vesselfinder` / `_publish_marinetraffic` still stamp `t=now`. Both are
OFF by default so neither can bite today; enabling either without porting the
`last_good` + cap fix re-opens exactly this bug. (`_publish_shipxplorer` also
stamps `t=now` and is fine — it is a live direct poll with no cache behind it,
which is the distinction that matters: cache → honest age, live fetch → `now`.)

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

### Typography & WCAG-AA legibility pass (2026-07-13)
Operator feedback: the UI "looks AI", newcomers/older users struggle, the
sidebar won't extend to show all the info, and WCAG rules aren't followed.
Three findings, all fixed surgically (not a rebuild):

1. **"Looks AI" was the type system, not the face.** Body was 11px on a 10px
   floor with uppercase 0.8px-tracked eyebrow labels applied nearly everywhere
   (~1,368 literals). Inter stays (Stripe/GitHub ship it). The floor went to
   11px (`--fs-body 13 / -dense 12 / -caption 11`; html/body 13px), and the two
   STRUCTURAL instrument primitives — `SectionLabel` and `KVRow` keys — became
   sentence case (`shell/instruments.tsx`). This actually enforces the existing
   `frontend.md` spec ("sentence case everywhere except machine codes"), which
   the code had drifted from. `MicroLabel`/`Badge`/`Caveat` KEEP mono-caps —
   they are the sanctioned machine/status voice (MMSI, UNCLAS, units). The
   ~203 inline `uppercase tracking-[…]` leaf sites (LayerRail groups, Foundry,
   Inbox, …) are a deliberate phase-2 follow-up, not done here.
2. **WCAG-AA contrast.** Only `--txt-3`/`--txt-4` failed, in BOTH themes (dark
   2.81:1 / 1.71:1; light 3.04:1 / 2.14:1) while carrying LIVE text (not just
   disabled controls, so not WCAG-exempt). The whole muted ramp (`--txt-2/3/4`)
   was re-solved to clear 4.5:1 on both bg-1 and the lighter card bg-2, keeping
   a monotonic txt-0>1>2>3>4 ramp. Guarded by `theme/contrast.test.ts` (parses
   tokens.css, asserts AA per tier per theme) — the executable invariant.
3. **Sidebar "extend to see all the info".** The right rail always resized
   (260–680px) but had no visible affordance and the EntityPanel didn't reflow.
   Added: a visible + keyboard-operable resize grip (`RailResizer`, WAI-ARIA
   separator: arrows/Home/End), an in-rail header with a **Wide** toggle
   (snaps to a 560px reading width) and a **Detach** button that pops the
   inspector into a floating window — reusing the existing `floatingPanels`
   store + `FloatingPanel` (same substrate the left rail uses). Right-rail width
   lifted into `state/railWidth.ts` (still persists `csl.rightW`, still
   publishes `--rail-right-w`). At ≥500px content the EntityPanel card stack
   reflows to two columns via a pure `@container` query (`theme/reflow.css`,
   `.ep-stack`/`.ep-span`) — no JS width plumbing. Verified live: sentence-case
   cards, wide-mode 2-col, detach, light-theme all screenshotted.

Known follow-ups (not regressions): the right rail bg is still a hardcoded dark
`RAIL_BG` (not tokenized) so light theme shows light text on a dark rail;
phase-2 leaf-site sentence-case sweep.

### Aircraft predicted motion: exact speed, never reverse (2026-07-14)

Operator: *"the predicted motion speed must be the actual speed, not faster or
slower, and the plane sometime goes in reverse, that is not accepted. this must
be on par with flight radar 24 level."*

Two independent defects, one in each half of the stack. Both had to be fixed —
no frontend motion model can fix a feed that moves aircraft backwards.

**Backend: the tier merge was last-writer-wins.** `_build_snapshot` merged
OpenSky → feeds → firehose → grid, and `_merge_raw_into` overwrote
unconditionally; its docstring stated the assumption outright ("caller orders
sources so the freshest source is merged last"). That assumption is inverted:
tier 3 serves `_FIREHOSE_RAW`, a cache that only changes when a pull SUCCEEDS
and **never expires**, and from this egress the only reachable firehose verb
(adsb.lol `/v2/point`, since airplanes.live and adsb.lol `/v2/all-with-pos`
404 and adsb.fi 403) takes **>60 s** to download. So a minutes-old fix
overwrote the 0.1 s-old sidecar fix on every 1 s cycle, and flipped back
whenever an aircraft fell outside the firehose's smaller (~8-9k vs ~20k)
coverage. Measured on `/api/adsb/global`, warm: **9.2% of airborne moves
regressed along the aircraft's own `track_deg`** (median **-3.8 km**, worst
**-161 km**), 5,531 distinct aircraft in 60 s.

Note `seen_pos_s` is the age at UPSTREAM serve time, so a cached tier reports
0.3 s forever. The only cross-tier-comparable stamp is
`seen_at - seen_pos_s` (`_feat_obs_at`) — it ages a cache honestly, because
`_seen_at` is stamped once at pull time. `_readsb_feeds` already folds
`slice_age` in for exactly this reason WITHIN the feeds tier; the top-level
merge had no equivalent. Fixed: freshest-observation-wins (order-independent),
plus a `_regresses` guard that drops a fix flying a fast airborne contact
backwards, plus rearming `_FIREHOSE_NEXT_TRY` on success (only the failure path
armed it, so a working firehose was re-downloaded every tick against a host
CLAUDE.md documents as rate-limiting). → `tests/test_adsb_no_reverse.py`.
Result: 9.2% → **1.09%**.

Freshness only overrides order where it is KNOWN — if neither side carries a
stamp, tier order still decides (that is what `test_grid_overlay_wins_conflict`
pins, and it is right: the grid IS fresher than a daily OpenSky cache).

**Frontend: the glide had no relationship to the reported speed.** The old
`deadReckonSample` EASED from the rendered position to the new fix over the
inter-fix gap, so apparent speed was `dist/gap` — arbitrary — and when a stale
fix landed behind the icon it GLIDED backwards over up to 30 s. Measured live
in the browser: **only 80.2% of rendered steps were within ±1% of the reported
`velocity_ms` (p05 = -68%, i.e. planes crawling at a third of their true
speed), 5.64% of steps went backwards, and 65.7% of backward episodes lasted
more than one frame — visibly flying in reverse.**

Replaced by an analytic anchor model (`globe/adapters/deadReckon.ts`, pure +
unit-tested):

    position(t) = advance(anchor, track_deg, velocity_ms * max(0, t - t0))

`advance` steps along WGS84 using the local radii of curvature, so |dP/dt| ==
`velocity_ms` EXACTLY; `max(0, …)` makes along-track distance monotonically
non-decreasing, so it cannot reverse even if the clock is scrubbed. Rendered
via `CallbackPositionProperty` — the motion is analytic, there is nothing to
interpolate. Measured live after: **98.1% within ±1% (p50 error 0.0000, p95
0.05%), reverse 0.034% (166× fewer), and exactly ONE episode lasting >1 frame.**

Supporting decisions, all load-bearing:
- **Never fit velocity from consecutive fixes.** Measured: only **13.5%** of
  consecutive same-source fix pairs give a great-circle speed within ±10% of
  the reported `velocity_ms` (median error +47%); `seen_at - seen_pos_s` is far
  too coarse a timebase to differentiate. `velocity_ms`/`track_deg` are the
  aircraft's OWN downlinked GNSS values — authoritative. Positions are the noisy
  signal. (This killed both an earlier velocity-fit cut AND a playout-buffer
  design that would have interpolated between real fixes.)
- **Anchor at the fix's observation time**, not receipt, so an aged fix renders
  already carried forward.
- **A lone backward fix is IGNORED** (`DR_BACK_TOLERATE`); only consecutive
  agreement re-anchors backwards. This is a tolerance, not a veto — a real
  reposition still corrects in ~18 s at the measured 6 s cadence.
- **Stale fixes are NOT projected** (`DR_MAX_FIX_AGE_S = 45`): position age is
  p50 2.9 s but p90 68.9 s / p95 183.8 s (the OpenSky breadth tier, a
  once-per-UTC-day cache). Flying a 3-minute-old fix forward invents ~45 km.
  Those contacts hold — but they still get the backward guard
  (`DR_FROZEN_BACK_M`), because a frozen contact mirrors the feed verbatim and
  that was the LAST source of sustained reverse (runs of up to 12 frames).
- On-ground/parked contacts are exempt from every backward guard — pushback is
  literally backwards.

Do NOT reintroduce any easing/interpolation toward a fix: that is what made the
speed arbitrary and the reverse visible. The default TELEPORT path is unchanged
and still forbids extrapolation. → `globe/adapters/deadReckon.test.ts`.

### Dashboard copy: one voice, no em dashes (2026-07-15)

Operator: *"improve wording for the whole dashboard, remove em dashes. make it
feel more human and use PROFESSIONAL LANGUAGE ONLY."*

Follow-on to the 2026-07-13 typography pass, which found that "looks AI" was the
type system rather than the typeface. The same verdict applies to the words: the
tell was punctuation and register, not vocabulary.

**Scope was the hard part.** The repo had ~1,490 em dashes. Only ~320 were
dashboard copy:

- **~1,056 are in code comments** and carry decision history. Comments are not
  dashboard wording. They were left alone, deliberately, in every file.
- **~91 are the standalone `'—'` null placeholder** in tables and KV rows,
  meaning "no value reported". That is a data convention, not prose, and it is
  guarded by `entity-panel/placeCards.test.tsx` ("shows — for ILS CAT on a
  non-US runway rather than guessing"). It implements the §7 never-guess rule.
  Untouched. Do not "finish the job" by stripping these: it breaks a guard and
  reintroduces guessing.

**Two patterns, not one substitution.** Mechanically swapping every ` — ` for a
colon just trades one tic for another.

- *Labels* (`'Quakes — USGS (24h)'`, `'Aircraft — Military'`) use ` · `. The
  subject-first word order is load-bearing: it clusters sibling layers in the
  rail. Reflowing to `'USGS quakes'` breaks that and was rejected.
- *Prose* is rewritten per sentence (period, comma, colon, semicolon, or
  parentheses, whichever actually fits).

**Caveats survive verbatim in meaning.** This is an intelligence tool. Rewrites
of "notional war-game entity — not a real contact", "shortlist, not a positive
ID", and the vessel MISMATCH/spoof verdict preserved every warning, hedge,
number, and unit. Copy changes must never soften an epistemic claim.

**The static strings were only half the dashboard.** Selection briefs,
pattern-of-life, the watch-officer read, country briefs, and news analysis are
model prose rendered verbatim, and the prompts both contained em dashes and
never constrained output style. A model copies the register of its instructions,
so the prompts demonstrated the exact habit we were removing. Fixed with one
shared rider, `llm.PROSE_STYLE` + `llm.with_prose_style()`, appended LAST so the
caller's format contract (STRICT JSON, markdown headings) is stated first and
wins on conflict. It is style-only and never touches grounding or hedging rules.

In `news/analyze.py` the rider goes BEFORE `_INJECTION_GUARD`: the guard is a
security control and stays the last thing the model reads, so nothing follows
the untrusted-content boundary that could dilute it.
→ `tests/test_prose_style.py`

**Error copy (same wave).** Operator: *"all text must be professional."* Raw
internals were rendering as user text: `CamerasPanel.tsx` caught
`new Error(\`cams ${r.status}\`)` into `setErr` and rendered `{err}`, so the UI
literally read **"cams 503"**. Two operator decisions:

1. **Lowercase micro-labels STAY** (`loading…`, `no saved maps`, `saving…`,
   `point added ✓`). That terse register is deliberate ops-terminal design
   language, not sloppiness. Do not sentence-case it.
2. **Errors are readable sentences that KEEP the status code**:
   `cams 503` → `Cameras unavailable (HTTP 503)`; `save failed` → `Could not
   save the map.`; `network error` → `Network error. Check your connection.`

Three traps found while doing it, all of which look like copy and are not:
- **State-machine values.** `ChipLayer.tsx` `setStatus('idle'|'loading'|'error')`
  and Foundry's `status: 'running' | 'succeeded' | 'failed'` are enums compared
  with `===`. Rewriting them as "copy" breaks logic.
- **Parsed sentinels.** `CatalogBrowser`'s `'error:<msg>'` job-id prefix is read
  by `isErrorJob`/`.slice()`; `DossierNarrativeCard` compares
  `data.error === 'model unavailable'`.
- **Dead text.** `acars ${r.status}`, `chip ${r.status}`, `overpass ${r.status}`,
  and `cams ${r.status}` in TrafficSimSection are all thrown into `.catch(() =>
  …)` handlers that take no argument, so the message never reaches the DOM.
  They are developer diagnostics and were deliberately LEFT.

Rule that falls out: **trace a string to a render before rewriting it.** Also
kept intact: the evidence locker's forensic warnings (`hash MISMATCH: blob
altered or missing`) and every `'—'` null placeholder.
