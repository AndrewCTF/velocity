# AGENTS.md — Hard guardrails for any AI agent editing this repo

## Operator-visible behaviour that MUST hold

These are sacred. Subagents reviewing this file MUST verify their edit does
not regress any of them. If unsure, leave the relevant code path alone.

### Icons

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

### Refresh smoothness

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
- **NEVER synthesize/predict aircraft motion — real observed fixes only.** Teleport
  shows ONLY real fixes; do NOT add interpolation, forward-extrapolation, or
  dead-reckoning to "smooth" it — that re-introduces the fake motion the operator
  rejected. The glide model (`upsertAircraftSamples`) was REMOVED in the teleport
  change; reverting to glide is a `git` revert, not a rewrite. VESSELS still glide
  via `SampledPositionProperty` + `LinearApproximation` (slow movers) — do not
  change that. Aircraft smoothness, if ever wanted again, comes from delivering
  REAL fixes faster + steadier (backend cadence, feed freshness), never from
  inventing positions.
- `requestRenderMode: true` must stay on, BUT `maximumRenderTimeChange: 0`
  (GlobeCanvas viewer opts) so the scene re-renders every frame the simulation
  clock advances — that is what makes `SampledPositionProperty` interpolation
  play SMOOTHLY between fixes instead of hopping once per poll (the "teleport"
  report). When the timeline is paused (`shouldAnimate` false) the clock is
  frozen, nothing changes, and the scene idles — so requestRenderMode still
  saves GPU. Do not set `maximumRenderTimeChange` back to `Infinity`. Follow
  (`camera.ts`) flips `requestRenderMode` off for its duration and restores it.
- **World-view decimation MUST be STABLE across polls.** At near-global zoom the
  frontend asks `/api/adsb/global?limit=20000` (no bbox); `viewport_filter`
  (`routes/adsb.py`) serves the full union (a ~13k snapshot ships WHOLE — the
  operator wants the real count, not a 4000 sample) and only decimates if the union
  exceeds 20000. When it does, it keeps a deterministic subset keyed by
  `md5(feature id)` (live tier — non-`opensky` source — first). It must
  NOT use a positional stride (`feats[int(i*stride)]`): the snapshot's order and
  count shift every refresh, so a stride resampled a DIFFERENT 4000 each poll →
  the upsert-by-id frontend churned ~half its entities every second (measured
  112% id churn / 2.5 s), which RESET the motion model so aircraft never lived
  long enough to glide and sat frozen at world view. Never key the sort on an
  age field (`seen_pos_s`/`seen_at`) — those tick every snapshot and reintroduce
  the churn. Guarded by `tests/test_adsb_viewport_stable.py`.

### Refresh cadence

- ADS-B global: 1 s frontend poll (`registry/defaults.ts` `ttlSec: 1`), backend
  sticky snapshot on a 2 s target cycle (`_SNAPSHOT_TARGET_CYCLE_S`), and each
  fan-out is wall-clock-capped at 10 s (`_FANOUT_BUDGET_S`). The 1 s poll is
  cheap (the hot route serves the sticky snapshot in microseconds); motion
  between polls is interpolated + rendered every frame. Do not raise the poll
  above 10 s.
- **Backend is HOT at boot.** `main.py` lifespan calls `adsb_routes.start_snapshot()`
  so the refresher fills `_LATEST_SNAPSHOT` before the first browser request. Do NOT
  remove it — without it the first `/api/adsb/global` runs a 1–10 s synchronous
  fan-out under `_SNAPSHOT_BOOTSTRAP_LOCK` (the "takes seconds to start loading" stall).
- **World-view payload is pre-rendered, not per-request.** The refresher builds a
  gzipped blob of the FULL snapshot (capped at `_WORLD_LIMIT` = 20000, the route
  ceiling — so a ~13k union ships WHOLE) ONCE per cycle (`_build_hot_blob` via
  `asyncio.to_thread`) and stores `_HOT_BLOB`/`_HOT_ETAG`. `adsb_global` serves those
  bytes verbatim for any no-bbox request that carries a limit (the world view) with
  `Content-Encoding: gzip` + ETag/304 — constant-time, so latency is uniform (measured
  p50 ~4 ms). Do NOT move the md5-sort decimation / JSON serialize / gzip back onto the
  request path — that per-request CPU (variable, contending with the 2 s fan-out) was
  the "short long short long" cadence. The fast path is decoupled from the exact limit
  value, so a frontend asking 4000 or 20000 both get the blob (no version lockstep).
  Guarded by `tests/test_adsb_hot_blob.py`.
