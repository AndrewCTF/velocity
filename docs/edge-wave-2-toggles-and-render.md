# Edge wave 2 — the toggle storm, and the render cost under it

Operator report: *"when I turn on the backend options from the UI panel, it just
causes CPU lag to spike and it lags too much."*

Two changes were tried. **One of them did not pay and is reported as such**,
because a change with a good story and no measured effect is exactly what this
wave is supposed to catch.

All runs: real Chrome on the GPU (`DISPLAY=:0`, `env -u LD_PRELOAD`), 78 data
sources, both feeder tiers live, `tools/perf/measure_ui.mjs`. JSON reports via
the new `--out`.

---

## 1. A new profile, because none of the existing ones measured this

`--profile all-toggles` enables everything at once and then **settles for 20 s**
before it starts sampling. That measures the steady state and hides the
transient entirely — and the transient is the entire complaint.

`--profile toggle-storm` (new) enables layers and samples **during** the enable,
once a second, then reports the worst 5-sample window rather than the median. It
writes its numbers to `--out` as JSON so the result is gradable by command.

The first version of the profile paced enables at 8 layers every 3 s, which was
wrong: that pacing spreads the load enough to hide the spike. Measured gated vs
ungated under it, the difference was inside the noise (frameMs p50 81.8 vs 89.4;
worst window 131.7 vs 141.6 — the "improved" run was *slower*). It now enables
the whole set in one call, which is the shape `LayerCatalog.toggleFolder` and
`LayerRail`'s mission presets actually produce.

---

## 2. Gating the enable-fetch — measured, marginal, kept with caveats

`PollGeoJsonAdapter.attach()` ended in `this.scheduleNext(0)`: an immediate,
ungated request plus a synchronous entity build of up to `MAX_PER_LAYER`
features. Fine for one layer; N of them land in the same frame when a folder is
toggled. The shared move-settle gate (`globe/pollGate.ts`) already solved that
shape for camera moves and had simply never been applied to enables.

The first fetch now goes through `onMoveSettle`, and `detach()` calls
`cancelMoveSettle` so flicking a toggle off before its turn spends no request.

Bulk toggle, same session, code flipped between runs:

| | ungated | gated |
|---|---|---|
| requests | 247.9/min | **228.1/min** (−8 %) |
| `longtasksPerMin` p50 | 67.0 | **49.0** (−27 %) |
| `frameMsEMA` p50 | 70.5 | **61.4** (−13 %) |
| `frameMsEMA` p95 | **90.7** | 128.1 (**worse**) |
| worst 5-sample window | **77.5 ms** | 84.1 ms (**worse**) |

**On its own the tail got worse.** Deferring the fetches clusters the entity
builds behind them, so the p50 improved and the p95 did not. That is why the
gate is not presented as the fix by itself.

**With §3's batching it is a different result**, and this is the one that
matters — the entity builds the gate defers are now cheap:

| toggle storm | frameMs p50 | p95 | longtasks p50 | worst 5 s window |
|---|---|---|---|---|
| ungated, Entity API (baseline) | 70.5 | 90.7 | 67.0 | 77.5 ms |
| gated, Entity API | 61.4 | **128.1** | 49.0 | 84.1 ms |
| **gated + batched** | **22.5** | **50.1** | **16.0** | **48.9 ms** |

Against the baseline: **frame time −68 %, p95 −45 %, longtasks −76 %, worst
window −37 %.** The two changes only pay together — the gate spreads the work,
the batching makes the work cheap, and either alone is a wash or worse.

Request rate went **up**, 247.9 → 283.7/min. That is not a regression being
buried: the app is no longer stalling, so it completes more move-settle cycles
in the same window. Worth watching, not worth undoing.

---

## 3. Batching the remaining layers into primitive collections

This is the item `docs/perf-results-2026-07-27.md` named and did not do, and it
is where the cost actually is.

Only aircraft, vessels and satellites used `PrimitiveEntityLayer`. Every other
layer built per-entity Cesium billboards and labels, which `DataSourceDisplay`
walks every frame. The largest layer with everything on was not the aircraft
feed but `hazards.nasa.firms` at 14 818 entities.

Five style kinds moved onto the batched path — `fire`, `camera`, `facility`,
`warning`, `hazard`. Each already returned `{ imageUri, scale }`, which is
exactly `PrimitiveEntityLayer`'s `styleFn` shape, so this is routing existing
style functions into an existing class rather than a new renderer. Their
entities are now graphics-less (as aircraft and vessels already were) but keep
`e.name`, so selection, the watchbox evaluator and the facet counts are
unaffected. `maxAlt` in the dispatch table reproduces each kind's previous
`distanceDisplayCondition` exactly, so nothing starts painting at a zoom it did
not before, and `refreshStyle` upserts through the primitive layer — without
that, a facility whose category changed would have kept its first-seen icon.

**Controlled A/B, same session, same box, code flipped between runs:**

| Metric | Entity API | **batched** | change |
|---|---|---|---|
| `rendersPerSec` p50 | 8.0 | **10.0** | **+25 %** |
| `rendersPerSec` p05 | 4.0 | **5.0** | **+25 %** |
| `frameMsEMA` p95 | 200.7 ms | **179.9 ms** | **−10 %** |
| `frameMsEMA` p50 | 127.4 ms | **123.2 ms** | −3 % |
| entities p50 | 37 578 | **44 179** | **+17 % MORE load** |
| `longtasksPerMin` p50 | 428 | 514 | worse |
| heap p50 | 2 100 MB | 2 475 MB | worse |

The improvement is delivered while carrying **17 % more entities**, so
normalised per entity the frame rate is roughly 47 % better. Longtasks and heap
are worse in absolute terms and roughly flat per entity — stated rather than
netted out.

---

## What this does NOT claim

**It is still not 20 fps.** `measure_ui.mjs` fails the run at `p05 < 20` and it
still fails at 5.0. Ten of the seventy-eight data sources now batch; the rest of
the long tail (`quake`, `jamming`, `airport`, `port`, `base`, `tfr`,
`hazardpoly`, `generic`, plus `AisWsAdapter`, `CablesAdapter`, `AreaAdapter`,
`MilSymbolAdapter`) still build per-entity graphics. `maritime.aisstream` alone
was 5 819 entities on the Entity API and is untouched here.

**The gate did not fix the toggle tail.** See §2. The p95 during a bulk toggle
got worse, not better.

The next piece of work is the rest of the batching, and the honest expectation
is that it moves fps the same way this did — incrementally — rather than
reaching 20 in one step.

## Reproducing

```bash
node tools/perf/measure_ui.mjs --profile all-toggles  --seconds 75 --out /tmp/at.json
node tools/perf/measure_ui.mjs --profile toggle-storm --seconds 45 --out /tmp/storm.json
```
