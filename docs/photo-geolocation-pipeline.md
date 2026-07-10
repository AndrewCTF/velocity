# Photo Geolocation Pipeline (`geolocate/`) — architecture & spec

**Status:** design (2026-07-10). Builder agents implement against THIS doc.
**Goal:** given one or more ground-level photos, estimate where on Earth they were taken —
country → region → ≤1 km AOI → (where geometry permits) a metric camera pose — with an
evidence-backed, calibrated confidence at every level. Generic: no per-country hardcoding.

The requested "VHR-satellite → Gaussian-splatting → geolocate" is **one branch** of this system
(Stage D, precise pose). It is powerful but data- and scene-limited (see §Honest limits), so the
pipeline is built as a **funnel of complementary engines** that each narrow the search, with the
splat branch reserved for the cases where it can actually bite.

---

## 0. Honest limits (read first — these shaped every design choice)

1. **Free global VHR-with-RPC does not exist.** Building a Gaussian splat of an arbitrary place
   needs multiple off-nadir views + camera models (RPC). Free global imagery is Sentinel-2 (10 m —
   cannot resolve a house) / Landsat (30 m). Free VHR *basemaps* (Esri/Google/Bing/Mapbox) are
   single-view mosaics, no RPC, ToS-restricted for 3D derivation. True free stereo+RPC exists only
   for benchmark AOIs (IARPA MVS3DM, DFC2019, CORE3D — already in `apps/ml/fusion/.sat_data/`).
   → The pipeline **degrades gracefully**: cross-view retrieval + 2.5D DSM everywhere; full 3DGS
   pose only where stereo+RPC is available (benchmark AOIs now; commercial opt-in / SkySat later).

2. **Nadir satellite cannot see under a forest canopy.** A splat built from near-nadir VHR captures
   canopy tops; an under-canopy ground photo sees trunks, boulders, a barn wall. ~Zero shared
   visible geometry → Stage D **cannot** localise woodland-interior shots. It bites on open features
   (facades, yards, roads, field edges, roof geometry). This is a property of the physics, not an
   implementation gap — the pipeline routes canopy shots to Stages A–C and says so.

3. **Cross-view retrieval models are trained on urban/road panoramas** (CVUSA/CVACT/VIGOR/
   University-1652). Rural-forest queries are out-of-distribution; retrieval is a *ranker of
   candidates*, never a sole oracle. Always fused with scene priors + human-readable evidence.

Every claim the pipeline emits is tagged `proven` / `plumbed-unverified` / `heuristic` and carries
a calibrated probability. Being honestly uncertain beats a confident wrong pin.

---

## 1. Pipeline shape (funnel)

```
photos ─► A. Forensics & scene understanding ─► evidence.json (per photo + fused)
                                              │
        B. Geo-prior fusion ◄─────────────────┘   → P(region) distribution + rationale
                │
        C. Candidate retrieval (within prior)                → ranked AOIs (lat/lon + score)
           C1 cross-view embedding (Sample4Geo) over VHR tiles
           C2 OSM/Overpass structured feature match (keyless, live)
           C3 terrain / skyline / DEM match (when horizon visible)
                │
        D. Precise pose (only for AOIs with usable geometry)  → camera pose + reproj error
           D1 VHR-stereo → 3DGS/DSM (rpc_stereo / EOGS) then render-and-compare + PnP
           D2 fallback: 2.5D DSM silhouette / shadow-length + sun-azimuth check
                │
        E. Verification, confidence, report                  → geo_assessment.md + geojson
```

Router: after A, a scene-type classifier (open / semi-open / canopy-interior / indoor) decides
whether C1/C3 and D are attempted or skipped-with-reason. No silent skips — every skip is logged.

---

## 2. Stage specs

### A. Forensics & scene understanding  (Sonnet build; runs per photo)
- **EXIF/XMP**: GPS, timestamp, camera make/model, orientation, lens focal → if GPS present, short-
  circuit to Stage E with `proven` tag. (Test set: stripped, none.)
- **Scene caption + attributes** via a VLM (see §3 model choices): free-text + structured slots:
  biome, land-use, architecture style + material + colour, roof type, road surface, signage/text,
  vehicles, vegetation species guess, animal/husbandry cues, weather/season, terrain slope,
  sky/canopy openness.
