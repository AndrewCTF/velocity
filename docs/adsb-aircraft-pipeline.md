# ADS-B aircraft pipeline

How the global aircraft feed gets ~13 000 aircraft onto the globe at a ~1 s
perceived refresh, using only free/keyless upstreams.

**Code:** `apps/api/app/routes/adsb.py` · **Endpoint:** `GET /api/adsb/global`
· **Frontend:** `apps/web/src/registry/defaults.ts` (`aviation.adsb.global`,
`ttlSec: 1`) rendered by `PollGeoJsonAdapter`.

---

## TL;DR

- The snapshot is a **union of tiers**, deduped by feature id
  `aircraft:<icao24>`, freshest source wins:
  1. **OpenSky `/states/all`** — global breadth, ~13 k aircraft.
  2. **airplanes.live `/v2/point` grid** — dense-region freshness overlay.
  3. **Opportunistic single-shot firehose** — used only where reachable.
- A **sticky background snapshot** refreshes on a ~1 s cycle; the hot route
  returns the last complete snapshot in microseconds (never blocks on the
  fan-out).
- The frontend polls every 1 s and **interpolates** positions
  (`SampledPositionProperty` + `LinearApproximation`), so motion is smooth even
  though upstream data only updates every 5–15 s.

---

## Why it's built this way

A single global query is the only way to reach ~13 k aircraft, but the free
aggregators don't offer one (verified 2026-06 from a typical egress IP):

| Host | Global verb | Result |
|---|---|---|
| airplanes.live | `/v2/all`, `/v2/all-with-pos` | **404** (no such endpoint) |
| adsb.lol | `/v2/all-with-pos` | **451** legal block (+ AAAA breaks IPv4 pin) |
| adsb.fi | `/v2/snapshot` | **403** |
| **OpenSky** | **`/states/all`** | **200, ~13 k aircraft, anonymous OK** |

So **OpenSky is the breadth source** and airplanes.live `/v2/point` (≤250 nm
radius, works fine) is the dense-region freshness overlay.

---

## The fan-out (`_do_global_fanout`)

Runs the tiers **concurrently** and merges by id (later = fresher wins):

```
osky_task  = _opensky_cached()      # breadth ~13k — INSTANT cached read, bg pull
fh_task    = _firehose_throttled()  # opportunistic single-shot — INSTANT, bg pull
grid_task  = _grid_fanout()         # airplanes.live /v2/point cells

by_id  = {opensky features}
by_id ∪= {firehose features}        # overwrite
by_id ∪= {grid features}            # overwrite — freshest, merged last
                                     #   BUT time-boxed to _GRID_BUDGET_S (8s)
```

The grid is **time-boxed**: a throttled airplanes.live (slow per-cell
host-walks) must never stall the OpenSky-driven snapshot. Grid cells that don't
finish in the budget are abandoned for the tick; cells that did finish are
cached, so the next tick reads them warm and completes fast.

The **feed tiers never block the fan-out.** `_opensky_cached` and
`_firehose_throttled` are instant cached reads: when a refresh is due they kick
the actual pull into a **background task** and return the last good payload
immediately. Without this, a 5-6 MB `/states/all` (or firehose mirror) download
froze the snapshot for the ~several seconds of the transfer on every refresh —
the cadence drag this design removes. The grid's 8 s time-box is the only thing
that can make a tick slow, and only when many cells are cold.

### OpenSky tier (`_opensky_cached` / `_try_opensky_global`)

- **Anonymous-capable.** `fetch_states` omits the `Authorization` header when no
  creds are configured; OpenSky still serves anonymous `/states/all`.
- **Two budgets.** Try authed (env `opensky_client_id`/`secret`, larger daily
  pool, 5 s resolution); on `429` (authed pool spent) retry on the **separate
  anonymous per-IP budget** (~400 credits/day, 10 s resolution). 4 credits per
  global call.
- **Throttled + cached + background.** Pull at most once per
  `_OPENSKY_INTERVAL_S` (15 s); serve the cached FeatureCollection on every tick
  in between. The pull runs in a **background task** (`_opensky_refresh_once`) —
  the hot read never awaits the 5-6 MB download. Because the cached FC is served
  until a newer pull replaces it, **the aircraft count holds even after the
  daily budget is spent** — only position freshness for OpenSky-only (oceanic)
  contacts degrades, while the grid keeps dense regions live.
