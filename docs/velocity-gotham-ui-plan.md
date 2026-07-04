# Velocity → Gotham-class UI: build plan

Plan to bring four Palantir-Gotham capabilities into Velocity, grounded in the
actual codebase (recon 2026-06-21). Scope chosen by operator: **all four** —
Satellite Tasking, Target Lifecycle Kanban, Gotham visual reskin, FMV+onboard-AI.

Honesty notes up front (per repo rules — no "global/complete" without a count):
- **Velocity already has a Gotham-ready substrate** (ink palette, IBM Plex Mono
  IDs, MIL-STD-ish SVG icons, instrument primitives, dark COP globe). Three of
  the four pillars are *additive*, not rebuilds.
- **FMV+onboard-AI is the weak pillar for an OSINT tool**: there is no real video
  feed and no on-board CV model. It can only be an honest *mock* driven by the
  existing sim drones. Sized and flagged as such.
- **Satellite Tasking is the strongest** and is the recommended first build: the
  SGP4 math and TLE source already exist; the look-angle function needed for the
  sky-view (`ecfToLookAngles`) is already in the bundled `satellite.js`, unused.

## Recommended sequencing

| Phase | Pillar | Why this order | Rough size |
|---|---|---|---|
| 1 | **Satellite Tasking** | Highest capability-per-effort; reuses existing SGP4+TLE; Gotham's lead pillar; pure client math, no new data dependency | M |
| 2 | **Visual reskin** (classification + layer-tree + status bar) | Cheap, additive, makes every other pillar read as "Gotham"; no new deps | S |
| 3 | **Target Lifecycle Kanban** | Self-contained; needs a Supabase table + route (follows `alert_rules.py`) | M |
| 4 | **FMV + onboard-AI mock** | Most speculative; gated on honest "notional" framing; reuses sim drones + `followEntity` | M (mock) |

Each phase ships independently behind its own tab/toggle. Stop after any phase.

---

## Shared foundations (already exist — do NOT rebuild)

From recon, reuse these verbatim:

- **Panel mount**: `apps/web/src/App.tsx` `rightTabs: TabDef[]` → add one tab per
  pillar; `shell/TabbedPanel.tsx` keeps all tabs mounted (state preserved).
- **Instrument primitives**: `shell/instruments.tsx` — `Widget`, `SectionLabel`,
  `KV`/`KVRow`, `Badge`, `Btn`, `MeterBar`, `StatusDot`, `Toggle`, `Hero`. Use
  these; do not invent new chrome.
- **Design tokens**: `theme/tokens.css` + `tailwind.config.js` — `bg-0..4`,
  `border-line/line-2`, `txt-0..4`, `accent #4d8dff`, `warn`, `alert`, `ok`,
  `mag #e25bef`, `font-mono` (IBM Plex Mono), radii 3/5/8px.
- **AOI**: `state/aoi.ts` (`useAoi`, Chokepoint) + `command-bar/AoiSelector.tsx`;
  range-ring drawing precedent in sim (`DefenseSite` rings).
- **Selection**: `useSelection` (`state/stores.ts`), entity ids
  `aircraft:ICAO24` / `vessel:MMSI` / `sim:scenario:idx`.
- **Persistence**: `apps/api/app/routes/alert_rules.py` + `site/supabase-schema.sql`
  — the per-user Supabase + RLS pattern to copy for any saved state.
- **Camera**: `globe/camera.ts` `followEntity()/stopFollow()` (toggles
  `requestRenderMode`); `flyToPosition()`.

**Guardrails that bind every pillar** (CLAUDE.md): aircraft/vessel SVG icons +
label style immutable; aircraft TELEPORT (no synthesis), vessels glide; sim
drones MAY glide (not ADS-B); `requestRenderMode:true` + `maximumRenderTimeChange:0`;
satellites `FORMAT=tle` + client-side SGP4 + per-frame chunking; selection
polyline `#d946ef`. `pnpm -r typecheck` + `pytest -q` green at every commit.

---

## Pillar 1 — Satellite Tasking / Collection Planner  ★ build first

**Gotham reference** (`GothamCard02`): pick AOI + mission time window + sensor
type (MSI/SAR/RF) → "Simulation Results": coverage %, average revisit, pass
count; a **Sky-View** grid of 5-min polar (az/el) coverage plots; a **Flyovers**
schedule (ICEYE-X6, BRO-2, HAWK-6A…); per-satellite az/el sky plot + tasking
requests; night globe with ground-tracks + timeline scrubber.

**What to build**: a "Tasking" right-tab where the operator sets AOI + window +
sensor filter and gets the pass schedule, revisit/coverage stats, and a sky-view.

### Data model — sensor type
CelesTrak groups are by operator/purpose, NOT sensor type. Bridge with a small
curated catalog (no completeness claim — title it "known commercial sensors"):

- `apps/web/src/registry/sensorSats.ts` (NEW): `{ norad: number, name, sensor:
  'SAR'|'EO'|'MSI'|'RF', operator }` for the well-known constellations — ICEYE &
  Capella & Umbra (SAR), Planet Doves/SkySat & BlackSky (EO/MSI), HawkEye 360 &
  Spire (RF). Fall back to group-level class for everything else.
