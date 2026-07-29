# Edge wave 1b — the sidecar CPU, attributed

Companion to `docs/edge-wave-1-vram.md`, which found the VRAM was the model
stack and not the scrapers. This one measures the CPU, which **is** the scrapers.

Operator's report: *"it uses a hell lot ton of RAM and CPU, especially the
sidecars."* Correct. Measured, with the union at ~19 000 aircraft: 24-25 Chromium
processes, **4 457 MB RSS**, and a single renderer at **433 %**.

## The question

`readFn` (`tools/adsb-globe-feeder/index.js:77-99`) reads `g.planesOrdered` —
tar1090's *parsed* aircraft store. We never look at a pixel. So how much of the
CPU is the rendering we throw away?

## The experiment

Two feeders, identical except for one flag, same single source
(`globe.airplanes.live`), same box, same moment. Both loaded **14 209 aircraft**
at warm-up.

- `:8098` control — unmodified.
- `:8099` — `OLMap.setTarget(null)` after the store first fills, which stops
  OpenLayers rendering while leaving the `View` (and so the fetch extent) intact.

Cost is the whole process tree rooted at each feeder's node pid, so each
browser's renderers are attributed to their own feeder.

| t | | CPU | RSS | procs | `/health` total | rev |
|---|---|---|---|---|---|---|
| +90 s | control | **213.6 %** | 1 765 MB | 9 | 14 609 | 8 |
| +90 s | detached | **43.2 %** | 1 583 MB | 9 | 14 209 | 8 |
| +165 s | control | **227.1 %** | 1 975 MB | 9 | **15 338** | 28 |
| +165 s | detached | **31.9 %** | 1 581 MB | 9 | **14 209** | 28 |

## Result 1 — rendering is ~85 % of the sidecar's CPU

**227 % → 32 %, a 7× cut**, for one source. Extrapolated across the three
sources the default config runs, that is the difference between roughly six cores
and one. The operator's complaint is not that scraping is expensive; it is that
we are rendering three world maps at full rate to read three JavaScript arrays.

## Result 2 — and the change is rejected, because it silently freezes the data

The detached feeder's `total` sat at **exactly 14 209** — its warm-up value —
across 28 pump cycles, while the control climbed 14 209 → 14 609 → 15 338.
tar1090's fetch loop is coupled to the map after all: detaching the target stops
it refreshing the store.

The dangerous part is not that it broke. It is **how** it broke:

```
:8099  {"total":14209, "rev":28, "age_s":1, ...}
```

`rev` advancing, `age_s` at 1 second, a plausible 14 209 aircraft. Every health
signal we have says green. That is precisely the failure class
`docs/decisions.md` (2026-07-15) already records — *a tier that can serve a cache
must publish the age of the DATA, never the age of the response* — reappearing
in a new place. Our `age_s` here is the age of **our pump**, not of tar1090's
store, so it cannot see this at all.

`OLMap.setTarget(null)` is therefore **not shipped**, and the flag that carried
it in the spike has been reverted out rather than left off-by-default: a code
path that produces a convincingly healthy frozen feed is worse than no code path.

## What this buys the next attempt

The measurement is the point. It establishes, with numbers rather than
inference, that ~85 % of the sidecar CPU is discardable — which is what makes the
remaining option worth the work:

**Fetch tar1090's data endpoint in-page instead of reading its store.** This is
the pattern the AIS feeder already uses
(`tools/ais-myshiptracking-feeder/index.js:173-180`): `goto` the origin once for
cookies and the real Chrome TLS identity, then
`page.evaluate(() => fetch(...))` against the site's own JSON endpoint. Same
origin, no map, no render loop, and — critically — **the freshness comes from our
own fetch**, so there is no store to silently freeze.

The endpoint is undocumented and must not be guessed. Capture it: attach CDP
`Network`, record every request the page issues for 60 s, identify the aircraft
one, replay it from a blank same-origin page and diff the decoded result against
`readFn`'s output for the same instant.

Two acceptance conditions, both non-negotiable, both learned above:

1. The union must still carry **≥ 8 000 aircraft** (`verify.sh --live`,
   `tests/test_invariants.py` with `OSINT_LIVE_PROBE=1`).
2. The count must **move** against a control feeder over ≥ 5 minutes. A static
   count with a healthy `age_s` is the exact bug this spike just produced, and
   any replacement reader must be tested for it explicitly.

Also carried forward, unmeasured so far: whether `nudgeAll()`
(`index.js:251-259`) can go once the reader no longer depends on the map, and
whether three sources still earn their cost once the per-source cost changes.

## Also rejected in this wave

`--disable-gpu` on the four feeders. Measured: the scrapers hold **0 MiB** of
VRAM, so the flag has no effect to buy. See `docs/edge-wave-1-vram.md`.

## Status

Nothing from 1b ships. Two hypotheses tested, both rejected with numbers, and the
number that matters — **85 % of sidecar CPU is render work we discard** — is now
on record instead of assumed.
