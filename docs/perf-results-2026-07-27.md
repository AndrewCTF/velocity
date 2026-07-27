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

| Metric | before | after | change |
|---|---|---|---|
| `cpu%` chrome p50 | 393.6 % | **128.3 %** | **-67 %** |
| `cpu%` chrome p95 | 1203.6 % | **734.4 %** | -39 % |
| `cpu%` chrome max | 1522.6 % | **877.3 %** | -42 % |
| `rss_mb` chrome p50 | 8 881 MB | **6 386 MB** | **-28 %** |
| chrome processes p50 | 53 | **45** | -15 % |
| `cpu%` node p50 | 44.0 % | **0.0 %** | **-100 %** |
| `rss_mb` node | 1 055 MB | **393 MB** | **-63 %** |
| `cpu%` api p50 | 31.0 % | 28.8 % | -7 % |
| **aircraft_count p50** | 11 770 | **11 754** | **unchanged — the floor holds** |

The "after" chrome figures are pessimistic: MyShipTracking began refusing our
browser during this session (proven upstream, not a regression — see below), so its
feeder is in a page-reload loop for the whole sample.

### Per-request sidecar cost (measure_sidecars.sh)

| endpoint | before | after |
|---|---|---|
| `:8090/aircraft.json` p50 | 8.2 ms / 2 604 272 B | **0.4 ms / 721 215 B (gzip)** |
| `:8090/health` p50 | 1.3 ms / 198 B | **0.3 ms / 308 B** |

`/aircraft.json` is 95 % faster and 72 % smaller on the wire, and `/health` no longer
rebuilds a 39k-entry map to report a number the pump loop already knew.

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