- **Daily circuit breaker.** On ANY failed pull (429 budget-spent, network,
  parse) OpenSky is **disabled until the next 0000 UTC** reset
  (`_next_utc_midnight_epoch` → `_OPENSKY_DISABLED_UNTIL`) instead of retrying.
  The daily credit pool cannot recover before midnight UTC, so the old
  exponential backoff just burned connect timeouts and leaked authed credits on
  every rejected call. The breaker is in-memory, so a **process restart also
  clears it** → "test once per start, and again each 0000 UTC". The cached FC
  keeps serving the whole time the breaker is open.

### Grid tier (`_grid_fanout` / `_fetch_cell`)

- `_GLOBAL_GRID`: 130+ hand-picked land/corridor cells, each queried at
  `/v2/point/{lat}/{lon}/250`. **Densify only — never thin out.**
- Per cell: deterministic primary host (`md5(lat,lon) % hosts`), walk the host
  list on failure. Per-cell cache: **30 s** full / **5 s** empty.
- **Rate-limit detection (`_parse_ac`).** airplanes.live's limiter answers with
  EITHER `429` OR — the trap — **HTTP 200 + a `text/plain` body**
  (`"You have been rate limited"`). `_parse_ac` returns `None` for any non-JSON
  body (→ walk to next host / don't cache), kept distinct from a valid JSON body
  with an empty `ac` list (→ `[]`, genuine empty, safe to cache).
- **Never cache a failure as empty.** When every host fails/rate-limits,
  `load_cell` **raises** `_UpstreamUnavailable` so `get_or_fetch` does not
  persist `[]` — the cell retries next fan-out instead of being pinned blank.

---

## Tuning knobs (`apps/api/app/routes/adsb.py`)

| Constant | Value | Meaning |
|---|---|---|
| `_UPSTREAM_SEMAPHORE` | `8` | Max concurrent upstream fetches. **Keep ≤8** — airplanes.live trips ~>8 concurrent. |
| `_CELL_TTL_FULL` / `_EMPTY` | `30` / `5` s | Per-cell cache. 30 s keeps steady-state load ~4-5 cells/s. |
| `_OPENSKY_INTERVAL_S` | `15` s | Min seconds between OpenSky pulls (budget pacing). |
| `_OPENSKY_DISABLED_UNTIL` | dynamic | Breaker gate: a failed pull sets it to the next 0000 UTC; OpenSky is skipped until then (or process restart). |
| `_GRID_BUDGET_S` | `8` s | Wall-clock cap on the grid overlay per tick. |
| `_FIREHOSE_DEAD_SKIP_S` | `30` s | Skip a dead firehose for this long. |
| `_merge_with_previous(max_age_s)` | `180` s | Carry-forward window for contacts missing from a tick. |
| `_SNAPSHOT_MIN_RETAIN_FRACTION` | `0.5` | Reject a new snapshot below 50 % of the previous count… |
| `_SNAPSHOT_STALE_S` | `30` s | …unless the snapshot is already this stale (anti-lockout). |

---

## Operating envelope

- **Steady state:** ~13 k aircraft, snapshot age ~1–2 s after grid-cell cache
  warmup. Guardrail (CLAUDE.md): **≥8 000 aircraft**.
- **Without OpenSky creds:** anonymous budget (~400 credits/day ≈ 100 global
  pulls) carries a session; once drained, the cached FC holds the count while
  the grid keeps dense regions fresh. Add `opensky_client_id`/`secret` to env
  for the larger authed budget.
- **Boot:** `correlate/runner.py:_global_loop` warms up 2 s before its first
  `adsb_global()` ingest so the app doesn't stampede upstreams at startup.

## Failure modes → symptom

| Symptom | Cause | Where |
|---|---|---|
| Count drops to a few hundred | rate-limit text cached as empty | `_parse_ac` / `load_cell` raise |
| Count drops to ~1.6 k | OpenSky tier not contributing (breaker open: 429 on both budgets → disabled till 0000 UTC) | `_opensky_refresh_once` breaker, `_OPENSKY_DISABLED_UNTIL` |
| Snapshot age climbs to 30–60 s | grid not time-boxed, blocks the tick | `_GRID_BUDGET_S` |
| Icons blink off/on | snapshot rejected/replaced wholesale | retain-fraction + carry-forward |

## Verify

```bash
# count + age
curl -s localhost:8000/api/adsb/snapshot_age   # {age_s, features, ...}
curl -s localhost:8000/api/adsb/global | python3 -c \
  'import sys,json;print(len(json.load(sys.stdin)["features"]),"aircraft")'
```

In the app: drag to Europe → hundreds of yellow airliners / orange military /
SVG icons (never dots); count badge ≥8 k; icons update in place, never blink.