- **OCR** (any text: signs, plates, shop fronts) → language ID + token extraction (huge geo signal).
- **Sun/shadow cue**: detect shadow direction + estimated solar elevation; with a timestamp this
  bounds latitude/orientation. (No timestamp here → weak prior only.)
- **Perceptual hash + near-dup grouping** so a burst of one place isn't over-counted.
- Emits `evidence/{photo}.json` (schema in §4) — the ONLY contract downstream stages consume.

### B. Geo-prior fusion  (Sonnet build)
- Turn A's cues into a probability distribution over regions. Two fusers, combined:
  - **Rule/knowledge fuser**: curated cue→region weights (architecture material, driving side,
    plate format, language, vegetation zone, utility-pole style, road markings). Data-driven, in a
    YAML knowledge base — *generic*, extensible, no country hardcoded in code paths.
  - **VLM geo-estimator**: ask the VLM directly "top-5 countries/regions + why + confidence" and
    calibrate/blend with the rule fuser (weighted log-opinion pool).
- Output: ranked regions with rationale + the bounding boxes to hand Stage C. Explicitly represents
  uncertainty (may return several regions).

### C. Candidate retrieval  (C2 Sonnet keyless-live; C1/C3 Opus)
- **C1 cross-view embedding** — `Sample4Geo` (Skyy93/Sample4Geo, ConvNeXt + symmetric InfoNCE,
  released weights). Embed the ground photo; embed a grid of VHR reference tiles covering the prior
  bbox (basemap tiles are fine — retrieval needs appearance, not RPC); rank by cosine. Returns
  top-K AOI centres + scores. Honest OOD caveat surfaced in the score.
- **C2 OSM/Overpass structured match** — translate A's discrete features into Overpass queries
  within the prior bbox (e.g. `building` + roof colour proxy, `landuse=forest` adjacency to
  `landuse=meadow`/`pasture`, `leisure`/`tourism` timber structures, farm/smallholding tags). Score
  candidates by how many independent features co-occur within ~1 km. **Keyless, live, works today.**
- **C3 terrain/skyline** — when a horizon/ridgeline or distinctive slope is visible, match against a
  DEM (Copernicus GLO-30, free) skyline profile within the prior. Rangeland/hill shots only.
- Fuse C1–C3 → ranked AOI list (lat/lon, radius, fused score, contributing evidence).

### D. Precise pose — the "VHR→3DGS→geolocate" branch  (Opus build)
- **D1 (full 3DGS)**: for an AOI with stereo+RPC coverage, build the scene once:
  reuse `apps/ml/fusion/recon/rpc_stereo.py` (proven plane-sweep DSM, 2.79 m RMSE) and/or wire
  **EOGS/EOGS++** (mezzelfo.github.io/EOGS, native RPC 3DGS) → a `.ply` splat + DSM. Then estimate
  the ground photo's 6-DoF pose by **render-and-compare**: differentiable-render the splat from
  candidate poses, optimise photometric + edge alignment; seed with PnP from any 2D–3D feature
  correspondences (building corners, road junctions). Output pose + reprojection error + a rendered
  overlay. Reuse `pt_to_ply.py`, the recon venv env (`_cuda_env`), and the `POST /api/recon/sat`
  job scaffold.
- **D2 (fallback, no stereo)**: single-view VHR + Copernicus DSM → extract building footprint /
  roof-ridge / field-edge polygons, match the photo's silhouette + shadow length (sun-azimuth from
  date/time) to pin position and heading without a full splat. Cheaper, works far more often.
- Router only invokes D when Stage A tagged the scene "open/semi-open" AND an AOI survived C.

### E. Verification, confidence & report  (Sonnet build)
- Consistency checks across photos (do all AOIs fall within one ~1 km disk, as claimed?).
- Calibrated final confidence per level (country/region/AOI/pose) from the fused evidence.
- Emits `geo_assessment.md` (human report: verdict → evidence → limits) + `result.geojson`
  (points/AOIs for the globe) + optional writeback to the intel ontology as an
  `Observation`→`Place` assertion (reuse `intel/ontology_local.py get_registry().upsert`).

---

## 3. Model / data choices (concrete, mostly keyless)

