# Performance results — 2026-07-27 (after)

Same box, same harnesses, same commands as `docs/perf-baseline-2026-07-27.md`.
Each section lands as its phase lands, so the deltas are attributable.

---

## Phase 1 — sidecars

Changes: union cached once per pump and served with gzip + ETag; `/health` stops
rebuilding the union it had already counted; the three tar1090 sources pump
concurrently on a wall-clock grid; images off at the renderer; viewport halved with
the zoom compensated so the fetched extent is unchanged; long-lived-scraper process
flags on both feeders; per-source read timeout so one wedged renderer cannot stall
the union; AIS supervision split into liveness-restart and clock-escalated staleness
with a restart budget.

### Process cost (measure_api.py, 90 s @ 2 s, all defaults)

**CORRECTED after a second measurement — read this table, not the first one I
wrote.** The intermediate "after" sample showed chrome at 128 % CPU and node at
0 %. Both were artifacts: MyShipTracking was refusing our browser at that moment,
so the AIS feeder's context was idle, and the 2 s sampling interval aliased
node's 1 Hz burst. A settled re-measurement with **both** tiers live, five
minutes after boot, is below. Recording the wrong numbers and the correction
rather than quietly replacing them, because the mistake — measuring a system with
one tier dead and calling it "after" — is the more useful thing to remember.

| Metric | before | after (settled, both tiers live) | verdict |
|---|---|---|---|
| `cpu%` chrome p50 | 393.6 % | 828.8 % | **not improved** |
| `rss_mb` chrome p50 | 8 881 MB | **4 050 MB** | **-54 %** |
| chrome processes p50 | 53 | **22** | **-58 %** |
| `cpu%` node p50 | 44.0 % | 72.5 % | ~neutral per unit of data |
| `rss_mb` node | 1 055 MB | 1 140 MB | flat |
| `cpu%` api p50 | 31.0 % | 50.1 % | higher, on 37 % more data |
| **aircraft in the union** | 12 131 | **16 859** | **+39 %** |
| **vessels in the store** | 22 239 | **38 599** | **+74 %** |

Both tiers are carrying substantially more data than at baseline, which is the
honest confound: chrome CPU tracks the number of features the tar1090 pages are
managing. Per unit of data it is 11.5 %/k before against 15.0 %/k after — so
**CPU is not improved, and may be slightly worse.**

A control ruled out the most likely suspect: running the feeder with
`BLOCK_IMAGES=0` (images on) settled at ~745 % chrome CPU against ~828 % with
them off, at a comparable aircraft count. The image flag is not the cause.

What IS proven improved: **memory (-54 %) and renderer count (-58 %) while
carrying 39 % more aircraft**, and the per-request cost below.

### Per-request sidecar cost (measure_sidecars.sh)

| endpoint | before | after |
|---|---|---|
| `:8090/aircraft.json` p50 | 8.2 ms | **0.6 ms** |
| `:8090/health` p50 | 1.3 ms | **0.5 ms** |

**93 % faster per request**, and `/health` no longer rebuilds a 39k-entry map to
report a number the pump loop already knew. This is the unambiguous win.

Gzip was also measured and then **backed out of the hot path**. Compressing the
~2.8 MB union once a second took node from 44 % to 109 % CPU to save a loopback
transfer that costs about a millisecond. It is now built lazily and memoised per
revision — a remote consumer that asks for it still gets it and pays once — and
the backend no longer sends `Accept-Encoding: gzip` to a `127.0.0.1` feed at all.
Node came back to 72 %. The ETag is the part that actually pays.

### Coverage held

`:8090/health` after the change: `total: 12626` across three sources
(9 609 / 12 845 / 8 938), `age_s: 0`. Before: `total: 12131`. The smaller viewport
covers the same ground because the zoom was dropped by one to compensate, which is
the whole point of coupling them.

### Supervision: the respawn storm is gone, proven live

MyShipTracking blocked us mid-session. Under the old supervisor that is a
kill-and-respawn of a full Chromium every 60 s for as long as the block lasts —
the exact condition commit `2ff71f9` measured at 496 leaked renderers in 1h40m.

Observed over ~8 minutes of continuous blocking, from the API log:

```
ais sidecar myshiptracking not serving on http://127.0.0.1:8093 — restarting   (x1, port was dead)
```

**One restart**, for the one real cause (I had killed the port). Zero restarts for
the eight minutes of serving-but-stale that followed. The poller is meanwhile
correctly refusing the empty union, so nothing wrong is being served.

### A change that was measured and reverted

