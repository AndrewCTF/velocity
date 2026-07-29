# Performance baseline — 2026-07-27 (before)

Branch `perf-annotate-sidecars-2026-07-27` at `0a6a72a`. Box: 32 cores, RTX 5090.
Backend booted with `bash scripts/run-api.sh`; frontend `pnpm --filter @osint/web dev`.

# measure_sidecars — 2026-07-27 19:01:14

chrome procs: 61   chrome RSS: 9267 MB
adsb feeder:  
ais  feeder:  

| endpoint | code | p50 total | p50 size |
|---|---|---|---|
| adsb :8090 /aircraft.json | 200 | 8.2 ms | 2604272 bytes |
| adsb :8090 /health | 200 | 1.3 ms | 198 bytes |
| ais  :8093 /vessels.json | 200 | 5.2 ms | 1985576 bytes |
| ais  :8093 /health | 200 | 0.3 ms | 72 bytes |

### /health bodies
```
{"total":12131,"sources":{"https://globe.airplanes.live/":{"aircraft":9210,"age_s":1},"https://adsb.lol/":{"aircraft":8191,"age_s":0},"https://globe.adsbexchange.com/":{"aircraft":11825,"age_s":0}}}
{"total":22239,"age_s":23,"cells_ok":66,"cells_fail":6,"cells_total":72}
```
# measure_api — 2026-07-27 19:01:24
base=http://127.0.0.1:8000 seconds=90 interval=2.0 routes=True

/api/status: status=operational aircraft=11548 vessels=26001 parked=10966
api pid 37402: apps/api/.venv/bin/python3 apps/api/.venv/bin/uvicorn app.main:app --app-dir apps/api --port 8000

## Process sampling — root pid 37402, 90s @ 2.0s

ticks: 42

| series | p50 | p95 | max |
|---|---|---|---|
| chrome_procs | 53.0 | 61.0 | 61.0 |
| cpu%:api | 31.0 | 81.4 | 93.7 |
| cpu%:cat | 0.0 | 0.0 | 0.0 |
| cpu%:chrome | 393.6 | 1203.6 | 1522.6 |
| cpu%:llama-server | 0.0 | 0.0 | 0.0 |
| cpu%:node | 44.0 | 62.5 | 67.7 |
| fds:api | 25.0 | 28.0 | 28.0 |
| procs | 61.0 | 69.0 | 69.0 |
| rss_mb:api | 577.7 | 599.8 | 634.6 |
| rss_mb:cat | 27.6 | 27.6 | 27.6 |
| rss_mb:chrome | 8881.5 | 9129.0 | 9178.3 |
| rss_mb:llama-server | 115.3 | 115.3 | 115.3 |
| rss_mb:node | 1054.9 | 1076.7 | 1077.9 |
| loop_lag_ms | NOT AVAILABLE (/api/status/perf absent) | | |
| aircraft_count | 11770 | 11958 | 12000 |
| vessel_count | 28215 | 48249 | 48290 |

## Route cost table — 62 layer endpoints × 2 GETs

