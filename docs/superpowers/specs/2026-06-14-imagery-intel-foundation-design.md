# Spec A — Satellite imagery foundation + SAR dark-vessel + damage assessment

- Date: 2026-06-14
- Status: draft (awaiting review)
- Combines original Spec 1 (imagery layers), Spec 2 (SAR dark-vessel), Spec 3 (damage assessment).
- Downstream specs that depend on this: Spec 4 (reconstruction model), Spec 5 (Skyfall-GS 3D).

## 1. Context

Existing stack (verified in repo):
- Cesium 3D globe (`apps/web/src/globe/GlobeCanvas.tsx`) + MapLibre 2D fallback.
- Tile proxy: `apps/api/app/routes/tiles.py` + `apps/api/app/tilecache.py` (basemap proxy, keyless).
- FIRMS thermal points (VIIRS/MODIS fire) `apps/api/app/routes/firms.py`.
- AIS observation store + dark-vessel heuristic (AIS-gap based, NOT imagery): `apps/web/src/intel/darkVessel.ts`, `apps/api/app/correlate/store.py`.
- Text LLM only: `apps/api/app/llm.py` (DeepSeek/Ollama, no vision).
- Layer registry: `apps/web/src/registry/defaults.ts`.

No raster satellite imagery layers exist yet (only basemap + point overlays). This spec adds the raster imagery layer and two ML/analytics consumers of it.

## 2. Goals

1. Render many satellite imagery sources as time-aware raster layers on the globe.
2. Detect non-transmitting ("dark") vessels in the Strait of Hormuz from Sentinel-1 SAR cross-referenced with AIS.
3. Assess bomb/strike damage for an AOI from before/after imagery, day-by-day, with a vision-capable LLM.

Non-goals here: imagery reconstruction model (Spec 4), 3D reconstruction (Spec 5), trained-from-scratch detectors (baseline CFAR/Siamese only; trained upgrades are follow-ups).

---

## 3. Subsystem 1 — Multi-source imagery layers

### 3.1 Providers

| Source | Sensor | Resolution / cadence | Access | Key? |
|---|---|---|---|---|
| NASA GIBS | MODIS Terra/Aqua, VIIRS SNPP/NOAA-20/21, Landsat, thermal | 250 m–1 km, daily (+~3 h NRT via LANCE) | WMTS/WMS, date-templated (`TIME`) | **No key** |
| AWS Open Data | GOES-19 (East), Himawari-9 | ~2 km, ~10 min | public S3 (`s3://noaa-goes19`, `s3://noaa-himawari`) | No key (anon S3) |
| NOAA GMGSI | geostationary global mosaic | ~global, hourly | public S3 | No key |
| Copernicus Data Space / Sentinel Hub | Sentinel-2 (10 m optical), Sentinel-1 (C-band SAR) | 5–12 day | OGC WMTS + Process API (OAuth) | **Yes** |
| USGS / AWS | Landsat 8/9 | 30 m, 16 day | also in GIBS; M2M/EarthExplorer or AWS | optional |
| ASF DAAC | NISAR (L-band SAR) | live since Feb 2026, 36–72 h latency | Vertex / Earthdata + OPERA tiles | **Yes (Earthdata)** |

Keyless tier (GIBS + AWS geostationary) ships first and alone supports day-by-day scrubbing. Keyed tier (CDSE/Sentinel Hub + NISAR/Earthdata) adds 10 m optical and SAR.

### 3.2 Backend

Generalise the tile proxy into a multi-provider, date-aware imagery proxy.

- New module `apps/api/app/routes/imagery.py`:
  - `GET /api/imagery/{provider}/{layer}/{z}/{x}/{y}?date=YYYY-MM-DD` → proxied/cached PNG/JPEG tile.
  - `GET /api/imagery/catalog` → JSON of providers, layers, supported date ranges, attribution, auth status.
