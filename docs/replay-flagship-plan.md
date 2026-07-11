# W1 — "The world, recorded": unlimited replay as the flagship (2026-07-11)

Requirements contract: `docs/roadmap-users-2026-07.md` §3 W1. Guarded
invariants: `CLAUDE.md` (motion, refresh, render-mode). Storage-bounding
philosophy: memory `storage-bounding-and-ondemand-imagery.md` and the
`_clamped_retention_hours` / `enforce_size_cap` docstrings in `history.py`
itself. Every file:line below was read this session.

The substrate is real and mostly wired: `apps/api/app/history.py` already
buffers + flushes + prunes + byte-caps aircraft AND vessel fixes; the
frontend already has a replay bar with play/pause, speed, rolling-window
presets, and a day picker (`apps/web/src/timeline/Timeline.tsx`). W1 is not
"build replay" — it is (a) an operator profile that turns the bounded
internal buffer into an intentionally-sized archive, (b) making that archive
*visible* (coverage stats, heat-strip, an ownership chip), and (c) a motion
question the substrate read surfaced that the roadmap did not anticipate —
resolved in §5 as "no change needed," not as a fix.

## 0. Substrate corrections (read before designing against the roadmap prose)

The roadmap's W1 paragraph is directionally right but three specifics need
correcting from what the code actually does:

1. **Vessels already flow into history — no gap.** `ais_firehose.py:165` and
   `:303` both call `history.ingest_vessels(...)` on every AIS fixture
   received; `routes/adsb.py:1403` calls `history.ingest_aircraft(...)`. Both
   kinds are already in the `positions` table and `query_tracks` already
   returns both (`history.py:281-329`, no kind filter unless the caller asks
   for one). **Multi-domain scrub is a data-layer non-issue** — the actual
   gap is visibility (§3), not ingestion; §5 covers a motion question the
   substrate read raised and closes it with no code change.
2. **The replay bar is not "an empty strip."** `Timeline.tsx` already ships a
   day picker bounded to retention (`min={minDay}`, lines 402-411), five
   rolling-window presets (`REPLAY_WINDOWS`, lines 15-21), a speed control
   (`SPEEDS`, line 14, rows 347-369), and a retained-buffer label
   (`retentionDays(retentionHours)`, lines 442-447). What is missing is
   specifically: a coverage/density heat-strip fed by the *history* store
   (the existing density strip at lines 508-579 is fed by
   `/api/timeline/density`, which is **detection/alert density, not fix
   density** — a different signal), and the "recording since / N GB / M
   fixes" ownership chip (today there is only the rolling `~7d buffer` text).
3. **Incident overlay cannot reach archive scale — the roadmap's "incidents
   overlaid from the incident store" only holds for ≤6h.**
   `app/intel/incident_store.py:22` caps history at `_MAX_SNAPSHOTS = 360`
   per scope, explicitly commented `# ~6h at a 60s cadence`. The existing
   `/api/timeline/events` route (`routes/timeline.py:64`) *accepts*
   `window_sec` up to `72 * 3600` (72h) and calls
   `incident_store.history(scope, window_sec)` (`routes/timeline.py:78`), but
   the store structurally cannot hold more than ~6h of snapshots — a 72h
   request against a fresh-boot store silently returns a thin, non-representative
   tail. This is a **pre-existing inconsistency, not something W1 introduces**;
   it is out of scope to fix the route's ceiling in this workstream (noted in
   §7 Out of scope), but it means **incidents must NOT be wired into the
   archive-scale (day/week) replay window** — the data behind them doesn't
   exist that far back. §4.D below designs around this rather than papering
   over it.

## 1. A. Disk-first archive profile

### 1.1 New settings (`apps/api/app/config.py`, appended near the existing
`history_max_bytes` block at line 408)

```python
# Archive profile — turns the bounded live buffer into an intentional
# multi-day/week archive. OFF by default (current bounded-buffer behavior
# is unchanged unless the operator opts in).
archive_mode: bool = False  # ARCHIVE_MODE
# Disk budget used ONLY when archive_mode is True (GB). 0 = fall back to
# history_max_bytes (documented, logged once at boot — never a silent no-op).
history_disk_budget_gb: float = 0.0  # HISTORY_DISK_BUDGET_GB
```

Archive mode still deletes-to-cap on the normal hourly cadence (unchanged —
queries must stay consistent with the configured budget at all times); the
full-file VACUUM that cadence used to trigger is skipped entirely in archive
mode — see §1.4. No third setting: the gate is a one-line `archive_mode`
check, not a tunable cadence.