- **`/ws/adsb` push is the PRIMARY live transport.** The refresher fans `_HOT_BLOB` to
  all subscribers (`_broadcast_blob`, per-send timeout + drop-on-error) each cycle, so
  the client cadence is server-timed (~2 s, no request round-trip in the loop — measured
  steady 1.9–2.1 s vs the old jitter). `require_ws_key` BEFORE `accept`; sends the blob
  on connect for instant first paint. The browser inflates the binary frame with
  `DecompressionStream('gzip')` → `render()` (same upsert/glide owner as the poll). The
  HTTP poll is the FALLBACK (socket down) + the zoomed bbox path; `PollGeoJsonAdapter`
  suppresses it only while `wsActive && isWorldView()`.
- **Frontend cadence is an absolute wall-clock grid**, NOT `max(ttl - elapsed, 250)`.
  `scheduleNext` books each tick against `nextAt += ttl` so a slow poll's `elapsed`
  (fetch + render of up to 20 k entities) no longer leaks into the gap; re-anchors after
  an overrun instead of sprinting. Do NOT restore the elapsed-coupled formula.
- Internal consumers of the snapshot (jamming, intel, analytics, correlate)
  MUST call `global_snapshot()`, never the `adsb_global()` route handler in
  process — the handler's `Query(...)` defaults reach `viewport_filter` and 500
  ('>' not supported between instances of 'Query'). This broke the jamming layer.
- AIS Digitraffic: 30 s (Baltic only). AISStream WS: live push (needs key).
  Sentinel-1 SAR dark-vessel layer (`maritime.sar.hormuz`): 6 h poll — the only
  keyless vessel coverage for the Strait of Hormuz.

### Aircraft count + sources (operator-visible)

- **The global snapshot must carry ≥8 000 aircraft** in steady state (~13 k is
  normal). A drop to a few hundred/thousand is a regression — see the
  `airplanes.live rate-limit 200+text` post-mortem.
- The feed is a UNION of tiers, deduped by `aircraft:<icao24>`
  (`apps/api/app/routes/adsb.py:_do_global_fanout`), freshest wins:
  1. **OpenSky `/states/all`** — the ~13 k breadth source. Works keyless
     (anonymous IP budget); falls back from authed→anonymous on 429. Pulled
     once on boot, then once per UTC day at 00:00 UTC when the credit budget
     resets (`_opensky_cached` / `_utc_day`), and cached + served between pulls,
     so the count holds all day on ~4 credits.
  2. **airplanes.live `/v2/point` grid** (`_GLOBAL_GRID`, 130+ cells) —
     dense-region freshness overlay, time-boxed (8 s) so a throttled grid can
     never stall the snapshot. Densify the grid only — never thin out.
- Upstream burst semaphore is **8** (`_UPSTREAM_SEMAPHORE`): airplanes.live
  rate-limits above ~8 concurrent `/v2/point` calls, and its limiter answers
  with HTTP 200 + a `text/plain` body (NOT just 429) — `_parse_ac` must reject
  non-JSON bodies, and `load_cell` must RAISE (not cache empty) on all-host
  failure. Do not "simplify" either away.
- The single-shot firehose URLs (`_FIREHOSE_URLS`) are dead from most egress
  IPs (airplanes.live `/v2/all*` 404, adsb.lol 451, adsb.fi 403) and are tried
  opportunistically with a 30 s dead-skip. OpenSky is the real breadth source.

### Labels

- Every aircraft has a label (callsign → registration → ICAO24).
- Every vessel has a label (name → MMSI fallback).
- Labels share `apps/web/src/globe/adapters/labelStyle.ts` (`labelFor`,
  `aircraftLabelText`, `vesselLabelText`). Bold IBM Plex Mono 11px, dark pill
  background, fill+outline. Do not duplicate or fork this style.