- Sensor filter = union of the relevant CelesTrak groups (`planet`, `spire`,
  `military`, `geo`, `active`) intersected with the curated catalog.

### Compute (client-side, reuse SGP4)
- Reuse `SatelliteAdapter.sampleOrbit(rec, startMs, stepSec, windowSec)` to walk
  each candidate sat across the window.
- **NEW** `apps/web/src/sim/tasking.ts`: pure functions
  - `passesOverAoi(rec, aoi{lat,lon,radius_km}, window, stepSec)` → `Pass[]`
    `{satName, startMs, endMs, maxElevDeg, aolEnterMs, durationS}` using
    `satellite.js` `ecfToLookAngles(observerGd, satEcf)` (elevation > horizon
    mask) — **the function already bundled, just unused**.
  - `skyView(rec, aoi, window, stepSec)` → az/el samples for the polar plot.
  - `coverageStats(passes, window)` → `{coveragePct, avgRevisitMin, passCount,
    maxGapMin}`.
- Chunk across frames (per-frame budget, like the adapter) so a 4 k-sat sweep
  never hits the ~100 ms main-thread hitch the guardrail warns about. If it's
  still heavy, move to a Web Worker (TLEs are tiny to post).

### UI
- `apps/web/src/tasking/TaskingPanel.tsx` (NEW): params (AoiSelector or
  map-click + radius; `From` datetime + `for N hours`; sensor chips MSI/SAR/RF;
  min revisit). Results: `Widget`s for the stats (`KVRow` coverage/revisit/
  passes), a `Flyovers` list (`SectionLabel` + rows), and a **SkyViewPlot**.
- `apps/web/src/tasking/SkyViewPlot.tsx` (NEW): SVG polar plot (az 0-360 ring,
  elevation rings) — pure SVG, same approach as Timeline's SVG histogram.
- Globe viz: draw the AOI ring + selected pass ground-track as
  `Cesium.Polyline` (geodesic), reusing the satellite source for context.
- Mount: add `{ id:'tasking', label:'Tasking', content:<TaskingPanel viewer/> }`
  to `rightTabs`. Hotkey precedent in `App.tsx` keydown.

### Optional backend
None required (client SGP4). If sweeps get heavy, add
`GET /api/space/tasking` (pre-computed pass tables) following `space.py` cache
pattern — defer until measured.

**Guardrails**: predictions stay in the planner; never feed predicted positions
back into the live `SatelliteAdapter` motion (SGP4-from-current-TLE only).
`FORMAT=tle` already enforced.

**Verify**: unit test `tasking.ts` against a known pass (ISS over a known
ground station / time → assert a pass with sane max-elevation). One vitest file.

---

## Pillar 2 — Gotham visual reskin (additive)  ★ build second