Blocking subresources with a Playwright `context.route` handler wedged the ADS-B
read loop: pumps stopped landing and `/health` `age_s` climbed to 163 s while every
slot still held good data. A route handler round-trips every subresource through the
node process, and three tar1090 tabs is enough to saturate that. Replaced with
`--blink-settings=imagesEnabled=false`, which costs nothing at runtime, plus a
`READ_TIMEOUT_MS` race around `page.evaluate` so a wedged renderer can never again
stall the union.

The same route handler was tried on the AIS feeder and its vessel endpoint became
unreachable. **Control case:** the pre-change file, restored from git and run on
port 8099, failed identically (`init failed - myshiptracking vessel API not
reachable yet`, repeatedly, for 150 s). So the AIS outage is upstream, not ours —
but the route handler is out of both feeders on the ADS-B evidence alone.

---

## Phase 2 — the backend under all toggles

Changes: the vessel world payload is pre-rendered on a 5 s cycle and served as
bytes with ETag/304, exactly as the ADS-B world blob already was; `/api/places/*`
gained a 10-degree grid index keyed by (dataset, category); `/api/status/perf`
exists, so event-loop lag is measurable at all.

### Route cost, measured live

| endpoint | before | after (warm) | change |
|---|---|---|---|
| `/api/maritime/snapshot` | 270 ms / 1 624 682 B | **2.8 ms / 515 806 B** | **-99 % time, -68 % bytes** |
| `/api/maritime/snapshot?parked=1` | 77 ms / 805 504 B | **1.4 ms / 281 594 B** | -98 % / -65 % |
| `/api/places/infrastructure?category=datacenter` | (full 125 612-row scan) | **1.9 ms** | — |
| `/api/places/infrastructure?category=power` | (full scan) | **9.4 ms** | — |
| `/api/places/bases` | (full 7 183-row scan) | **1.9 ms** | — |
| `/api/adsb/global?limit=20000` | already blob-served | 1.4 ms / 1 110 324 B | unchanged |

The first `/api/places/infrastructure` call after boot costs ~700 ms because it
builds the index for that category over 125 612 rows. That is once per category
per process, against ~117 requests a minute in steady state.

In-process benchmark of the same queries (20 iterations, warm, US-west bbox):

| query | full scan | grid | speedup |
|---|---|---|---|
| infrastructure, category=datacenter | 8.17 ms | **0.09 ms** | **90x** |
| infrastructure, category=power | 2.98 ms | **0.76 ms** | 3.9x |
| airports | 0.18 ms | **0.05 ms** | 3.7x |
| bases | 0.19 ms | **0.13 ms** | 1.5x |

`power` gains least because both paths stop at the 1000-row limit early; the
category-filtered layers, which are the ones firing nine times per camera move,
gain most.

### Event-loop lag is now measurable

`/api/status/perf` reports it from a probe that asks for 0.5 s and records the
overshoot:

```
loop_lag_ms_p50: 0.0   loop_lag_ms_p95: 199.0   loop_lag_ms_max: 1201.0   (120 samples / 60 s)
```

The baseline could not report this at all. p50 is clean; the p95/max tail is the
1 s snapshot cycle's own merge chain plus GC, which is Phase 3 territory and is
now visible rather than inferred.

The endpoint also reports blob sizes and ages, the feed-cache depth, parked-cache
size, and the AIS supervision state (stale-for, restarts-in-window,
budget-exhausted) so the sidecar behaviour from Phase 1 is inspectable without
reading a log.

---

## Phase 3 — frontend render and toggle cost

Changes: one shared move-settle gate for the whole map (batched release, priority
ordered) instead of sixteen private debounces; a move-refresh is skipped when the
URL it would request is the one already fetched; polling pauses while the tab is
hidden; `maritime.parked` gained the viewport query and cap it never had; and
`LayerDescriptor` gained `maxEntities`, restoring a real per-layer cap.

### All toggles on, measured in a real browser on the GPU

| Metric | baseline | after Phase 3 | change |
|---|---|---|---|
| `rendersPerSec` p50 | 5.0 | **6.0** | +20 % |
| `rendersPerSec` p50, world view | 6.0 | **10.0** | **+67 %** |
| `frameMsEMA` p50 | 239.3 ms | **148.7 ms** | **-38 %** |
| Cesium entities p50 | 60 826 | **39 127** | **-36 %** |
| Cesium entities p05 | 54 970 | 34 555 | -37 % |
| **Measured request rate** | 282 req/min | **221 req/min** | **-22 %** |
| `drainMsLast` p50 | 7.1 ms | 5.0 ms | -30 % |
| JS heap p50 | 2 678 MB | 2 476 MB | -8 % |