### Satellites (CelesTrak)

- Curated CelesTrak group layers (`space.celestrak.{stations,starlink,gps,visual}`
  in `apps/web/src/registry/defaults.ts`), keyless, off by default. `LayerCompositor`
  dispatch matches `space.celestrak.*` and parses the group from the endpoint query.
- **Positions are SGP4-propagated client-side** from CelesTrak TLEs by
  `SatelliteAdapter` (`satellite.js`). SGP4-from-current-TLE IS a satellite's
  authoritative position — there is NO separate observed-fix feed — so this is
  REAL physics, NOT the forbidden ADS-B motion synthesis. The no-extrapolate
  aircraft rule does NOT apply to orbits.
- **Motion model = `SampledPositionProperty` fed by SGP4-sampled orbit windows**,
  interpolated by Cesium every frame (rides the same animating clock +
  `maximumRenderTimeChange:0` as aircraft). Do NOT revert to reassigning a
  `ConstantPositionProperty` every tick — that teleported each satellite once per
  tick (the 5 s hop). Propagation + `twoline2satrec` are CHUNKED across frames
  (per-frame budget + lazy satrec build); never bulk-propagate synchronously (a
  ~100 ms main-thread hitch at the `MAX_SATS` 4 k cap).
- Backend `/api/space/gp` MUST request **`FORMAT=tle`**, not `json`: the OMM JSON
  variant omits `TLE_LINE1/2`, which the client SGP4 parser requires — `json` →
  ZERO satellites rendered. It sends a browser UA and caches 2 h (CelesTrak
  403-rate-limits bursts; one pull per group per 2 h stays under the limit).
  Starlink is truncated to `MAX_SATS`; the title makes no completeness claim.

### Layers that must always work without any API key

- ADSB.lol + airplanes.live global ADS-B grid (no auth).
- Digitraffic Finland Baltic AIS (no auth).
- NASA FIRMS — needs MAP_KEY for fires (degrade gracefully when missing).
- USGS quakes (no auth).
- Carto Dark Matter basemap proxied via `/tiles/basemap` (no auth).
- CelesTrak satellites via `/api/space/gp?group=…` (no auth, `FORMAT=tle`).

### Auth

- `apiFetch` and `withWsKey` wrap every browser → backend call. Do not bypass
  with raw `fetch` or raw `new WebSocket`. New transport must use them.
- WS handlers call `require_ws_key` BEFORE `accept`.

### Tests / typecheck

- `pnpm -r typecheck` must be green at every commit boundary.
- `cd apps/api && .venv/bin/pytest -q` must hold at ≥25 passed.

## Subagent rules of engagement

- One file, one owner. Multiple subagents may not edit the same file
  simultaneously. The dispatcher must serialise edits to a shared file or
  scope the brief to disjoint files.
- A subagent that "rewrites" `aircraftStyle`, `vesselStyle`, or
  `PollGeoJsonAdapter.applyStyle` MUST keep the SVG icons. Do not "simplify"
  to `Cesium.PointGraphics` unless explicitly asked.
- A subagent that touches `tracks.ts` dedup MUST keep at least one push per
  60 s OR 5° displacement so the selection polyline always has ≥2 points.
- A subagent that touches `requestRenderMode` MUST leave it `true` for the
  default scene.

## Verification before claiming done

- Boot the app, drag the camera to Europe, confirm hundreds of yellow
  airliners + orange military + green cargo icons (NOT dots).
- Click an aircraft, confirm the EntityPanel populates AND the magenta track
  polyline appears within 4 s.
- Click an empty area, confirm the polyline + reticle clear.
- Stay on the page for 30 s and confirm icons don't blink off-then-on.

## Lessons from past sessions — DO NOT repeat these mistakes

These are real failures from prior work on this repo. Each cost the operator
time or eroded trust. Read them before claiming coverage, building a feed, or
shipping.

### Never claim coverage/parity without a measurement

- A prior session called the keyless AIS firehose "global" in code, a commit
  message, AND `/api/intel/sources` — it was **Norway-only** (Kystverket). It
  also asserted keyless aircraft was "already satisfied (~13k = the full
  picture)" — it was ~60 % of what FlightAware sees, and more keyless sources
  existed. The operator had to push back twice before the numbers were checked.