**Gotham reference**: ordered **layer-tree** folders ("1. Obj TDRN CANVAS…
Recognised Maritime Picture… OSINT"); pervasive **classification caveats**
(`MTS//MNF`, UNCLAS); a persistent **status/health bar** ("Map health ·
Connected"); monospace IDs; restraint.

**Reality**: Velocity already has the palette, fonts, icons, status dots, and the
`UNCLAS` pill (`CommandBar.tsx:107-112`). This pillar is small + additive.

| Change | File | Note |
|---|---|---|
| **Classification component** | `shell/instruments.tsx` (NEW `Caveat`) | Configurable banner `UNCLAS//FOUO` / `NOTIONAL` / commercial-mode notice; reuse in panel headers + card footers |
| Expand caveat in command bar | `command-bar/CommandBar.tsx:107` | Use new `Caveat`; show data-posture (commercial vs keyless) |
| **Layer-tree folders** | `layer-rail/LayerRail.tsx` | Add optional named, ordered, collapsible groups over the flat layer list (Gotham's numbered folders). Group metadata in `registry/defaults.ts` |
| **Status bar** | `shell/ConsoleShell.tsx` (NEW thin bottom-or-top strip) | Consolidate WS pill + feed health + replay state + entity/FPS into one "Map health" bar |
| Card caveat footer | `entity-panel/*`, new Kanban cards | `MTS//MNF`-style classification line on dossier/target cards |

**Immutable** (do NOT touch): `styles.ts` icon dispatch + colors, `labelStyle.ts`
font/colors, selection polyline, motion models, `requestRenderMode`.

**Verify**: typecheck + visual check (boot, confirm icons unchanged, caveats
render, layer folders collapse). No icon/label regression.

---

## Pillar 3 — Target Lifecycle Kanban (F2T2EA)

**Gotham reference** (`GothamCard01` board): columns = **Confirm → Attach Intel
→ Obtain Approvals → Weaponeer → Execute → Assess → Complete**, each with a
count; cards grouped by HPTL priority; stage-progress pips; threat-colored
borders; `MTS//MNF` caveat; drag between stages.

**What to build**: a board over tracked entities / sim targets that moves them
through the lifecycle, persisted per user.

### State + persistence (copy `alert_rules.py`)
- `apps/web/src/state/targetBoard.ts` (NEW): `useTargetBoard` Zustand —
  `entries: TargetEntry[]`, `{ id, entityId, stage, priority, note }`, with
  add/move/remove + load/save.
- `apps/api/app/routes/targets.py` (NEW): `GET/POST/PATCH/DELETE /api/targets/board`,
  Supabase REST + RLS, mirroring `alert_rules.py` exactly.
- Supabase migration `target_board` table (`site/supabase-schema.sql`): `id,
  user_id, entity_id, stage, priority, note, created_at, updated_at`, unique
  `(user_id, entity_id)`, RLS `auth.uid() = user_id`.

### UI
- `apps/web/src/target-kanban/TargetKanbanPanel.tsx` (NEW): horizontal columns
  (the 7 F2T2EA stages) using `SectionLabel` headers w/ counts; cards = entity
  icon + label + stage pips (`MeterBar`/dots) + threat border (`--alert/--warn`
  from severity) + `Caveat` footer.
- **Drag**: native HTML5 (`onDragStart/onDragOver/onDrop`) — **no dnd lib**
  (none installed; don't add one). Tailwind for drag affordance.
- Wiring: globe entity select → "Add to board" (Confirm); card click →
  `useSelection` (fly camera to it); drag → `PATCH` stage.
- Mount as `rightTabs` entry `{ id:'targets', label:'Lifecycle' }`, OR a wide
  bottom board if columns need width (decision below).

**Sim tie-in**: sim attack targets (`DefenseSite`/catalog) can seed the board so
a war-game run produces a populated lifecycle.

**Verify**: pytest for `targets.py` CRUD (mock Supabase like alert_rules tests);
vitest for stage-move reducer; typecheck.

---

## Pillar 4 — FMV + onboard-AI (honest mock)  ⚠ speculative

**Gotham reference** (`GothamFullBleed03`): down-looking sensor feed, AI
bounding boxes (vehicle/structure/flagged), class counts, platform attitude +
sensor az/el telemetry, archived-video scrubber.

**Reality check**: OSINT has **no drone video** and **no on-board CV model**.
This can only be a *notional* reconstruction driven by sim drones + a static
overhead image. Build it clearly labeled "NOTIONAL / SIMULATED" (matches
Gotham's own "All data shown is notional" footer). Do not imply a live feed.

### What it can honestly be
- Select a **sim drone** → `followEntity()` down-looking camera (recon: exists).
- HUD panel (absolute React div over Cesium, the `SimulationOverlay` pattern):
  - **Telemetry** from `RtAgent` (already has lat/lon/alt/heading/link/mode/
    fate/profile) + derived pitch/roll/sensor az-el (deterministic from
    geometry). `KV`/`KVRow`.
  - **Frame**: a static overhead tile from `imagery.py` (`/api/imagery/...`)
    under the AOI as the "sensor image".
  - **Detections**: synthesize boxes from *other sim entities / known map
    features within the footprint* (not a CV claim) → `detections[]` +
    class-count badges. Clearly "sim-derived".
- Scrubber: reuse `Timeline` clock (`viewer.clock.onTick`) for archived playback.

`apps/web/src/fmv/FmvPanel.tsx` + `fmv/detections.ts` (NEW). Sim clock guardrails
respected (drones may glide).

**Recommendation**: build this LAST and smallest; if it can't be made to feel
honest, ship it as a labeled concept rather than overclaim. The escalation/
feasibility value the operator wants from "is it possible" is better served by
the existing sim Attack model + (Pillar 1) real satellite collection windows.

---

## Cross-cutting: what stays untouched

Icons (`styles.ts`), labels (`labelStyle.ts`), aircraft teleport / no-synthesis,
vessel glide, world-view md5 decimation + hot-blob, `requestRenderMode`, ADS-B
cadence, `FORMAT=tle`. Any pillar PR that touches these is wrong.

## Open decisions (operator)

1. **Kanban placement** — right-rail tab (narrow, scroll columns) vs a wide
   bottom dock (true Gotham board). Recommend: tab for v1, dock if it earns it.
2. **Sat sensor catalog depth** — curate ~30 well-known commercial sats now, or
   wire a richer source later. Recommend: curate now, labeled "known sensors".
3. **FMV scope** — ship as labeled concept vs invest in a convincing mock.
   Recommend: minimal labeled concept.
4. **Persistence for Tasking saved searches** — none (ephemeral) vs Supabase
   like the Kanban. Recommend: ephemeral v1.

## Effort / risk

| Pillar | New files | Backend | Deps | Risk |
|---|---|---|---|---|
| Sat Tasking | ~4 fe | none (opt later) | none | low (math is exact, testable) |
| Reskin | ~1 fe + edits | none | none | low (additive; guardrail-bounded) |
| Kanban | ~3 fe + 1 route + migration | Supabase table | none (HTML5 dnd) | med (auth/RLS) |
| FMV mock | ~2 fe | none | none | med (honesty/over-claim) |