### Where the entities actually were

Guessing would have targeted the wrong layer. The per-data-source breakdown, all
toggles on:

| data source | entities |
|---|---|
| **`hazards.nasa.firms`** | **14 818** |
| `aviation.adsb.global` | 14 458 |
| `maritime.keyless` | 6 000 |
| `maritime.parked` | 6 000 (was uncapped; the store held 26 203) |
| `maritime.aisstream` | 5 819 |
| `infra.cables.landings` | 1 918 |
| `infra.cams.public` | 1 820 |
| …72 more | ~9 000 |
| **total** | **59 942 across 78 data sources** |

The largest layer was **not** the aircraft feed everyone watches — it was NASA
FIRMS, uncapped, at 14 818 fire detections. Cesium's `DataSourceDisplay` walks
every entity of every data source every frame, so an off-by-default long-tail
layer costs exactly what the primary feed costs.

### What did NOT work, and why it is recorded

The first version of the shared gate capped concurrency with a microtask, which
capped nothing: `refresh()` is fire-and-forget, so every queued layer still fired
inside the same frame. Measured request rate went **up**, 282 to 321/min. The
batched-release rewrite plus the unchanged-URL skip is what produced the 221.

### Honest limit — this is not finished

**5 fps to 6 fps is not a fix.** The remaining cost is structural: 78 Cesium data
sources and ~39 000 individually-managed entities, walked per frame by the Entity
API. `ScriptDuration` is 97 % of `TaskDuration`, so it is JS, not the GPU.

The known remedy is the one Palantir describe for exactly this
(docs/palantir-reference-2026-07.md §7): batch by style into single draw calls —
"10,000 lines with the same styling become one GPU operation". This repo already
has that path (`PrimitiveEntityLayer`, shared `BillboardCollection` +
`LabelCollection`) and it is why the 14 458 aircraft are affordable. Extending it
to the other ~45 layers is the work that moves 6 fps to 25 fps, and it is **not
done in this branch**. Recorded here so the next person starts from the
measurement rather than from the same guess.

---

## Phase 4 — the right-side controls

The operator's report was "the right side of the globe the selector its hard to
control and is bugged". Reading found four defects; three are fixed here.

**The rail resizer had no pointer capture, no `pointercancel` handler, and no
`touch-action`.** It listened on `window`, so any gesture the browser cancelled —
a touch interruption, a context menu, the pointer leaving the window — never
fired `pointerup`. Both listeners stayed attached and
`document.body.style.userSelect` stayed `'none'` **forever**: the rail tracked the
cursor and the whole document became unselectable. `FloatingPanel.tsx` had fixed
this exact bug in that file and left a comment saying so; this one never got the
same treatment. `touch-action` appeared **nowhere** in the frontend.

Proven live, dragging the separator and releasing the button outside the window:

```
RESIZER : hit=11px userSelect="" cameraRotate=true
```

Before the fix that release path left `userSelect` stuck at `none`. The hit area
also went from 7 px to 11 px with the visible chrome unchanged, and a double-click
snaps back to the default width.

**The move tool could strand the camera locked.** It disabled `enableRotate` and
`enableTranslate` on `LEFT_DOWN` and restored them only from Cesium's `LEFT_UP`,
which fires on the canvas alone. Release anywhere else and the globe stayed
undraggable until the tool was switched. Window-level `pointerup`, `pointercancel`
and `blur` now all end the drag, and the previous values are restored rather than
an unconditional `true`. The drag also writes the store once per animation frame
instead of once per mousemove event.

Not fixed in this branch, and named so it is not mistaken for done: the toolbar is
rendered inside a `z-0` wrapper that caps its `--z-dock` (the file's own comment
calls these "z-0-trapped overlays"), and three `ScreenSpaceEventHandler`s share
the canvas so a tool click also mutates the selection.

---

## Phase 5 — annotate

"Mediocre, not many options, and not fun to use." What was actually there: three
kinds, four fixed colours, one label field, no undo, no groups, no export, and a
`loadAnnotations` that was exported and **imported by nothing**, so even a manual
Save was never read back. The map toolbar hardcoded
`{ threat: 'unknown', label: '' }` and could only drop a point, so its own tooltip
promised "labelled markers" and produced unlabelled yellow dots. And the renderer
called `removeAll()` then re-added every entity on **every** store change — one
keystroke in the label field, or one frame of a marker drag, tore down the layer.

