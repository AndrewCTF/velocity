# Coverage: what the app has, what the mockups specified, what must not be lost

Built by enumerating the real registries in source, not from memory:

```
App.tsx:179-205   railItems     18 left-rail panels
App.tsx:209-222   rightTabs      9 right-rail tabs
App.tsx:156-174   leftTabs      10 mobile tabs (adds `situations`)
state/appView.ts  AppId         14 apps
AppRouter.tsx     routes         9 routes
```

The mockup set is **22 pages**. The app has **18 + 9 + 14 + 9 = 50 addressable
surfaces** plus ~12 overlays. **The mockups cover roughly 40 % of it.** Wiring
the design in without this list would silently drop the rest.

## Left rail, 18 panels

| id | Component | Mockup | Wiring note |
|---|---|---|---|
| `layers` | `LayerCatalog` | **yes** `10-map` | the reference panel |
| `filters` | `HistogramPanel` | **yes** `13-map-histogram` | faceted bars, clickable |
| `feeds` | `FeedsPanel` | **yes** (merged into Info) | sparkline per feed |
| `ops` | `OpsPanel` | **yes** (merged into Info) | keep the 3-state guard |
| `search-objects` | `SearchObjectsSidebar` | partial (`14-map-find`) | Find covers geo search, not object search |
| `imagery` | `ImageryControl` | **no** | has a legend + frame stepper; 18 image surfaces depend on it |
| `annotate` | `AnnotationPanel` | **no** | threat-colour swatches are 3 emoji sites |
| `watch` | `WatchboxPanel` | **no** | |
| `inbox` | `InboxPanel` | **no** | |
| `answers` | `AnswersCard` | **no** | |
| `chokepoints` | `ChokepointsList` | **no** | |
| `acars` | `AcarsPanel` | **no** | |
| `extract` | `ExtractPanel` | **no** | |
| `countries` | `CountriesPanel` | partial (`25-country`) | flag emoji built at runtime, 2 sites |
| `allsources` | `LayerRail` | partial (`10-map`) | `MeterBar` on opacity only |
| `field` | `FieldPanel` | **no** | |
| `tasking` | `TaskingPanel` | partial (`32-decide`) | owns `SkyViewPlot`, the polar scope |
| `cop` | `CopEditor` | **no** | MIL-STD-2525 via `milsymbol`, must not be restyled away |

## Right rail, 9 tabs

| id | Component | Mockup |
|---|---|---|
| `selection` | `EntityPanel` | **yes** `11-map-selected` |
| `filters` | `HistogramPanel` | **yes** |
| `investigation` | `InvestigationCanvas` | **yes** `20-graph` |
| `intel` | `IntelPanel` | partial |
| `news` | `NewsPanel` | partial (`29-reports`) |
| `alerts` | `AlertsRailList` | **no** |
| `collab` | `CollabPanel` | **no** |
| `ground` | `GroundReconPanel` | **no** |
| `field` | `FieldPanel` | **no** |

## Apps, 14

Covered: `ai` `explorer` `graph` `investigate` `targeting` `video` `country`
`markets` `foundry` `workflows` `city` `reports`, plus the new `decide`.
`map` is the console itself.
**Not covered: `sim`** — `SimulationOverlay`, which is a full-screen overlay
with its own transport and 6 emoji sites.

## Routes, 9

`/` is the console. **Not covered: `/2d` `/studio` `/news` `/news/:id`
`/login` `/signup` `/forgot` `/reset`.** The four auth routes matter for wiring
because they render outside `ConsoleShell` and will not inherit shell styling.

## Overlays and chrome, not addressable from a registry

| Surface | Mockup | Note |
|---|---|---|
| `CommandBar` | **yes** (title bar) | `SysStats` is 4 bare numbers, named in `VIDEO-ANALYSIS.md` |
| `Omnibar` (⌘K) | **no** | the palette indexes everything; §2.2 rule 2 |
| `AgentConsole` (⌘J) | **no** | 8 emoji sites |
| `ContextMenu` | **yes** `14-map-find` | |
| `ModeSurface` | **no** | 4 modes: targeting, tasking, fmv, cop |
| `AlertsPanel` modal | **no** | |
| `SimulationOverlay` | **no** | |
| `FloatingPanel` | **no** | detach/drag; has a pointer-capture fix that must survive |
| `TabbedPanel` | **no** | 3 emoji sites |
| `Modal` / `toast` / `InlineAlert` | partial | toast **yes** |
| Settings | **no** | `SettingsModal` |
| First-run gate | **no** | `--z-wizard`, must stay above modals |
| `MapHealthStrip` | **yes** (map strip) | |
| `GlobeToolbar` | **yes** (7 tools) | |
| `Timeline` | **yes** `12-map-replay` | |

## Invariants the wiring must not break

These are guarded; a wiring change that trips one is a regression, not a restyle.

1. `globe/adapters/styles.ts` must literally contain the eight palette hexes and
   must not contain `PointGraphics`. **The map data palette is a separate colour
   system from the chrome and the token rewrite must not touch it.**
2. `PollGeoJsonAdapter.ts` must not contain `.removeAll(`.
3. `GlobeCanvas.tsx` keeps `requestRenderMode: true` and
   `maximumRenderTimeChange: 0`.
4. `theme/contrast.test.ts` — every `--txt-*` tier clears 4.5:1 on `--bg-1` and
   `--bg-2`. **The token values cannot be pasted in without recomputing this.**
5. `entity-panel/placeCards.test.tsx` pins exact strings and the lone `—`.
6. `layer-rail/OpsPanel.test.tsx` pins loading / empty / error.
7. `state/appView.test.ts` — `APP_GROUPS` covers every `AppId` once.
8. ESLint bans raw `fetch` outside `src/transport/**`.
9. Token **names** are stable: Tailwind utilities and 79 importers of
   `instruments.tsx` reference them. Values change, names do not.

## Order of wiring

1. **Tokens** — values only. Restyles all 50 surfaces at once, reversible in one
   file, and cannot drop a feature.
2. **Component grammar** — add `.mark`, `.sect`, `.obj-card`, `.wcard`, `.field`
   as real CSS the app loads, so panels can adopt them one at a time.
3. **Icons** — 190 emoji sites to `normal/Icon.tsx`. Mechanical, high visibility.
4. **Panels** — the 14 uncovered left panels and 7 right tabs, each adopting the
   grammar. This is the long tail and where features get dropped if this list
   is not followed.
