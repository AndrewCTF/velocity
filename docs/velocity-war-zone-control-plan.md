# War-zone territorial-control layer — implementation spec

## Context

The globe shows conflict as point events (GDELT via `AreaAdapter` / `conflict.py`), but
not *territory*: who controls what, where the front line runs, contested ground. That is
the biggest gap vs Palantir Gotham's COP. Operator wants filled controlled areas with 45°
hatch stripes, front lines as solid (confirmed) / dotted (contested) polylines, faction
colors, labels, and current conditions.

Decisions (this session): data = **draw + import GeoJSON** (start from a real snapshot,
refine by hand — there is NO clean keyless global front-line feed, so we do not fake a
live one); placement = **extend the Situations panel** (`SituationsPanel`, the live rail
tab, App.tsx:168).

## Reuse (verified file:line)

- Persistence pattern: `annotations/annotationStore.ts` — zustand store + save/load to
  `/api/ontology/object/{id}` under a workspace id. The generic ontology object store
  already accepts an arbitrary id (`annotations:workspace`), so `control:workspace` needs
  **zero backend change**.
- Render pattern: `globe/AnnotationLayer.ts` (`installAnnotations`, mounted GlobeCanvas.tsx:593)
  — a `CustomDataSource` rebuilt on store change. Full-rebuild is fine here: this is a
  small hand-drawn set, NOT the guarded live-entity upsert path.
- Draw toolbox: `globe/draw.ts` — `getDrawController()` → `drawPolygon(onDone)` (draw.ts:246),
  `drawPolyline(onDone)`. Same calls the AnnotationPanel uses.
- Dashed lines: `Cesium.PolylineDashMaterialProperty` (already used draw.ts:127,
  ProjectionLayer.ts:62). Filled polygon: `PollGeoJsonAdapter.ts:1389` pattern
  (`PolygonHierarchy` + material + `classificationType: TERRAIN`).
- UI instruments: `shell/instruments.js` (Widget/Btn/SectionLabel/MicroLabel), `CoordEntry`.

## Build new (isolated, touches no guarded path)

### 1. `apps/web/src/state/controlStore.ts` (or `situations/controlStore.ts`)
Mirror annotationStore. Types:
- `Faction { id; name; color }` — default set (Blue `#38bdf8`, Red `#ef4444`, plus operator-added).
- `ControlZone { id; factionId; status: 'controlled'|'contested'; label?; conditions?; ring: [lon,lat][]; asOf? }`
- `FrontLine { id; label?; status: 'confirmed'|'contested'; coords: [lon,lat][] }`
- store `{ factions, zones, lines, add*/update*/remove*/clear/replaceAll }`
- `saveControl()/loadControl()` → object id `control:workspace`.
- `importGeoJSON(text): { zones, lines, errors }` — FeatureCollection: Polygon/MultiPolygon
  → zones (faction from `properties.faction|side|name`, status from `properties.status`),
  LineString/MultiLineString → front lines. Lenient; unmatched props default sensibly.

### 2. `apps/web/src/globe/hatch.ts`
`hatchMaterial(cssColor, dense=false): Cesium.ImageMaterialProperty` — Cesium has NO 45°
stripe material, so draw a small canvas (e.g. 12×12) with diagonal stripes in the color
over transparent, return `new Cesium.ImageMaterialProperty({ image: canvas, repeat, transparent: true })`.
Cache by `color|dense`. `contested` uses denser stripes. <!-- ponytail: canvas texture, no
GLSL shader, no dep. -->

### 3. `apps/web/src/globe/ControlLayer.ts`
`installControl(viewer)` mirroring `installAnnotations`. `CustomDataSource '__control'`:
- Zone → polygon: `hierarchy` from ring, `material: hatchMaterial(faction.color, status==='contested')`,
  `outline`, `outlineColor` faction color, `classificationType: TERRAIN`; centroid label
  (faction name + label + conditions).
- Front line → polyline: confirmed = solid (faction-neutral white/outline, width 4);
  contested = `PolylineDashMaterialProperty`; `clampToGround`, geodesic; mid-point label.
- Rebuild on `useControl.subscribe`. Mount in GlobeCanvas.tsx next to `installAnnotations`.

### 4. `apps/web/src/situations/ControlSection.tsx`
Mounted in `SituationsPanel`. Widget "Territorial control": faction picker (+ add faction
color), status toggle (controlled/contested · confirmed/contested), label + conditions
inputs, Draw zone / Draw line buttons (via `getDrawController`), Import GeoJSON (textarea
paste + file input), zone/line list with edit/remove, faction legend, Save / Clear.

## Verification

1. `apps/web` vitest: `controlStore.importGeoJSON` parses a small FeatureCollection → N
   zones + M lines; `hatch.ts` returns a material from a non-empty canvas (assert canvas
   width>0 / toDataURL non-empty). Mirror `annotationStore.test.ts`.
2. `pnpm -r typecheck` green.
3. Live (`bash scripts/run-api.sh` + vite): draw a zone → 45° hatched fill in faction color;
   draw a contested front line → dashed; import a small GeoJSON → zones appear; Save then
   reload → persists (or "sign in to persist" when logged out, like annotations).

## Honest scope note

No live territorial-control feed exists keyless/global — this ships operator-authored +
importable control, which is real data the operator supplies, not an invented front line.
A future connector (e.g. a curated regional GeoJSON) can populate the same store.