Now:

| | before | after |
|---|---|---|
| Kinds | 3 (point, line, circle) | **11** (+ polygon, rect, arrow, corridor, sector, text, symbol, freehand) |
| Colour | 4 fixed threat values | 4 threat presets **+ any CSS colour** (native `<input type="color">`) |
| Style | none — width/opacity/font all hardcoded | width, stroke opacity, fill opacity, dash (solid/dashed/dotted), font size, point size, outline |
| Undo/redo | none | 50-step history, `Ctrl+Z` / `Ctrl+Shift+Z` |
| Per-item | delete only | show/hide, lock, rename, restyle, fly-to, delete |
| List | unsorted, unfiltered | filter box, empty states |
| Persistence | manual save that was never loaded | localStorage on every change **+** the ontology round-trip, now actually called and merged newest-wins |
| Import/export | none | GeoJSON both ways, round-trip tested |
| Clear all | no confirmation | two-step confirm |
| Renderer | full teardown per change | upsert by id, guarded |

Verified live in the browser — all eight geometry kinds placed through the shared
draft, rendered, and undone:

```
ANNOTATE: {"placed":8,"rendered":10,"afterUndo":7,"afterRedo":8,"kinds":8}
CONSOLE ERRORS: 0
```

(10 entities for 8 annotations: line and arrow carry their label on a separate
mid-point entity, since a polyline has no anchor position of its own.)

The three surfaces that create annotations — panel, map toolbar, context menu —
now read ONE shared draft, so they cannot disagree again.

### Guards added

`globe/invariants.test.ts` now asserts `AnnotationLayer.ts` contains no
`.removeAll(` and does contain `getById`. The rule existed for
`PollGeoJsonAdapter` and had simply never been extended, which is exactly why the
regression was invisible. Plus six store tests covering every kind, undo/redo,
lock, colour precedence, the GeoJSON round-trip, and the shared draft.

`bash scripts/verify.sh` — **ALL GREEN**, 1980 backend tests passed + 2 skipped
(baseline was 1972), 440 web tests passed (was 433).

---

## Final measurement — everything on, everything live

Same harness, same camera script, same box. Note the load is **higher** than the
baseline run, which makes the comparison conservative rather than flattering.

| Metric | baseline | final | change |
|---|---|---|---|
| `rendersPerSec` p50 | 5.0 | **7.0** | +40 % |
| `rendersPerSec` p95 | 8.0 | **19.0** | +138 % |
| `frameMsEMA` p50 | 239.3 ms | **147.4 ms** | **-38 %** |
| Cesium entities p50 | 60 826 | **38 479** | **-37 %** |
| Cesium entities p05 | 54 970 | **26 942** | -51 % |
| JS heap p50 | 2 678 MB | 2 484 MB | -7 % |
| `drainMsLast` p50 | 7.1 ms | 5.5 ms | -23 % |
| Measured request rate | 282 req/min | **221 req/min** | **-22 %** |
| chrome RSS | 8 881 MB | **4 050 MB** | **-54 %** |
| chrome renderers | 53 | **22** | **-58 %** |
| `:8090/aircraft.json` p50 | 8.2 ms | **0.6 ms** | **-93 %** |
| `/api/maritime/snapshot` p50 | 270 ms | **2.8 ms** | **-99 %** |
| `/api/maritime/snapshot` bytes | 1 624 682 | **515 806** | -68 % |
| — while carrying — | | | |
| aircraft | 11 770 | **16 957** | **+44 %** |
| vessels | 26 001 | **40 994** | **+58 %** |
| `scripts/verify.sh` | green | **green** | 1985 + 2 skipped (was 1972) |

### What is still true and unfixed

**7 fps with every toggle on is still not good.** 78 Cesium data sources and
~38 000 individually-managed entities keep the Entity API walk at ~97 % of the
main thread. The fix is known, is what Palantir describe for exactly this
problem, and this repo already has the machinery for it
(`PrimitiveEntityLayer` — it is why 16 957 aircraft are affordable). Extending
it to the other ~45 layers is the next piece of work and is not in this branch.

**Chrome CPU in the sidecar tier is not improved** (see the corrected Phase 1
table). Memory, renderer count and per-request latency are; CPU tracks feature
count and a control ruled out the image flag.

**The model is configured, not proven fast.** The flags are passed and guarded,
but no model was active during this session, so there is no
time-to-first-token number to report. `measure_llm.py` exists to produce one the
moment a model is selected.