Naming follows the existing convention confirmed in `config.py:16-26`
(`pydantic_settings.BaseSettings`, `case_sensitive=False` → env var is the
field name uppercased, e.g. `history_retention_hours` ↔
`HISTORY_RETENTION_HOURS`, verified against `tests/test_history.py:27-28`
which sets `HISTORY_RETENTION_HOURS`/`HISTORY_RETENTION_MAX_HOURS` directly).

### 1.2 Lift the time clamp — reuse the existing ceiling-0 branch

`history.py:68-90`, `_clamped_retention_hours()`, already has the exact
mechanism the archive profile needs: `if ceiling > 0 and hours > ceiling:
hours = ceiling` (line 88). A ceiling of 0 disables the upper bound
(`history_retention_max_hours=0`). Rather than a second code path, `archive_mode`
overrides only how `ceiling` is computed, one line:

```python
ceiling = 0 if settings.archive_mode else int(settings.history_retention_max_hours)
```

placed where `ceiling = int(settings.history_retention_max_hours)` sits today
(`history.py:85`). Operators who don't want `ARCHIVE_MODE` to also uncap
retention can still set `HISTORY_RETENTION_MAX_HOURS=0` directly — unchanged.
The floor of 1 (line 86-87) is untouched, so the prune cutoff is never in the
future regardless of profile. **Zero new branches inside `prune()` itself.**

### 1.3 Byte cap: switch the budget source, keep `enforce_size_cap` as-is

Today, `_flush_loop` (`history.py:255-276`) sizes the cap from RAM:

```python
size_cap = memtier.cache_budget_bytes(
    "history", floor=64 * 1024**2, ceil=int(settings.history_max_bytes)
)
```

`memtier.cache_budget_bytes` (`apps/api/app/memtier.py:73-84`) scales to
**5% of currently-available RAM** (`_CACHE_FRACTION["history"] = 0.05`,
`memtier.py:33`), clamped to `[64 MiB, history_max_bytes]` — so on a 32 GB
box with ~16 GB available, the *actual* runtime cap is ~800 MB, not the 2 GB
`history_max_bytes` default suggests. That's correct behavior for the
default bounded-buffer profile (don't let history crowd out RAM on a small
box) but wrong for an archive, where the operator has deliberately allocated
disk and wants that honored regardless of free RAM. New logic in
`_flush_loop`, replacing only the `size_cap = ...` line:

```python
if settings.archive_mode:
    if settings.history_disk_budget_gb > 0:
        size_cap = int(settings.history_disk_budget_gb * 1024 ** 3)
    else:
        log.warning("history: archive_mode=1 but history_disk_budget_gb=0 — "
                     "falling back to history_max_bytes (%d)", settings.history_max_bytes)
        size_cap = int(settings.history_max_bytes)
else:
    size_cap = memtier.cache_budget_bytes(
        "history", floor=64 * 1024**2, ceil=int(settings.history_max_bytes)
    )
```

`enforce_size_cap(size_cap)` (`history.py:402-444`) is called exactly as
before — the drop-oldest-slice-then-VACUUM machinery is unmodified; only
where `size_cap` comes from changes. This is the literal ask: "the cap
machinery stays, only its budget source changes."

### 1.4 Skip the full VACUUM in archive mode — one-line gate, not a cadence

`enforce_size_cap` estimates an overage fraction and deletes that slice in
one DELETE (`history.py:426-436`), then the caller VACUUMs
(`history.py:269-270`, `if deleted: ... _vacuum()`). `_vacuum()` runs a bare
`VACUUM` (`history.py:447-454`) — a **full rewrite of the whole DB file**,
costing roughly `O(total file size)`, not `O(rows deleted)`, and needing
~2× the file size in transient free disk space. At the default 2 GB cap this
is cheap and already proven safe (memory: "48h of global ADS-B+AIS ≈ 8 GB,
byte cap binds" — i.e. this exact VACUUM-every-hour-once-full pattern is
already how the system runs today, just at a 2 GB/8 GB scale). At an
intentional archive budget of tens-to-hundreds of GB, an hourly full VACUUM
of that whole file would mean sustained multi-GB rewrites every hour once
the archive is full (which, by design, it will be almost continuously) — a
cost the current code has never been exercised against.

Minimum viable fix: skip `_vacuum()` outright when `archive_mode` is on.
Deletes still happen every `_PRUNE_INTERVAL_S` (hourly, unchanged — the
byte cap must stay enforced promptly so queries never see an over-budget
file), but the VACUUM itself does not run at archive scale at all:

