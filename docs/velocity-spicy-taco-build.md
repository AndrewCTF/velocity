# Velocity — deeper-Gotham build (sensor footprint, FMV, interactive COP, omnibar, P4 surfaces)

Execution of `~/.claude/plans/i-want-a-detailed-spicy-taco.md`. Every feature was
typechecked, then driven live in a real browser at 1920×1080 against the running
app (Vite :5173 + FastAPI :8000, keyless). Evidence tiers below are honest:
**proven-live** (exercised + observed this session) / **plumbed-unverified**
(built, not fully exercised — usually login-gated) / **not-built**.

## Verification gates (all green)

- `pnpm -r typecheck` → 0 errors (shared + web)
- `pnpm --filter @osint/web test` → **121 passed (121)** (incl. new `globe/draw.test.ts`)
- `apps/api .venv/bin/pytest -q` → **514 passed** (zero backend files changed this build)
- `pnpm --filter @osint/web lint` → **0 problems** (also fixed 2 pre-existing lint errors in
  `ConnectionsCard.tsx` / `InvestigationCanvas.tsx`, unrelated to this work)
- Live: fresh load 0 console errors; **11,926 aircraft + 4,826 vessels** render (≥8k guardrail held)

## P1 — Drone sensor footprint + FMV — PROVEN-LIVE

- NEW `globe/SpotlightLayer.ts` (+ `useSpotlight` store): dark fog polygon with a circular
  hole that follows the selected sim drone (`PolygonHierarchy` holes). Verified-at-build:
  **holes punch through in Cesium 1.123** (`holeCount=1`, 96-pt hole in a 4-pt box; fallback
  not needed). Ring position == drone position every sample (`ringTracksDrone=true`); the hole
  tracks a moving drone (6 distinct positions). Screenshots: `p1-05/p1-06`.
- `fmv/FmvPanel.tsx`: **fixed the "FMV shows nothing"** root cause — telemetry read
  `globalThis.Cesium`, never populated by vite-plugin-cesium, so every field was "—". Now
  imports Cesium directly → HEADING/MODE/LINK/sensor Az-El/footprint-center populate. The frame
  canvas now renders **real overhead satellite imagery** of the ground under the drone (a tile
  mosaic from the app's own keyless `/tiles/sat` proxy — EOX/Esri; ~70 tiles → 200), centred +
  scaled to the footprint, north-up, with footprint ring + heading arrow. Honest stamps:
  `NOTIONAL // SIMULATED` + `ARCHIVE EO · NOT LIVE`. Screenshot: `p1-07`.

## Shared `globe/draw.ts` toolbox — PROVEN-LIVE

- `placePoint`, `drawPolyline` (multi-click + live rubber-band, right-click/Finish to commit),
  `drawCircle` (centre + radius), own draft CustomDataSource; module singleton via
  `setDrawController`/`getDrawController`, created in GlobeCanvas. Pure `haversineKm` unit-tested
  (3 tests). Exercised live by COP (units/rings/lines), annotations, and watchbox.

## P2 — Interactive COP — PROVEN-LIVE

- NEW `cop/copStore.ts` (units/lines/rings, seeded from notional, `composeSidc` builder),
  `cop/CopEditor.tsx` (affiliation×type×echelon palette → place; FLOT/phase-line; range-ring;
  laydown list w/ delete; Save/Reset/Clear), `'cop'` mode-surface + COP toggle. `MilSymbolAdapter`
  repointed at `copStore` and re-renders on every change. Live: opening COP enabled the layer +
  rendered 23 entities; **placing a unit 18→19, drawing a ring 1→2, drawing a line 2→3** by
  clicking the map. Persist = best-effort ontology (`saveCopToOntology`) — **plumbed-unverified**
  (needs login). Screenshots: `p2-01/p2-03`.

## P3a — ⌘K Omnibar — PROVEN-LIVE

- NEW `command-bar/Omnibar.tsx`: fuzzy palette over actions (open workspace / show-hide layer)
  - live entities (`/api/search`). Enter runs an action (opened COP) or selects+flies to an
    entity. Live: searched `UAL2332` → selected `aircraft:ab1644` + flew camera to its real
    position over DC. Repointed the analyst console ⌘K → **⌘J** (handlers + 4 hints). Screenshots:
    `p3-01/p3-02`.

## P3b — Focused-mode rail suppression + classification banner — PROVEN-LIVE

- Right rail suppressed in `cop`/`fmv`/`targeting` modes (gated in App + conditional `<aside>` in
  ConsoleShell; targeting box widened to `right-3`). Live: `rightRailAfterCop=false`, globe runs
  edge-to-edge. Persistent full-width **UNCLASSIFIED // OPEN-SOURCE INTELLIGENCE** banner (new top
  grid row; turns amber EXERCISE when the sim runs). Screenshot: `p3b-01`.

