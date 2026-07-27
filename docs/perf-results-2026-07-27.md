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