```python
# inside _flush_loop, replacing the unconditional "if deleted: ... _vacuum()":
if deleted and not settings.archive_mode:
    await loop.run_in_executor(None, _vacuum)
# Archive mode skips the full-file VACUUM here on purpose: at archive scale
# (tens-to-hundreds of GB) a full VACUUM can stall the writer for minutes,
# and the archive is byte-budget-capped anyway (enforce_size_cap already ran
# above), so reclaiming disk space isn't needed until the configured budget
# is hit. Revisit only if §1.5's measurement shows sustained deletes in
# archive mode (i.e. the archive is repeatedly hitting its cap and churning),
# at which point a longer-interval VACUUM or `auto_vacuum=INCREMENTAL` (see
# below) is the fix — not before, and not guessed at now.
```

No new setting, no new module-level state (`_last_vacuum_at` or similar),
and no cadence to tune — non-archive-mode behavior is byte-for-byte
unchanged (the `and not settings.archive_mode` guard is the entire diff).
**Full `auto_vacuum=INCREMENTAL` conversion** (cheaper than periodic full
VACUUM, and the eventual real fix if archive mode turns out to need disk
reclaimed sooner) is a real future optimization but needs a one-time
migration for existing DB files and is explicitly deferred (§7).

### 1.5 Measured-not-guessed: the disk-math task

Do not invent a GB/day number. Task, to run before README/this doc get a
number written into them:

1. Boot the backend in archive mode (`ARCHIVE_MODE=1 HISTORY_DISK_BUDGET_GB=<large>`,
   `bash scripts/run-api.sh`, per the "restart once, don't hammer egress"
   rule in `CLAUDE.md`).