- Provider adapters under `apps/api/app/imagery/` (one file per provider family): `gibs.py`, `geostationary.py` (AWS GOES/Himawari → tiled), `sentinelhub.py` (OAuth token cache + WMTS/Process), `nisar.py`.
- Reuse `tilecache.py` TTL cache. TTLs: GIBS daily layer 6 h; geostationary 5 min; Sentinel Hub 1 h; catalog 12 h.
- Sentinel Hub OAuth: client-credentials token cached in-process, refreshed on 401 (mirror the OpenSky token-manager pattern). Degrade gracefully (layer marked `auth: missing`) when creds absent — keyless layers must still work.

### 3.3 Frontend

- Register raster layers in `defaults.ts` (`kind: 'raster'`, `endpoint: /api/imagery/...`, `time: { temporal: true }`).
- Cesium: `Cesium.UrlTemplateImageryProvider` per active layer, draped on the globe; opacity slider; one active base + optional overlay.
- Global **time slider** component (`apps/web/src/timeline/`) drives the `date` param; stepping the day re-templates the tile URL. Reuse existing Timeline if present.
- Layer rail groups imagery under "Satellite imagery" with per-source toggles + attribution.

---

## 4. Subsystem 2 — SAR dark-vessel detection (Hormuz)

### 4.1 Pipeline

1. **Fetch**: latest Sentinel-1 GRD (VV/VH) scene over the Hormuz AOI via Sentinel Hub Process API (or NISAR L-band when over the AOI). AOI bbox configurable; default Strait of Hormuz.
2. **Preprocess**: land mask (coastline shapefile / OSM water), speckle filter, calibrate to σ0.
3. **Detect**: **CFAR** (cell-averaging, adaptive threshold over sea clutter) → candidate bright spots → morphology + size/aspect filter → vessel candidates with lat/lon, length estimate. Optional CNN upgrade later (ref **xView3-SAR**).
4. **Correlate**: match each SAR detection to the AIS observation store (`store.py`) within a time/space window. Detection with **no AIS match = dark vessel candidate**.
5. **Emit**: GeoJSON points, `kind: vessel`, `darkCandidate: true`, into the existing dark-vessel intel UI (`darkVessel.ts`, `IntelPanel.tsx`). Diamond marker `#ef4444` per CLAUDE.md.

### 4.2 Backend

- `apps/api/app/intel/sar_vessels.py`: pipeline above.
- `GET /api/intel/dark-vessels/sar?aoi=hormuz&date=...` → GeoJSON of SAR-vs-AIS mismatches.
- Scheduled refresh on new S1 pass over AOI (S1 revisit ~6–12 day; run on demand + cache).

---

## 5. Subsystem 3 — Damage assessment (vision LLM)

### 5.1 Pipeline

1. **Inputs**: AOI bbox + two dates (before, after). Optional date range → day-by-day timeline.
2. **Fetch tiles**: Sentinel-2 optical for both dates; Sentinel-1 SAR fallback when post-event optical is cloudy (ref **BRIGHT**: pre optical + post SAR).
3. **Change baseline**: **Siamese U-Net** (xBD/xView2 weights) → per-building 4-class damage (none/minor/major/destroyed) + change mask. Runs on GPU; CPU-fallback = skip, LLM-only.
4. **Vision-LLM reasoning**: feed before/after tiles (+ change mask) to a **vision-capable LLM** → structured report: damaged-structure count, severity, confidence, notable changes, caveats. Day-by-day = one call per step, assembled into a timeline.
5. **Output**: report JSON + overlay (damage heat polygons) + timeline.

### 5.2 Backend

- Add a **vision client** to `llm.py` (currently text-only): `analyze_images(prompt, images[]) -> LlmResult`. Provider = vision-capable model (Anthropic Claude vision via API key, or local VLM). Config-gated; degrade to baseline-only when no vision key.
- `apps/api/app/intel/damage.py`: orchestrates fetch → baseline → VLM.
- `GET /api/intel/damage?aoi=...&before=...&after=...` and `?from=...&to=...` (timeline).
- Frontend: AOI picker + date pair/range, damage overlay layer, report panel with day-by-day scrubber.

---

## 6. Shared data model