| endpoint | ttfb p50 ms | total p50 ms | bytes p50 | enc | etag | status |
|---|---|---|---|---|---|---|
| `/api/hazards/gdacs` | 15373.6 | 15373.6 | 0 | - | - | 502 |
| `/api/intel/dark-vessels/sar?aoi=gulf-of-aden` | 8104.0 | 8104.1 | 2,479 | gzip | - | 200 |
| `/api/intel/dark-vessels/sar?aoi=taiwan-strait` | 6743.9 | 6744.5 | 14,302 | gzip | - | 200 |
| `/api/maritime/warnings` | 6472.4 | 6472.5 | 0 | - | - | 502 |
| `/api/intel/dark-vessels/sar?aoi=kerch-strait` | 3966.5 | 3966.7 | 168 | gzip | - | 200 |
| `/api/intel/dark-vessels/sar?aoi=bab-el-mandeb` | 3875.0 | 3876.2 | 20,949 | gzip | - | 200 |
| `/api/intel/dark-vessels/sar?aoi=hormuz` | 3425.6 | 3425.7 | 3,182 | gzip | - | 200 |
| `/api/intel/dark-vessels/sar?aoi=suez-gulf-approach` | 2918.2 | 2918.3 | 185 | gzip | - | 200 |
| `/api/aviation/states` | 1566.5 | 1648.3 | 469,331 | gzip | - | 200 |
| `/api/intel/brief` | 501.1 | 501.3 | 7,681 | gzip | - | 200 |
| `/api/adsb/global` | 287.5 | 288.2 | 749,309 | gzip | - | 200 |
| `/api/maritime/snapshot` | 267.7 | 269.9 | 1,624,682 | gzip | - | 200 |
| `/api/hazards/reliefweb` | 243.5 | 243.5 | 0 | - | - | 502 |
| `/api/adsb/fi/global` | 193.5 | 193.5 | 0 | - | - | 502 |
| `/api/maritime/snapshot?parked=1` | 74.6 | 76.7 | 805,504 | gzip | - | 200 |
| `/api/firms?source=VIIRS_SNPP_NRT&days=1` | 37.3 | 38.0 | 271,284 | gzip | - | 200 |
| `/api/conflict/live?hours=6` | 21.0 | 35.1 | 97,555 | gzip | - | 200 |
| `/api/cables` | 22.3 | 22.5 | 251,170 | gzip | - | 200 |
| `/api/space/gp?group=starlink&limit=4000` | 16.5 | 16.6 | 236,121 | gzip | - | 200 |
| `/api/infra/powerplants?min_mw=500` | 10.1 | 10.2 | 93,165 | gzip | - | 200 |
| `/api/cables/landings` | 3.7 | 6.3 | 75,268 | gzip | - | 200 |
| `/api/maritime/digitraffic` | 2.5 | 5.2 | 62,089 | gzip | - | 200 |
| `/api/airspace/tfr` | 2.2 | 3.7 | 32,365 | gzip | - | 200 |
| `/api/hazards/volcanoes` | 2.0 | 3.3 | 35,867 | gzip | - | 200 |
| `/api/hazards/radiation` | 1.9 | 2.9 | 15,841 | gzip | - | 200 |
| `/api/eq?range=day` | 1.5 | 2.8 | 23,843 | gzip | - | 200 |
| `/api/maritime/buoys` | 1.6 | 2.5 | 25,239 | gzip | - | 200 |
| `/api/maritime/chokepoints` | 2.2 | 2.3 | 518 | gzip | - | 200 |
| `/api/cams` | 1.4 | 2.2 | 21,902 | gzip | - | 200 |
| `/api/space/gp?group=visual&limit=4000` | 1.1 | 1.6 | 11,030 | gzip | - | 200 |
| `/api/jamming/nacp` | 1.1 | 1.6 | 11,432 | gzip | - | 200 |
| `/api/events/eonet?status=open&limit=500` | 0.9 | 1.6 | 20,339 | gzip | - | 200 |
| `/api/adsb/live/mil` | 1.1 | 1.5 | 9,288 | gzip | - | 200 |
| `/api/aviation/sigmet` | 1.3 | 1.4 | 620 | gzip | - | 200 |
| `/api/seismic/emsc?minmag=2.5&hours=24` | 1.0 | 1.4 | 10,258 | gzip | - | 200 |
| `/api/cyber/ioda/outages?days=7` | 1.1 | 1.1 | 73 | gzip | - | 200 |
| `/api/space/gp?group=gps-ops&limit=4000` | 1.0 | 1.1 | 2,270 | gzip | - | 200 |
| `/api/airspace/nas-status` | 1.1 | 1.1 | 733 | gzip | - | 200 |
| `/api/weather/swpc/space` | 1.0 | 1.0 | 1,714 | gzip | - | 200 |
| `/api/weather/alerts` | 0.9 | 1.0 | 2,405 | gzip | - | 200 |
| `/api/climate/anomalies` | 0.9 | 1.0 | 534 | gzip | - | 200 |
| `/api/env/air-quality` | 0.9 | 1.0 | 1,664 | gzip | - | 200 |
| `/api/space/gp?group=stations&limit=4000` | 0.9 | 0.9 | 1,431 | gzip | - | 200 |
| `/api/hazards/fire-perimeters` | 0.9 | 0.9 | 58 | gzip | - | 200 |
| `/api/hazards/cyclones` | 0.9 | 0.9 | 282 | gzip | - | 200 |
| `/api/adsb/live/emergencies` | 0.7 | 0.7 | 341 | gzip | - | 200 |
| `/api/conflict/ucdp` | 0.6 | 0.7 | 145 | gzip | - | 200 |
| `/api/events/gdelt?timespan=24h` | 0.6 | 0.6 | 96 | gzip | - | 200 |
| `/api/places/infrastructure?category=power&limit=2000` | 0.5 | 0.6 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=nuclear&limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/places/ports?limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/events/acled?days=7` | 0.5 | 0.5 | 97 | gzip | - | 200 |
| `/api/places/infrastructure?category=launch&limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/places/military?limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/places/airports?limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/places/bases?limit=2000` | 0.5 | 0.5 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=telescope&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=water_treatment&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=datacenter&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=desalination&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=telecom_hub&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |
| `/api/places/infrastructure?category=ground_station&limit=2000` | 0.4 | 0.4 | 58 | gzip | - | 200 |

Total p50 wall time to fetch every layer once: 54284 ms across 62 endpoints
Total p50 bytes: 5,015,563

# measure_ui — 2026-07-27T11:06:19.185Z
url=http://127.0.0.1:5173 profile=baseline seconds=60 headless=false
browserType.launch: Executable doesn't exist at /home/andrew/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
    at main (/home/andrew/Projects/OSINT/tools/perf/measure_ui.mjs:127:34)
    at /home/andrew/Projects/OSINT/tools/perf/measure_ui.mjs:284:1
    at async node:internal/modules/esm/loader:639:26 {
  log: [],
  name: 'Error'
}

# measure_ui — 2026-07-27T11:08:02.899Z
url=http://127.0.0.1:5173 profile=all-toggles seconds=90 headless=false
  chrome: /usr/bin/google-chrome-stable
  enabled 58 layers via window.__registry
  toggled 58 layers on; settling 20s

profile check: dataSources=78 entities=60594

## Series (47 samples)

| series | p05 | p50 | p95 | max |
|---|---|---|---|---|
| animatedPrims | 24.0 | 26.0 | 3882.0 | 3883.0 |
| dataSources | 78.0 | 78.0 | 78.0 | 78.0 |
| drainMsLast | 0.0 | 7.1 | 25.0 | 25.0 |
| entities | 54970.0 | 60826.0 | 85661.0 | 85785.0 |
| frameMsEMA | 154.1 | 239.3 | 290.5 | 324.7 |
| heapMB | 1760.1 | 2677.8 | 3619.5 | 3813.6 |
| liveLabels | 0.0 | 0.0 | 0.0 | 0.0 |
| longtasksPerMin | 229.0 | 294.0 | 375.0 | 376.0 |
| rendersPerSec | 3.0 | 5.0 | 8.0 | 16.0 |

## rendersPerSec by camera leg

| leg | p05 | p50 |
|---|---|---|
| world | 5.0 | 6.0 |
| europe-800km | 3.0 | 5.0 |
| orbit | 3.0 | 5.0 |
| london-60km | 3.0 | 4.0 |
| world-return | 2.0 | 4.0 |

## CDP Performance deltas

| metric | delta |
|---|---|
| TaskDuration | 73.6 s |
| ScriptDuration | 71.5 s |
| LayoutDuration | 0.1 s |
| RecalcStyleDuration | 0.1 s |
| JSHeapUsedSize | 817.0 MB |

## Measured /api requests: 347 over 73.9s = 281.9 req/min

| path | count |
|---|---|
| `/api/places/infrastructure` | 144 |
| `/api/adsb/global` | 46 |
| `/api/maritime/snapshot` | 19 |
| `/api/maritime/digitraffic` | 16 |
| `/api/places/airports` | 16 |
| `/api/places/ports` | 16 |
| `/api/places/bases` | 16 |
| `/api/places/military` | 16 |
| `/api/history/coverage` | 15 |
| `/api/timeline/density` | 15 |
| `/api/aviation/states` | 6 |
| `/api/adsb/live/emergencies` | 5 |
| `/api/intel/brief` | 4 |
| `/api/timeline/events` | 3 |
| `/api/adsb/live/mil` | 3 |
| `/api/adsb/fi/global` | 3 |
| `/api/eq` | 1 |
| `/api/seismic/emsc` | 1 |
| `/api/jamming/nacp` | 1 |
| `/api/maritime/chokepoints` | 1 |

## Console errors (5, first 10)

```
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
Failed to load resource: the server responded with a status of 502 (Bad Gateway)
```

**Verdict: POOR (p05 rendersPerSec 3.0 < 20)**

# measure_llm — 2026-07-27 19:09:50
base=http://127.0.0.1:8000 n=3 repeat=False

## /api/ai/hardware (HTTP 200)

```json
{
  "gpu": {
    "name": "NVIDIA GeForce RTX 5090",
    "vram_mb": 32607
  },
  "ram_mb": 124026,
  "disk_free_mb": 232395,
  "recommendation": {
    "preset": "medium",
    "tier": "120b",
    "repo_id": "unsloth/gpt-oss-120b-GGUF",
    "quant": "MXFP4",
    "reason": "MoE hybrid: fits VRAM + partial RAM offload (~121GB RAM)"
  },
  "presets": {
    "speed": {
      "tier": "30b",
      "repo_id": "unsloth/Qwen3.6-35B-A3B-GGUF",
      "quant": "UD-Q4_K_XL",
      "est_size_gb": 22.4,
      "fits": true,
      "reason": "largest model that fits entirely in ~30GB usable VRAM"
    },
    "medium": {
      "tier": "120b",
      "repo_id": "unsloth/gpt-oss-120b-GGUF",
      "quant": "MXFP4",
      "est_size_gb": 63.0,
      "fits": true,
      "reason": "MoE hybrid: fits VRAM + partial RAM offload (~121GB RAM)"
    },
    "quality": {
      "tier": "300b",
      "repo_id": "unsloth/DeepSeek-V4-Flash-GGUF",
      "quant": "UD-Q2_K_XL",
      "est_size_gb": 96.8,
      "fits": true,
      "reason": "largest MoE hybrid this hardware can hold (~121GB RAM available)"
    }
  }
}
```

## /api/ai/local (HTTP 200)

```json
{
  "enabled": false,
  "local_only": false,
  "ollama_host": "http://localhost:11434",
  "ollama_up": true,
  "tool_capable": true,
  "models": [
    "qwen3.6:latest",
    "qwen3-coder:30b-a3b-q4_K_M"
  ],
  "model_fast": "(auto)",
  "model_reason": "(auto)",
  "engine": "auto",
  "selection_model": null,
  "selection_enabled": false
}
```

### cold (3 calls)

| # | id | status | ttfb ms | total ms | cached | backend | chars |
|---|---|---|---|---|---|---|---|
| 1 | `aircraft:4ca892` | 409 | 2 | 2 | no | - | 0 |
|   | error | | | | | | `{"detail":"selection inference is disabled"}` |
| 2 | `aircraft:344216` | 409 | 1 | 1 | no | - | 0 |
|   | error | | | | | | `{"detail":"selection inference is disabled"}` |
| 3 | `aircraft:3c648d` | 409 | 1 | 1 | no | - | 0 |
|   | error | | | | | | `{"detail":"selection inference is disabled"}` |

**cold: no successful calls.** status codes: [409]. This is the result — the route did not produce a brief.

---

## Summary — the numbers that set the priorities

Measured on this box (32 cores, RTX 5090), branch `perf-annotate-sidecars-2026-07-27`,
2026-07-27. Raw output for every figure is above.

### The browser, all toggles on vs default

| Metric | default layers | **all toggles** | ratio |
|---|---|---|---|
| `rendersPerSec` p50 | 58 | **5** | 11.6× worse |
| `rendersPerSec` p05 | 25 | **3** | 8.3× worse |
| `frameMsEMA` p50 | 17.2 ms | **239.3 ms** | 13.9× worse |
| `longtasksPerMin` p50 | 33 | **294** | 8.9× worse |
| Cesium entities p50 | 2 432 | **60 826** | 25× |
| Cesium DataSources | 20 | **78** | 3.9× |
| JS heap p50 | 1 328 MB | **2 678 MB** (max 3 814 MB) | 2× |
| `ScriptDuration` / `TaskDuration` | 20.9 / 23.5 s | **71.5 / 73.6 s** | 89-97% of the main thread is JS |

**Verdict: POOR (p05 rendersPerSec 3.0 < 20).** The operator's "performance is very poor"
is 3-5 fps with every layer on, on a 5090.

### Measured request rate beats the computed one by 3.3×

The plan's arithmetic from layer TTLs predicted ~86 req/min. The browser actually issued
**282 req/min** over 74 s. The gap is entirely `refreshOnMove`:

| path | requests in 74 s | req/min |
|---|---|---|
| `/api/places/infrastructure` | **144** | 117 |
| `/api/adsb/global` | 46 | 37 |
| `/api/maritime/snapshot` | 19 | 15 |
| `/api/maritime/digitraffic` | 16 | 13 |
| `/api/places/{airports,ports,bases,military}` | 16 each | 13 each |
| `/api/history/coverage` | 15 | 12 |
| `/api/timeline/density` | 15 | 12 |

The nine generated `infra.*` layers share one endpoint and each fires its own
move-settle refresh, so one camera move costs nine requests to the same uncached route.
This validates the plan's §6.6 (coordinated move-settle) and §6b.1 (places cache) as the
two highest-value backend fixes, and it validates "measure, do not compute".

### The sidecars are the machine's largest cost

| Metric | p50 | p95 | max |
|---|---|---|---|
| **`cpu%` chrome (all sidecar renderers)** | **393.6 %** | **1203.6 %** | **1522.6 %** |
| `cpu%` node (both feeders) | 44.0 % | 62.5 % | 67.7 % |
| `cpu%` api (uvicorn) | 31.0 % | 81.4 % | 93.7 % |
| **`rss_mb` chrome** | **8 881 MB** | 9 129 MB | 9 178 MB |
| `rss_mb` node | 1 055 MB | 1 077 MB | 1 078 MB |
| `rss_mb` api | 578 MB | 600 MB | 635 MB |
| chrome processes | 53 | 61 | 61 |

The browser tier burns **4-15 CPU cores continuously and holds ~8.9 GB of RAM** (plus
23.3 GB of the 5090's VRAM, per `nvidia-smi` during the run) to deliver two JSON files.
The API process it feeds costs 31 % of one core. The operator's "the biggest issue is
sidecars not optimized" is correct by an order of magnitude.

Per-request sidecar cost:

| endpoint | code | p50 total | p50 size |
|---|---|---|---|
| `:8090/aircraft.json` | 200 | 8.2 ms | 2 604 272 bytes |
| `:8090/health` | 200 | 1.3 ms | 198 bytes |
| `:8093/vessels.json` | 200 | 5.2 ms | 1 985 576 bytes |
| `:8093/health` | 200 | 0.3 ms | 72 bytes |

`/aircraft.json` is re-serialized from scratch on every one of those requests, and the
backend polls it at 1 Hz.

### The expensive routes

| endpoint | total p50 | bytes | etag |
|---|---|---|---|
| `/api/aviation/states` | **1 648 ms** | 469 331 | none |
| `/api/intel/brief` | **501 ms** | 7 681 | none |
| `/api/adsb/global` (no `limit` → misses the hot blob) | **288 ms** | 749 309 | none |
| `/api/maritime/snapshot` | **270 ms** | 1 624 682 | none |
| `/api/maritime/snapshot?parked=1` | **77 ms** | 805 504 | none |
| `/api/firms` | 38 ms | 271 284 | none |
| `/api/conflict/live` | 35 ms | 97 555 | none |

**Not one route in the entire sweep returned an ETag.** Fetching every layer once costs
54.3 s of wall time and 5.0 MB.

Four endpoints 502'd during the sweep: `/api/hazards/gdacs` (after a 15.4 s wait),
`/api/maritime/warnings` (6.5 s), `/api/hazards/reliefweb`, `/api/adsb/fi/global`. The
browser logged five 502s during the all-toggles run.

`/api/status/perf` does not exist yet, so event-loop lag is **UNMEASURED** in this
baseline — the plan adds it in §6.7 and the after-run will have it.

### The model path is off, not slow

`/api/ai/local` reports `enabled: false`, `selection_enabled: false`,
`selection_model: null`, `engine: "auto"`. All three selection-brief calls returned
**HTTP 409 `selection inference is disabled`** in 1-2 ms.

`/api/ai/hardware` sees the RTX 5090 (32 607 MB VRAM) and 124 GB RAM and recommends a
120B MoE. Meanwhile `llama-server` is launched with no `-ngl`, no `--ctx-size`, no
`--threads` and no `--cache-reuse`, `.manager_state.json` has `active: {main: null,
selection: null}` and `hot: []`, and calls fall through to Ollama's smallest model.

There is no latency to report because nothing ran. That is the finding.

### Priority order this baseline dictates

1. **Sidecars** — 393 % CPU p50 / 8.9 GB, for two JSON endpoints. Largest single cost.
2. **`refreshOnMove` fan-out + uncached `/api/places/*`** — 117 req/min to one uncached route.
3. **Frontend entity/render cost** — 60 826 entities, 78 DataSources, 5 fps.
4. **`/api/maritime/snapshot`** — 270 ms and 1.6 MB, uncached, no ETag, twice.
5. **The model** — turn it on and pass the flags before measuring speed.

---