2. Let it run **N hours** (N ≥ 6, ideally 24) at normal keyless feed volume
   (~13k aircraft per the global-snapshot floor guard, plus whatever AIS
   union the box currently gets — README already states "~33k vessels,
   MMSI-deduped").
3. Measure `os.path.getsize(history_db_path)` at the start and end (or read
   `total_bytes` off the new `/api/history/coverage` endpoint, §2, once it
   exists), compute `Δbytes / (N/24)` → GB/day.
4. Write the **actual measured number** into `README.md` near the existing
   "7-day SQLite store" line (`README.md:121`) and into this doc's §1.5 —
   replacing this paragraph, not appending a guess next to it. Prior art:
   memory `storage-bounding-and-ondemand-imagery.md` records "48h of global
   ADS-B+AIS ≈ 8 GB" as a previously measured figure (≈4 GB/day) — treat that
   as a directional prior to sanity-check against, not as the number to ship;
   re-measure live, because feed volume (union size, AIS source mix) has
   changed since that note was written and the rate-limit/dedup logic in
   `_buffer_point` (`history.py:117-144`) also directly determines the
   fixes/hour actually written.

## 2. B. Coverage/stats endpoint

New `GET /api/history/coverage` in `apps/api/app/routes/history.py`,
alongside the existing `get_tracks` / `get_timeseries` / `get_stats`
(lines 20-66 today):

```python
@router.get("/api/history/coverage")
async def get_coverage(
    window_hours: int = Query(720, ge=1, le=8760, description="Heat-strip look-back, hours"),
    bucket_hours: int = Query(1, ge=1, le=24, description="Bucket width, hours"),
) -> dict:
    return await history.coverage(window_hours, bucket_hours)
```

`history.py` gets one new async function (mirroring `count_timeseries`,
`history.py:380-382`, which already does the same "run the sync query in an
executor" pattern) plus its `_sync` helper (mirroring `_timeseries_sync`,
`history.py:354-377`):

```python
def _coverage_sync(window_hours: int, bucket_hours: int) -> dict[str, Any]:
    path = _resolved_db_path()
    try:
        total_bytes = os.path.getsize(path)
    except OSError:
        total_bytes = 0
    try:
        con = _connect()
        recording_since = con.execute("SELECT MIN(t) FROM positions").fetchone()[0]
        row_count = con.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
        bucket_sec = bucket_hours * 3600
        now = time.time()
        t_from = now - window_hours * 3600
        rows = con.execute(
            "SELECT CAST(t / ? AS INTEGER) * ? AS bkt, COUNT(*) AS n "
            "FROM positions WHERE t >= ? GROUP BY bkt ORDER BY bkt",
            [bucket_sec, bucket_sec, t_from],
        ).fetchall()
        con.close()
    except Exception as exc:  # noqa: BLE001
        log.exception("history: coverage error")
        return {"recording_since": None, "total_bytes": total_bytes, "row_count": 0,
                "buckets": [], "degraded": True, "error": f"{type(exc).__name__}"}
    return {
        "recording_since": recording_since,
        "total_bytes": total_bytes,
        "row_count": int(row_count),
        "buckets": [{"t": int(bkt), "count": int(n)} for bkt, n in rows],
    }
```

**Index check — no new index needed.** The schema (`history.py:100-112`)
already has `idx_id_t ON positions (id, t)` and `idx_t ON positions (t)`.
`idx_t` alone covers everything `coverage()` needs: `MIN(t)` is a
leftmost-index-order scan (reads one row), the `WHERE t >= ?` + `GROUP BY
bkt` bucket query is the identical access pattern `_timeseries_sync`
(`history.py:354-377`) already runs in production today over `idx_t`, and
`COUNT(*)` with no predicate is an index-only full scan of `idx_t` (the
smallest index on the table) — cheap even at tens of millions of rows,
typically sub-second, because SQLite doesn't need to touch the row payload
for a bare count. If row counts grow large enough that this becomes
measurable overhead (only discoverable by measuring, not guessed), the fix
is a short in-process cache (same pattern the sticky ADS-B snapshot already
uses elsewhere in the repo), refreshed once per prune cycle — not a new
index. This is a documented fallback, not part of this slice.

`stats()` (`history.py:495-512`) is untouched; `coverage()` is additive and
serves a different consumer (the heat-strip + chip, §3), not the existing
day-picker bound (which still reads `stats().retention_hours`).

## 3. C. Scrubber sold, not plumbed

All anchors are in `apps/web/src/timeline/Timeline.tsx` unless noted; all
styling reuses existing Tailwind utility classes already bound to
`apps/web/src/theme/tokens.css` variables (`--txt-*`, `--bg-*`, `--line`,
`--accent*`) — the same `mono text-[10px] uppercase tracking-[0.5px]
text-txt-4` family already used for the buffer label (line 443-447). No new
tokens are added.

- **Date picker** — already exists (`<input type="date">`, lines 402-411,
  bounded by `minDay`/`maxDay` derived from `retentionHours`, lines 118-121)
  and satisfies the W1 contract as written (`docs/roadmap-users-2026-07.md`
  §3 asks for a "date picker," not hour granularity). No change in this
  slice. **Stretch, not in slice scope**: an hour-granularity `<input
  type="time">` next to it (defaulting to `00:00`) so `replayDay` scrub could
  start mid-day instead of only at UTC midnight — `dayStartSec` (lines 34-36)
  would get the time-of-day added to its offset. Small diff to an existing
  control if picked up later; not in Slice 2's file list (§8) and not
  required to ship W1.
- **Coverage heat-strip** — genuinely new. The existing Row 3 density strip
  (lines 508-579) is fed by `/api/timeline/density` (detections/alerts, a
  different signal per §0.2) and must not be repurposed (out of scope, §7).
  New component `apps/web/src/timeline/CoverageStrip.tsx`: polls
  `/api/history/coverage?window_hours=<retentionHours>&bucket_hours=<auto>`
  on the same `POLL_MS`-scale cadence already used for density
  (`Timeline.tsx:200-221` is the pattern to copy), renders one thin SVG bar
  row directly under the day/time picker (inserted into the "Historical
  replay" block, `Timeline.tsx:373-448`) so the operator can SEE which
  hours/days have data before picking one. One `import` + one render call
  into `Timeline.tsx`; all bucket-fetch/render logic lives in the new file —
  keeps `Timeline.tsx`'s diff small and gives slice ownership (§6) a clean
  boundary.
- **Playback speed control** — already ships (`SPEEDS`, line 14, buttons at
  lines 347-369). No change; reused as-is.
- **Ownership chip** — replace the current bare `retentionDays(retentionHours)`
  span (lines 442-447, "~7d buffer") with a chip reading
  `recording since <date> · <N> GB · <M> fixes`, sourced from the same
  `/api/history/coverage` response `CoverageStrip` already fetches (lift the
  three scalar fields — `recording_since`, `total_bytes`, `row_count` — up
  to `Timeline.tsx` via a small callback/lifted-state prop, or have
  `CoverageStrip` render the chip itself since it already owns the fetch;
  either is fine, kept as an implementation-time call, not a file-ownership
  question since it's still inside `CoverageStrip.tsx`). Formatting: `date`
  from `recording_since` (epoch seconds) via the same `isoStamp`/`isoDay`
  helpers already in `Timeline.tsx` (lines 30-33, 597-599); `N GB` = 
  `total_bytes / 1024**3` to 1 decimal; `M fixes` = `row_count.toLocaleString()`
  (matching the existing `totalDet.toLocaleString()` pattern, line 566).

## 4. D. Multi-domain scrub

**Aircraft + vessels: already wired, nothing to add at the data layer** (§0.1).
`HistoryPlayback.ts`'s `load()` (lines 176-226) queries `/api/history/tracks`
with no `kind` filter and renders whatever comes back through
`buildTrackEntity` (lines 77-123), which already dispatches on `tr.kind` to
pick `aircraftStyle` vs `vesselStyle` (lines 95-98) — both categories replay
together today. The W1 work here is entirely §3 (making it visible); §5
covers the motion question this workstream raised and closes it with no
`HistoryPlayback.ts` change.

**Incidents: defer for archive-scale, do not wire into day/week replay.**
Per §0.3, `incident_store` structurally holds ~6h of snapshots
(`_MAX_SNAPSHOTS = 360` @ 60s cadence, `incident_store.py:22`). The existing
`/api/timeline/events` lanes (`Timeline.tsx:49-62`, `225-243`) already poll a
fixed ~20h window independent of whatever replay window is selected — that
is pre-existing behavior, not part of this design, and is **not** extended to
follow the replay playhead in W1. Overlaying incidents onto a multi-day
archive replay would either show nothing (correctly) or silently show only
the trailing ~6h relabeled as if it covered the full window (misleading) —
neither is worth building now. **Kill/defer criterion met explicitly**: this
spec defers incident overlay for the archive replay case entirely; a future
workstream that wants it needs `incident_store` to gain a durable,
time-indexed backing (its own SQLite table, same shape as `history.py`) —
that is new scope, not a W1 wiring task.

## 5. E. Motion invariant handling — CUT: replay interpolation is kept as-is

**Substrate read, `HistoryPlayback.ts:77-92`:** `buildTrackEntity` builds a
`Cesium.SampledPositionProperty` with `LinearApproximation` for **every**
track regardless of `tr.kind` — the `isAir` branch (line 95) only picks the
billboard style, not the position property. Both aircraft and vessel replay
tracks glide smoothly between recorded fixes today. An earlier draft of this
spec read that as a gap to close (matching the live path's aircraft
teleport). It is not, and this workstream makes **no change here** — three
independent reasons converged on the same answer:

1. **The no-synthesis rule is scoped to the default LIVE path, not replay.**
   `docs/decisions.md`'s motion entries say so twice, explicitly: "NEVER
   synthesize/predict aircraft motion BY DEFAULT" is qualified as "ON THE
   DEFAULT PATH." Replay is not that path — it draws only RECORDED REAL
   fixes and interpolates *between* them for smoothness, which is a
   different thing from inventing a fix that was never observed.
2. **This exact behavior was already stress-tested and praised, not flagged.**
   `docs/velocity-stress-test-warsim-2026-06-20.md:248` records a 24h replay
   PASS that explicitly cites "real `SampledPositionProperty` interpolation"
   as correct behavior (sampled tracks traveling 78-337 km). Nothing in that
   pass, or since, called this a defect.
3. **A literal zero-order-hold swap breaks the trail.** An aircraft-only
   `Cesium.CallbackProperty` (binary-search to the last fix at-or-before the
   queried time, no interpolation) would step the billboard between fixes —
   but `path` (lines 114-120, `PathGraphics`) samples that same position
   property to draw the trail, and needs sample-time availability across the
   window to render a continuous line; a `CallbackProperty` returning
   discrete held values produces missing or degenerate trail segments
   between fixes. The swap is not a drop-in for the position property
   alone — it would also need `path` reworked, which the W1 contract
   (`docs/roadmap-users-2026-07.md` §3, "date picker" / visibility / a
   working scrubber) never asked for.

Given (1) the invariant doesn't apply here, (2) the interpolated behavior is
already validated as correct, and (3) the swap is technically risky for no
requested benefit, the minimum-change rule wins: **replay keeps
`SampledPositionProperty` + `LinearApproximation` for both aircraft and
vessels, unchanged** (`HistoryPlayback.ts:77-92`, no diff). This is now
recorded as a deliberate, replay-scoped sanction in `docs/decisions.md`
(new 2026-07-11 entry) specifically so a future editor neither "fixes"
replay to teleport nor cites replay's interpolation as precedent to add
glide back to the live default path.

The file's header comment (line 20: "Interpolation uses LinearApproximation,
matching the live adapter") is imprecise about the live path's current
behavior (the live adapter teleports aircraft and only glides vessels, per
`docs/decisions.md:57-67`) — flagged here, not fixed: `HistoryPlayback.ts` is
out of scope for any edit in this workstream (§8 Slice 3), so a one-line
comment correction is left for whoever next has a reason to touch the file.

**Slice 3 shrinks accordingly** (§8): multi-domain replay verification, a new
guard test asserting a replayed window renders ≥2-point tracks for entities
with in-window fixes, and the perf kill-criterion check — no
`HistoryPlayback.ts` motion changes.

**Render-driving without violating `requestRenderMode:true` /
`maximumRenderTimeChange:0`** (guarded, `docs/decisions.md:89-96`,
`globe/invariants.test.ts` regex-checks `GlobeCanvas.tsx`): `HistoryPlayback.ts`
already handles this correctly and the mechanism is real, not
to-be-invented — verified at `HistoryPlayback.ts:213-224`:
`viewer.clock.shouldAnimate = true` starts the clock; **while replay is
active** `viewer.scene.maximumRenderTimeChange = 0.2` (line 220, not the
live-path's `0` — deliberately looser because replay can run up to the
`3600×` speed multiplier, `Timeline.tsx:14`, where simulation-seconds elapse
far faster than wall-clock, and forcing a render every single 0-sim-second
delta at 3600× would be wasteful; 0.2 sim-seconds is still smooth at any of
the five speed presets) so Cesium's own clock-tick render gate — the same
one `docs/decisions.md:89-96` documents for the live path — fires
automatically as the simulation clock advances, with **no per-tick
`requestRender()` call needed in application code**. One explicit
`viewer.scene.requestRender()` is still called immediately after `load()`
populates entities (line 224) to paint the first frame before the clock has
ticked at all, and again in `clear()` (line 237) and `jumpClockTo`
(`Timeline.tsx:612-615`) for the same reason — every state change that isn't
itself a clock tick gets one explicit `requestRender()`, exactly mirroring
how the live path handles camera moves. `requestRenderMode: true` is never
flipped off during replay (only `maximumRenderTimeChange` moves, and `clear()`
restores it to `Infinity`, line 235) — this is the existing, already-correct
pattern, and nothing in this workstream touches it.

## 6. F. Guards/tests

**New backend tests** (`apps/api/tests/test_history.py`, following the
existing `_retention_env` context-manager pattern at lines 16-35 and the
`_reset_module`/tmp-db pattern at lines 76-82):

- `test_archive_mode_lifts_time_ceiling` — with `ARCHIVE_MODE=1` and a large
  `HISTORY_RETENTION_HOURS`, assert `_clamped_retention_hours()` returns the
  raw value uncapped even though `HISTORY_RETENTION_MAX_HOURS` is left at its
  normal (non-zero) default — proving the override, not just the existing
  ceiling=0 path (`test_retention_ceiling_zero_disables_upper_bound` already
  covers that path and must stay green, untouched).
- `test_archive_mode_uses_disk_budget_not_ram_scaled` — with `ARCHIVE_MODE=1`
  and `HISTORY_DISK_BUDGET_GB` set, monkeypatch `memtier.available_bytes` to
  a tiny value and assert the size cap used by the flush loop's cap
  computation equals `disk_budget_gb * 1024**3`, NOT a RAM-scaled fraction —
  and a companion assertion that with `archive_mode=False` the same tiny
  `available_bytes` DOES shrink the cap (proves the branch, not just one arm
  of it).
- `test_archive_mode_falls_back_to_history_max_bytes_when_budget_unset` —
  `ARCHIVE_MODE=1`, `HISTORY_DISK_BUDGET_GB=0` → cap falls back to
  `history_max_bytes`, with a logged warning (asserted via `caplog`).
- `test_archive_mode_skips_vacuum` — seed rows past the cap with
  `ARCHIVE_MODE=1`, run a prune pass, assert deletions happened (cap still
  enforced promptly) but `_vacuum()` (patch/spy it) was NOT invoked; a
  companion assertion that with `archive_mode=False` the same seeded-past-cap
  scenario DOES call `_vacuum()` (proves the branch, not just one arm) — the
  regression guard for §1.4's "don't full-VACUUM a multi-GB archive."
- `test_coverage_shape_and_totals` — seed rows across several hours across
  both kinds, call the new `history.coverage(...)`, assert
  `recording_since`/`total_bytes`/`row_count`/`buckets` are all present, and
  `sum(b["count"] for b in buckets) == row_count` for a window covering all
  seeded rows.
- Route-level smoke (alongside existing route tests): `TestClient` GET
  `/api/history/coverage` → 200 + the four expected keys.

**New frontend tests:**

- `apps/web/src/globe/HistoryPlayback.test.ts` (does not exist today,
  confirmed by search) — behavioral, the W1 replay guard referenced in §5:
  build a synthetic multi-domain window (an aircraft track and a vessel
  track, each with ≥2 in-window fixes at different lon/lat) and assert the
  resulting entities each render a ≥2-point track — i.e. `buildTrackEntity`
  reports `added >= 2` for both, and `path.trailTime` equals the window
  passed in. A second case samples `Entity.position` at the midpoint between
  two fixes for both an aircraft and a vessel track and asserts BOTH are an
  interpolated midpoint (not equal to either endpoint) — proving today's
  glide-for-both behavior stays intact, not a source-scan proxy for it.
  Exercised through `installHistoryPlayback(viewer).load(...)` against a
  mocked `/api/history/tracks` response (the existing public surface); no
  new export from `HistoryPlayback.ts` is needed for this. If in
  implementation that surface proves impractical to drive directly, the only
  allowed additive change is a minimal export of `buildTrackEntity` itself —
  still not a behavior change, and still inside Slice 3's file list (§8).
- `apps/web/src/globe/invariants.test.ts` — one new source-scan guard
  alongside the existing ones (pattern at lines 21-34): assert
  `HistoryPlayback.ts` constructs a `Cesium.SampledPositionProperty` (not a
  `CallbackProperty`/`ConstantPositionProperty`) for the position of BOTH
  track kinds, so a future edit that "fixes" replay to teleport aircraft —
  forbidden by the new `docs/decisions.md` entry — fails loud even before
  the behavioral test above is run.

**Existing tests that must stay green, unmodified by this workstream:**
`apps/api/tests/test_history.py`'s full existing suite (retention clamp/floor,
rate-limit, prune, size-cap, timeseries, vessel-ingest — lines 88-381, all
read this session), `apps/api/tests/test_invariants.py` (upstream semaphore,
`global_snapshot` usage, CelesTrak TLE format, jemalloc scrub, snapshot
floor), and `apps/web/src/globe/invariants.test.ts`'s existing four checks
(`requestRenderMode`/`maximumRenderTimeChange` on `GlobeCanvas.tsx`, no
`removeAll()` in `PollGeoJsonAdapter`, SVG palette). The 939-test backend
baseline (`CLAUDE.md`) must grow by the count of new tests above, never
shrink; `pnpm -r typecheck` and `bash scripts/verify.sh` stay green at every
slice boundary.

## 7. G. Out of scope (explicitly not touched)

- **Satellites.** Client-side SGP4 (`SampledPositionProperty`-driven, per
  `docs/decisions.md:201`) already recomputes real physics on demand and is
  the CLAUDE.md-documented exemption from the no-synthesis rule; it has no
  relationship to `history.py` and nothing here touches it.
- **Incidents beyond the existing ~6h/20h lanes** — deferred per §4; no
  changes to `incident_store.py` or `routes/timeline.py`'s `get_events`.
  The pre-existing 72h-request-vs-6h-actual-retention mismatch noted in §0.3
  is flagged, not fixed, here.
- **Any live-path cadence, polling, or motion code**: `PollGeoJsonAdapter.ts`,
  `GlobeCanvas.tsx`'s viewer construction, `styles.ts`, `labelStyle.ts`,
  world-view decimation in `routes/adsb.py` — all guarded, all untouched.
  `HistoryPlayback.ts` only *imports* `aircraftStyle`/`vesselStyle`/`labelFor`
  as pure functions; it does not modify those files.
- **Replay motion code.** `HistoryPlayback.ts`'s `SampledPositionProperty` +
  `LinearApproximation` interpolation for both aircraft and vessels is
  correct as-is and gets no diff in this workstream — see §5. Do not read
  Slice 3's file list as license to touch it beyond the minimal additive
  export §8 allows if a testing seam is needed.
- **`auto_vacuum=INCREMENTAL` conversion** for `history.db` — a real future
  optimization that would let archive mode reclaim disk without a full-file
  rewrite, instead of skipping VACUUM outright as §1.4 does; needs a
  one-time migration for already-provisioned archive DBs, deferred.
- **Docker Compose / README launch packaging (W2)** and **keyless alert push
  (W3)** — separate workstreams; the measured GB/day number (§1.5) feeds
  W2's README rebuild but the packaging work itself is not this doc.
- **No new visual language** — `tokens.css` gets zero new variables; the chip
  and heat-strip reuse the `--txt-*`/`--bg-*`/`--line`/`--accent*` families
  and `mono`/`tabular-nums`/`uppercase tracking-[0.5px]` utility conventions
  already in `Timeline.tsx`.
- **Ontology, Foundry, watch-officer, MCP** — unrelated surfaces, not touched.

## 8. H. Vertical slices

Ordered so each is independently verifiable and mergeable; file lists are
disjoint per slice so two implementers never touch the same file at once
(the one-file-one-owner rule in `CLAUDE.md` §Subagents).

### Slice 1 — Backend disk-first archive profile (~3-4 days)
**Owner: backend.** Files: `apps/api/app/config.py` (new settings, §1.1),
`apps/api/app/history.py` (ceiling override §1.2, cap-source switch §1.3,
archive-mode vacuum-skip gate §1.4, new `coverage()`/`_coverage_sync()` §2),
`apps/api/app/routes/history.py` (new `/api/history/coverage` route, §2),
`apps/api/tests/test_history.py` (new tests, §6).
Verify independently: `OSINT_DISABLE_BACKGROUND=1
apps/api/.venv/bin/pytest apps/api/tests/test_history.py -q` green; boot with
`ARCHIVE_MODE=1` and curl `/api/history/coverage`, confirm shape.
**Carries the measurement task (§1.5)** — its result (GB/day) is a
prerequisite fact for Slice 2's chip wording and for W2's README rebuild, but
the chip itself needs no hardcoded number since it reads the live endpoint.

### Slice 2 — Frontend scrubber dressing (~3 days)
**Owner: frontend A.** Files: `apps/web/src/timeline/Timeline.tsx` (chip
wiring only, §3 — small diff, most logic lives in the new file below), new
`apps/web/src/timeline/CoverageStrip.tsx` (heat-strip + fetch, §3). The
hour-granularity time-input (§3) is stretch-only and not in this slice's
scope.
Depends on Slice 1's `/api/history/coverage` existing (mockable during
parallel development against the documented shape in §2).
Verify independently: `pnpm -r typecheck` green; boot app, open the replay
bar, confirm the heat-strip renders real per-hour bars and the chip shows a
real `recording since / GB / fixes` line (screenshot).

### Slice 3 — Multi-domain replay verification + perf gate (~1-2 days)
**Owner: frontend B** (different file from Slice 2 — no conflict). §5 cut
the motion change this slice was originally built around; `HistoryPlayback.ts`
is now READ-only for verification in this slice, not edited — its existing
`SampledPositionProperty` interpolation for both kinds is correct and stays.
Files: new `apps/web/src/globe/HistoryPlayback.test.ts` (the ≥2-point/glide
guard, §6), `apps/web/src/globe/invariants.test.ts` (one new guard appended,
§6). If the new test needs a seam `HistoryPlayback.ts` doesn't currently
expose, the only allowed change to that file is a minimal additive export
(e.g. of `buildTrackEntity`) — no behavior change, still reviewed as part of
this slice.
Verify independently: new unit tests green; boot app, replay a 24h window
over a mixed region, confirm aircraft AND vessel icons glide smoothly between
recorded fixes (unchanged from today); confirm frame time stays acceptable
with combined aircraft+vessel entity counts across a multi-day window.
**Kill criterion lives here** (roadmap's own words): if a full multi-day,
both-kinds replay can't hold acceptable perf, the fallback is tightening
`limit_ids` (already a query param on `GET /api/history/tracks`,
`routes/history.py`, and already wired from the frontend at
`HistoryPlayback.ts:194`) for the combined query, or defaulting archive-scale
replay to aircraft-only with vessels as an explicit opt-in toggle — without
touching the kind-dispatch semantics elsewhere. `max_points_per_id` is NOT
the lever: it is a `history.query_tracks` parameter with no query-string
exposure in `routes/history.py`'s `get_tracks` (unreachable from the
frontend), and adding that exposure would cross into Slice 1's files. Ship
aircraft-only and still lead with it, per the roadmap's own kill clause,
rather than block the whole workstream on vessel-scale perf.

### Slice 4 (optional/stretch, only if 1-3 land clean) — nothing to build
Per §4/§7, incident overlay is deferred outright for archive-scale replay —
there is no small, honest version of it worth shipping in W1 given the ~6h
structural ceiling in `incident_store.py`. If time remains after Slices 1-3,
the highest-value use of it is re-measuring §1.5's GB/day number against a
longer (24-48h) soak to firm up the README/docs figure before W2 packaging
starts, rather than building new surface area.

## Success check (mirrors roadmap §6)

Archive-mode instance holds a multi-day/week window within its configured
disk budget (not RAM-scaled); `/api/history/coverage` reflects real
`recording_since`/bytes/rows; the replay bar shows the ownership chip and
heat-strip fed by that endpoint; scrubbing any in-window hour renders
≥2-point tracks for both aircraft and vessels, both interpolating smoothly
between recorded fixes exactly as replay does today; the 939-test baseline
grows, never shrinks; `bash scripts/verify.sh` green.