- RULE: the words **global / complete / full / already covered / parity** are
  banned from code, comments, commits, and docs unless a live probe with a
  COUNT backs them up that turn. Prefer "Northern Europe (~18 k)" over "global".
  When unsure of coverage, MEASURE (probe the endpoint, count distinct ids)
  before you write a single claim.

### "Configured" ≠ "working"

- `/api/intel/sources` showed `opensky_authed: true` simply because creds were
  *set* — but the creds were expired and every authed call 401'd. A `bool(key)`
  check proves nothing about whether the upstream actually answers.
- RULE: to claim a source works, hit it and read the status/count. A set key is
  not a working key.

### Exhaust the data-source search before declaring a ceiling

- A session concluded "keyless aircraft caps at ~12.7 k, the aggregators block
  datacenter IPs, 21 k is impossible" — then the operator pointed at tar1090 /
  sdr-enthusiasts and there WAS more: open mirrors (`globe.theairtraffic.com`,
  `skylink.hpradar.com`), the `api.adsb.lol/v2/point/0/0/20000` full-snapshot
  quirk, and a headless-browser bridge that reads tar1090's own
  `g.planesOrdered` (~14.6 k). "Whole globe" means try harder: more hosts, the
  ecosystem's own tooling, a real browser for Cloudflare-gated sites.

### Feed hygiene (ADS-B / AIS upstreams)

- Feeds pull in a BACKGROUND task (`_pull_due_feeds`) on per-feed cadences, so a
  slow body never blocks the fan-out. `theairtraffic` is the freshness PRIMARY
  (~10k aircraft, position age median ~1.6 s, ~5 MB body downloading in ~2 s from
  current egress) and is pulled fast (~8 s) — the old 30 s throttle was sized for
  a 4-9 s download that no longer holds. Each readsb `aircraft.json` is several
  MB, so don't drop the mirror cadences to ~1 s; ~5-8 s is the freshness/bandwidth
  balance. Smoothness for the operator comes from delivering REAL fixes fast +
  steady, NOT from synthesizing motion (dead-reckoning is forbidden — see the
  motion guardrail above).
- Some hosts (adsb.lol) answer **HTTP 451 to a non-browser User-Agent** — feed
  fetches must send a real browser UA. airplanes.live/adsb.fi/adsb.one
  Cloudflare-block datacenter IPs entirely; only `theairtraffic` + `hpradar`
  serve open `aircraft.json` keyless from a server.
- AISStream has an API cap — keep it ON DEMAND (started on `/ws/ais` connect,
  stopped when the last viewer leaves). Keyless firehoses stay always-on.

### Playwright: pass FUNCTIONS to `page.evaluate`, not strings

- `page.evaluate("() => {...}")` evaluates the string as an EXPRESSION and
  returns the function object — it never CALLS it. A reader defined as a
  template-string constant silently returned nothing and the
  `tools/adsb-globe-feeder` sidecar served 0 aircraft for many debugging turns.
  Define real functions and pass `page.evaluate(fn, arg)`.
- The headless globe-feeder only works because it keeps ONE page open and reads
  the store; do NOT re-move the map on every read (that resets tar1090's load) —
  zoom to world once, then read, and nudge only ~once/30 s.

### Process / shell discipline

- `pkill -f "<path>/index.js"` does NOT match a process whose argv is just
  `node index.js`. Find a server by its PORT holder
  (`ss -ltnp | grep ':<port>'` → kill that pid), not a guessed argv pattern.
  Repeated stale processes here caused EADDRINUSE and a stale log that masked
  whether new code was even running. Use a fresh log file per run.

### Commit / doc voice

- Commits are stripped of AI attribution by a global hook AND the operator wants
  human-style messages (see auto-memory `global-commit-msg-ai-scrub-hook`). Do
  not add `Co-Authored-By`/"Generated with" lines. Write what was measured, not
  marketing ("union climbs to ~14k", not "now global").
- Keep the repo root tidy: no dev/proof screenshots committed (gitignored), docs
  live under `docs/`. App art is SVG in code, not PNG files.
