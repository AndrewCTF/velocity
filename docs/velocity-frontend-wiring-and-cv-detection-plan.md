# Velocity → Maven-grade: frontend wiring + CV detection plan

**Date:** 2026-06-25
**Driver:** make the COP "more advanced" (Bilawal Sidhu / Maven articles). Two tracks the operator chose: **(A) wire this session's backend into the frontend**, **(B) computer-vision detections (people/vehicle outlines) using Segment Anything (SAM)**.

## Ground truth (verified this session, file:line)
- **Already built + wired** (NOT gaps): traffic cams (`routes/cams.py` + globe layer `registry/defaults.ts:539` `infra.cams.public` + `CameraCard`), weather alerts (layer `defaults.ts:79` → `/api/weather/alerts`), pathfinding (`globe/routePlanner.ts` `planRoute`→`astarGrid`, used in `cop/CopEditor.tsx:108`).
- **Built this session, backend-only (0 frontend):** entity resolution (`intel/resolve.py`, dossier `identity`), behavioral rules (`intel/detectors.py` + `watch.py` kinds ais_gap/rendezvous/loiter), tip-and-cue (`intel/cue.py`), graph analytics (`intel/graph_analytics.py` + `/api/ontology/analytics/{id}`), ACARS feed (`acars.py` + `/api/acars`, `/api/acars/geojson` ✅ this turn, tested).
- **NOT built:** CV object detection (no SAM/YOLO anywhere — grep empty).
- **Sacred (CLAUDE.md):** `globe/adapters/styles.ts` — `aircraftStyle`/`vesselStyle` MUST keep their SVG icons; new layers add **additive** style cases (like cams at `styles.ts:354`), never rewrite the aircraft/vessel dispatch.
- **Gates:** `pnpm -r typecheck` green + `pytest -q` ≥25 at every commit boundary; live claims need Playwright @1920 + screenshot (anti-hallucination standard).

---

## Track A — wire the backend into the frontend

### A1. ACARS globe layer
- [x] Backend `/api/acars/geojson` → FeatureCollection of positioned messages (this turn, `to_geojson` + test).
- [ ] Registry layer `feed.acars` in `registry/defaults.ts`, mirroring `infra.cams.public`: `kind:'geojson'`, `auth:'none'`, `endpoint:'/api/acars/geojson'`, `refresh:{mode:'pull', ttlSec:15}`, `crs:'EPSG:4326'`, `visibleByDefault:false`, `emits:['acars']`.
- [ ] `styles.ts`: add an **additive** `acars` marker case (neutral amber datalink glyph; do NOT touch aircraft/vessel dispatch). Label = tail→flight.
- [ ] Render-proof: boot uvicorn + vite, Playwright → toggle `feed.acars`, screenshot markers (or honest "0 positioned this window" — positions are intermittent).
- Note: ACARS position is sparse; the layer is bonus. The richer surface is a **panel** (recent messages keyed by tail/flight) — A1b, optional.

### A2. Entity-resolution identity card
- `dossier.vessel_dossier` already returns `identity{canonical_id, aliases, mmsi_history, imo}`. Add an "Also known as" card to `entity-panel/IntelPanel.tsx` (or EntityPanel) reading `doss.identity` — shows MMSI history + IMO. Pure read, no new endpoint.

### A3. Graph-analytics panel
- Call `GET /api/ontology/analytics/{id}?depth=2` from the EntityPanel connections area; render `key_nodes` (betweenness/degree ranking) + `community_count`. Surfaces "who's central" next to the existing search-around graph.

### A4. New alert-rule kinds in the UI
- Add `ais_gap`, `rendezvous`, `loiter` to the rule-creation kind selector (`alerts/AlertsPanel.tsx`); backend KINDS already accept them (`routes/alert_rules.py`).

**Track A gate:** `pnpm -r typecheck` green; Playwright screenshot per surface.

---

## Track B — CV detection layer (Segment Anything)

The Maven "left-click → detection" centerpiece, civilian/local. Heavy: model + GPU + geo-referencing. Multi-turn.

### B1. Model + env
- SAM / SAM2 local on the RTX 5090 via `apps/ml` (mirror the `.mamba-cuda` gsplat env pattern — see memory `velocity-local-recon-studio`). SAM outputs **masks/outlines**, not class labels.
- **Labeling gap (honest):** SAM segments but does not name. For "person/vehicle/ship" labels, pair with a classifier (CLIP zero-shot on each mask crop) or run YOLO for labeled boxes and SAM for precise outlines. Decide at B2.

### B2. Inference route
- `POST /api/cv/detect {bbox|aoi, date}` → `imagery.ondemand` fetches the tile (Maxar Open Data / Sentinel — already built) → SAM auto-mask (or prompted) → optional CLIP/YOLO labels → list of detections.

### B3. Geo-reference (the math that must be tested)
- Map mask pixel coords → lon/lat using the tile bbox (reuse `sar_vessels._pixel_lonlat` pattern). Emit GeoJSON polygons (outlines) + centroids, each with a **stable detection id**.
- `test_cv_georef.py`: known bbox+pixel → expected lon/lat (the one runnable check).

### B4. Frontend render
- New globe adapter/layer for detection outlines + labels; stable ids so re-runs upsert (not churn) — same upsert discipline as `PollGeoJsonAdapter`.

### B5. Stable cross-feed ID (Maven "same ID across modalities")
- Assign + persist detection ids; later match a detection across imagery dates / against ADS-B/AIS by position. Advanced; after B1–B4.

**Track B gate:** detect on a fixed AOI image → outlines returned + rendered (screenshot); georef unit test green.

---

## Recommended order
1. **A2 + A3 + A4** — cheap, pure-frontend reads of already-proven endpoints; immediate "advanced" wins, low risk.
2. **A1** — ACARS layer (needs the additive styles.ts case + render-proof boot).
3. **B (SAM)** — the big one; B1→B4 over multiple turns, render-proven on a known AOI.

## Out of scope / honest limits
- ACARS positions are intermittent (one live batch = 0 positioned) — the layer is sparse; the panel is the reliable surface.
- SAM needs the GPU env stood up (model weights download); not a one-turn job.
- WAMI/Gorgon-Stare-style persistent wide-area imagery is not available open-source at that resolution; civilian analog = periodic on-demand tiles, not live gigapixel.