## P4a — Geofence / watchbox — PROVEN-LIVE

- NEW `watchbox/watchboxStore.ts` + `globe/WatchboxLayer.ts` (AOI rings + client-side
  enter/exit/loiter evaluator) + `watchbox/WatchboxPanel.tsx` ("Watch" tab). Draw an AOI → pick a
  rule → a 2 s evaluator checks live aircraft/vessels and pushes real `Alert`s into the Alerts rail
  - ticker. Live: armed alert reported contacts inside (e.g. "4893 contacts"); **21 real ENTER
    events** (UPS266, MSC2913 vessel, …) crossing the AOI. Fixed a duplicate-key error storm
    (an entity present in two feeds was double-counted → dedup by id). Backend `/api/alerts` rule
    registration = **plumbed-unverified** (needs login). Screenshot: `p4a-01`.

## P4b — Annotations / graphics — PROVEN-LIVE

- NEW `annotations/annotationStore.ts` + `globe/AnnotationLayer.ts` + `annotations/AnnotationPanel.tsx`
  ("Annotate" tab). Draw point / line / circle with a threat colour + label via the toolbox →
  rendered + listed. Live: `count=3, kinds=[circle, point, line]`. Persist = best-effort ontology
  (**plumbed-unverified**, login). Screenshot: `p4b-02`.

## P4c — "Search around" link expansion — PARTLY PROVEN-LIVE

- Search-around flow already existed (EntityPanel button → `useInvestigation.searchAround` →
  InvestigationCanvas). ADDED a **globe right-click → search-around** trigger (GlobeCanvas
  RIGHT_CLICK → pick entity → `searchAround`). Live: button bumped `openSeq 0→1` and **fired
  `GET /api/ontology/search-around/aircraft:ab1644` (401 logged-out)**; right-clicking a centred
  aircraft bumped `openSeq` + set `rootId`. The 2-hop **graph data + on-globe flash are
  plumbed-unverified** (the ontology route is RLS-scoped → needs login).

## P4d — Pattern-of-life playback — PROVEN-LIVE

- History playback (`HistoryPlayback` + Timeline) already replayed bbox tracks (keyless). ADDED
  entity-scoped replay (`load(windowSec, onlyId)`) + **dwell clustering** + `polReplayStore` +
  Timeline subscription + an EntityPanel "Pattern of life" button. Live: 209 tracks of history in
  the Europe bbox; "Pattern of life" on `aircraft:01023c` replayed **only its track + 1 dwell
  cluster** (`dwell:aircraft:01023c:203`), clock animating, all 6 live layers hidden. Screenshot:
  `p4d-01`.

## Honest limits

- Ontology-backed persistence (COP, annotations) + the search-around graph/flash all require a
  Supabase login; local-first works now, persisted state is plumbed-unverified.
- Watchbox enter/exit/loiter is a **client-side** evaluator over rendered entities (server rule
  registration via `/api/alerts` needs login). At zoomed views only the local bbox is scanned.
- Screenshots referenced above are dev artifacts at the repo root (gitignored), not committed.