| Need | Choice | Why / where |
|---|---|---|
| VLM caption + geo-estimate | local reasoner (ollama) or hosted per repo config | reuse local-inference toggle; keyless local path |
| OCR | tesseract / easyocr | keyless |
| Object/veg detection | existing CUDA YOLO sidecar (`~/.venv`, RTX 5090) | reuse; do NOT use apps/api/.venv for torch |
| Cross-view embedding | Sample4Geo (released weights) | ground↔aerial retrieval |
| VHR reference tiles | Esri/Bing basemap tiles (retrieval only) + CDSE Sentinel Hub (owned creds) | appearance ranking; NOT for 3D redistribution |
| Stereo+RPC 3D | repo `rpc_stereo.py` + EOGS/EOGS++; OpenSplat fallback | proven 2.79 m RMSE in-repo |
| DEM | Copernicus GLO-30 (free) | terrain/skyline + D2 shadow |
| Structured features | OSM Overpass (keyless, live) | C2 — the workhorse for rural |
| Reverse-image (optional) | operator-supplied; not assumed | ethics/ToS gate |

---

## 4. Contracts (stable interfaces so stages parallelise)

`evidence/{photo}.json`:
```json
{ "photo": "...", "phash": "...", "exif": {"gps": null, "ts": null, "camera": null},
  "scene_type": "canopy_interior|open|semi_open|indoor",
  "caption": "...", "attributes": {"biome":"...","architecture":{...},"vegetation":[...],
     "husbandry":[...],"signage_text":[...],"language":null,"driving_side":null,
     "sun":{"shadow_az_deg":null,"solar_elev_deg":null},"terrain_slope":"..."},
  "confidence_notes": "..." }
```
`geo_prior.json`: `[{ "region":"...", "bbox":[w,s,e,n], "p":0.0, "rationale":"..." }]`
`candidates.json`: `[{ "lat":0,"lon":0,"radius_m":0,"score":0,"sources":["C2:..."],"evidence":"..." }]`
`result.geojson` + `geo_assessment.md`.

Each stage reads/writes only these files → agents own separate modules, no shared-file contention.

---

## 5. Repo integration & layout

New package: `apps/ml/geolocate/` (sibling of `apps/ml/fusion`).
```
geolocate/
  __init__.py
  contracts.py        # dataclasses / JSON schema for §4
  forensics.py        # Stage A
  geoprior.py         # Stage B  (+ knowledge/*.yaml cue→region KB)
  retrieval/
    crossview.py      # C1 (Sample4Geo wrapper)
    osm.py            # C2 (Overpass, keyless, live)
    terrain.py        # C3 (Copernicus DEM skyline)
  pose/
    splat_pose.py     # D1 (reuse fusion/recon rpc_stereo + EOGS; render-and-compare)
    dsm_fallback.py   # D2
  report.py           # Stage E
  pipeline.py         # orchestrator + router + CLI  (python -m geolocate.pipeline <imgs> -o out/)
  knowledge/*.yaml
  tests/              # pytest; live-gated tests marked, keyless ones always run
```
- CLI first (so it runs headless/CI). Optional thin `POST /api/geolocate` later, mirroring
  `recon.py` job scaffold. Do not block the CLI on the route.
- Tests run from repo ROOT: `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/ml/geolocate -q`.
  Keyless stages (A heuristics, B rules, C2 OSM with a recorded fixture, E) must pass offline;
  model/live stages gated behind an env flag like the existing `OSINT_LIVE_PROBE`.
- Respect repo invariants: torch/GPU work in the CUDA sidecar venv, NOT apps/api/.venv; rasterio in
  apps/api/.venv; hand off between venvs via npz/json. Keyless-by-default.

---

## 6. Build order (agent tiers)

1. **Skeleton + contracts + Stage A forensics + orchestrator/CLI stub + tests** — Sonnet.
2. **Stage B geo-prior (rules KB + VLM blend)** and **Stage C2 OSM retrieval (live)** — Sonnet, parallel, separate files.
3. **Stage D splat-pose (D1 render-and-compare + D2 fallback), Stage C1 cross-view** — Opus (hardest).
4. **Stage E report + confidence + ontology writeback**, wire router — Sonnet.
5. **Run on `test_images/`**, produce `geo_assessment.md` — Sonnet.
6. **Adversarial review** of the whole thing + the geolocation conclusion — Opus.

Success = keyless stages proven-live (forensics on the 6 photos, an OSM query returning real
candidates, orchestrator emitting a report), and an honest geo-assessment with calibrated
confidence. The splat branch is delivered runnable + tested on a benchmark AOI; it is NOT expected
to resolve the canopy test photos (§0.2) and the report says so.
```