- `AOI`: `{ id, name, bbox|polygon }`. Seed: `hormuz`, `gaza`, `south-lebanon`, `kyiv-oblast`, etc. Stored `apps/api/app/intel/aois.py`.
- `ImageryRef`: `{ provider, layer, date, bbox }` — the contract Specs 4/5 also consume.
- All new endpoints behind existing `apiFetch`/auth wrappers (CLAUDE.md).

---

## 7. Testing method

**Subsystem 1 (imagery):**
- Unit: provider adapters build correct upstream URLs for a given `(layer, date, z/x/y)` — table-driven, no network (assert URL strings). GIBS date templating, Sentinel Hub WMTS params, S3 key derivation for GOES/Himawari.
- Unit: OAuth token cache refreshes on simulated 401; keyless layers resolve with no creds.
- Integration (network, marked `@pytest.mark.net`, skipped in CI default): fetch one live GIBS tile (200, image content-type, non-empty) and one Sentinel Hub tile when creds present.
- Frontend: registry test that imagery layers parse; Cesium provider constructed with templated URL incl. `date`.

**Subsystem 2 (SAR dark-vessel):**
- Unit: CFAR on a synthetic SAR chip (injected bright targets on modeled clutter) detects the known targets, rejects pure clutter (precision/recall on fixture).
- Unit: AIS correlation — fixture of SAR detections + AIS tracks → asserts correct dark/lit classification within the window.
- Integration: one cached real S1 Hormuz scene (committed as a small fixture or fetched under `@pytest.mark.net`) → end-to-end produces ≥1 detection; output schema valid GeoJSON.

**Subsystem 3 (damage):**
- Unit: Siamese baseline on an xBD sample pair → damage classes within tolerance of golden (small fixture pair committed).
- Unit: VLM client mocked → orchestration assembles report JSON + timeline shape correctly; degrade path (no vision key) returns baseline-only without error.
- Integration: known event (e.g. a public xBD disaster pair) → report lists destroyed buildings > 0; day-by-day over N dates returns N steps.

Repo bars hold: `pnpm -r typecheck` green, `cd apps/api && .venv/bin/pytest -q` ≥ current count, ruff clean.

## 8. Verification — "done when"

**Subsystem 1:**
- [ ] Globe shows a MODIS/VIIRS true-color layer; moving the time slider one day changes the imagery (visible diff), no key set.
- [ ] GOES-19 or Himawari-9 layer renders and updates within its cadence.
- [ ] With CDSE creds set, a Sentinel-2 10 m layer renders for a chosen date; with creds removed it degrades (layer flagged, app still works).
- [ ] `/api/imagery/catalog` lists every provider with correct date ranges + auth status.

**Subsystem 2:**
- [ ] For a Hormuz S1 scene with a staged AIS gap, the pipeline flags the un-broadcast contact as a dark-vessel candidate (red diamond) and it appears in the intel panel.
- [ ] A contact with matching AIS is NOT flagged.

**Subsystem 3:**
- [ ] For a before/after pair over a known struck AOI, the report returns a non-zero destroyed/major count with an overlay, and a day-by-day range returns one entry per day.
- [ ] With no vision key, the baseline-only path still returns a change map (no crash).

## 9. Keys / config (new settings)

- `sentinelhub_client_id`, `sentinelhub_client_secret` (CDSE OAuth).
- `earthdata_token` (ASF/NISAR, LANCE NRT).
- `vision_llm_provider`, `vision_llm_key`, `vision_llm_model`.
- `imagery_default_aoi`, `dark_vessel_aoi_bbox`.
All optional; absence degrades the relevant layer/feature, never breaks keyless paths (CLAUDE.md guardrail).

## 10. Risks / phasing

- Phase 1: keyless imagery (GIBS + geostationary) + time slider. Ships fast, no signups.
- Phase 2: CDSE/Sentinel Hub S1/S2 + NISAR (needs accounts).
- Phase 3: SAR dark-vessel (needs S1 from phase 2).
- Phase 4: damage assessment (needs S1/S2 + vision key).
- Sentinel Hub free tier has a processing-unit quota — cache aggressively; pre-render AOI tiles.
- VLM cost/latency — cap calls per request, cache by `(aoi, date-pair)`.
