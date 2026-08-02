# Wiring checklist: every surface → its mockup home

Generated from the real registries (`App.tsx` `railItems` / `rightTabs`,
`state/appView.ts`, `AppRouter.tsx`), not from memory.

Naming follows the mockup set: pages are `NN-name`, components are the CSS
class names in `console.css`.

Status: **done** · **todo** · **ask** (no home, operator decides)

---

## Left rail, 18 → four named panels

| # | old id | component | mockup home | page | status |
|---|---|---|---|---|---|
| 1 | `layers` | `LayerCatalog` | `Layers` panel, `.row` + `.mark` | `10-map` | **done** |
| 2 | `allsources` | `LayerRail` | `Layers` panel, "all sources" toggle | `10-map` | **done** |
| 3 | `search-objects` | `SearchObjectsSidebar` | `Find` panel, `.obj-card` results | `14-map-find` | **done**, minus regions [^regions] |
| 4 | `filters` | `HistogramPanel` | `Histogram` panel, `.row` + `.bar` facets | `13-map-histogram` | **done** |
| 5 | `feeds` | `FeedsPanel` | `Info` panel, `.row.two` + `.spark` | `15-map-info` | **done** |
| 6 | `ops` | `OpsPanel` | `Info` panel, `.sect` group | `15-map-info` | **done** |
| 7 | `acars` | `AcarsPanel` | `Info` panel, `.sect` group | `15-map-info` | **done** |
| 8 | `chokepoints` | `ChokepointsList` | `Info` panel, `.sect` group | `15-map-info` | **done** |
| 9 | `annotate` | `AnnotationPanel` | map `.toolbar`, Draw group | `10-map` | **done** (floating, opened from `GlobeToolbar`) |
| 10 | `watch` | `WatchboxPanel` | map `.toolbar`, Select group | `10-map` | **done** (floating) |
| 11 | `field` | `FieldPanel` | map `.toolbar`, Measure group | `10-map` | **done** (floating) |
| 12 | `imagery` | `ImageryControl` | Video app, imagery tab | `24-video` | **done** |
| 13 | `extract` | `ExtractPanel` | Investigate app | `22-investigate` | **done** (Extract tab) |
| 14 | `tasking` | `TaskingPanel` | Decide app, `.wcard` queue | `32-decide` | **done** via `ModeSurface` |
| 15 | `countries` | `CountriesPanel` | Country app, National sources tab | `25-country` | **done** (not redundant: dossier vs source catalogue) |
| 16 | `answers` | `AnswersCard` | AI app, above the Watch Officer | `31-ai` | **done** |
| 17 | `cop` | `CopEditor` | COP workspace mode (`ModeSurface`) | — | **done** |
| 18 | `inbox` | `InboxPanel` | `.titlebar` inbox button, modal | `10-map` | **done** |

[^regions]: The old sidebar let the operator define up to four independent
circular regions (A/B/C/D), union their envelopes into one bbox, and re-filter
the results to the exact circles client-side. Find keeps one anchor plus a
radius, and has gained back the object-type filter, the rolling time window and
Save-search. The four-region compositor is the one capability not carried over;
it needs the drawn-circle map layer the old panel owned, not just a control.

## Right rail, 9 → three docked panels

| # | old id | component | mockup home | page | status |
|---|---|---|---|---|---|
| 1 | `selection` | `EntityPanel` | `Selection` panel | `11-map-selected` | **done** |
| 2 | `intel` | `IntelPanel` | `Selection`, `.sect` section | `11-map-selected` | **ask** |
| 3 | `filters` | `HistogramPanel` | left `Histogram` (single home) | `13-map-histogram` | **done** |
| 4 | `investigation` | `InvestigationCanvas` | **redundant** with the Graph app | `20-graph` | **done** |
| 5 | `news` | `NewsPanel` | **redundant** with Reports → News | `29-reports` | **done** |
| 6 | `ground` | `GroundReconPanel` | **redundant** with Video → Ground recon | `24-video` | **done** |
| 7 | `collab` | `CollabPanel` | Reports app | `10-map` | **done** |
| 8 | `alerts` | `AlertsRailList` | `.titlebar` bell + `.toast` | `10-map` | **done** |
| 9 | `field` | `FieldPanel` | map toolbar (same as left #11) | — | **done** |

## Right dock, panels the mockup adds

| mockup panel | source | status |
|---|---|---|
| `Series` | `MetricsPanel` + `ArchiveSeriesCard` | **done** (`shell/panels/SeriesPanel.tsx`) |
| `Time selection` | split out of `Timeline` | **ask** — `TimeDock` already owns playback and the scrub range; a third right tab would repeat it |

## Apps, 14 → one launcher (`.applist`, pinned first)

| app | mockup page | status |
|---|---|---|
| `map` | the console itself | **done** |
| `graph` | `20-graph` | todo |
| `explorer` | `21-explorer` | todo |
| `investigate` | `22-investigate` | todo |
| `targeting` | `23-targeting` | todo |
| `video` | `24-video` | todo |
| `country` | `25-country` | todo |
| `markets` | `26-markets` | todo |
| `foundry` | `27-foundry` | todo |
| `workflows` | `28-workflows` | todo |
| `reports` | `29-reports` | todo |
| `city` | `30-city` | todo |
| `ai` | `31-ai` | todo |
| `sim` | **no mockup page** | **ask** |
| — | `32-decide` exists with no app behind it | **ask** |

## Chrome

| surface | mockup component | status |
|---|---|---|
| classification band | `.csl2-clas` pill in `.titlebar` | **done** |
| top bar | `.titlebar` (brand · menu · doc · state) | todo |
| left icon rail (18 icons) | deleted, replaced by four named `.csl2-tab` | **done** |
| timeline footer 158px | `.csl2-dock` floating | **done** |
| — | `.actionbar`, the query as a sentence | todo |
| `GlobeToolbar` | `.toolbar` with group labels | todo |
| `MapHealthStrip` | `.map-strip` | todo |
| map labels | `.lbl` chips | todo |
| — | `.compass` bearing readout | todo |
| `Omnibar` ⌘K | palette | todo |
| `AgentConsole` ⌘J | dock | **ask** |
| `ModeSurface` (4 modes) | targeting/tasking/fmv/cop workspaces | **ask** |
| `SimulationOverlay` | — | **ask** |
| `SettingsModal` | settings as a place | todo |
| first-run gate | — | todo |
| `FloatingPanel` detach | keep as-is | todo |

## Routes, 9

`/` is the console. `/2d` `/studio` `/news` `/news/:id` render outside the
shell. `/login` `/signup` `/forgot` `/reset` are auth pages with their own
layout.

| route | status |
|---|---|
| `/` | **done** (shell rebuilt) |
| `/2d` `/studio` `/news` `/news/:id` | todo, inherit tokens only |
| `/login` `/signup` `/forgot` `/reset` | **ask** — auth pages, own layout |

---

## Needs your call (7)

These have no obvious mockup home and I am not going to invent one:

0. **`intel` / `IntelPanel`** — the mockup files it as a Selection section, but it
   is not selection-scoped: it is dark vessels, GPS jamming, the fused incident
   brief and the watch list, none of which depend on what is selected. Filed
   under Selection it would vanish whenever nothing is selected, which is
   exactly when an operator wants the brief. Own right panel, own app, or a
   section of Info? It sits under **More** until this is answered.
0b. **`Time selection`** — see the dock row above.
1. ~~`field` / `FieldPanel`~~ — **answered**: map tool. It floats over the map,
   opened from `GlobeToolbar` alongside Annotations and Watchboxes.
2. ~~`cop` / `CopEditor`~~ — **answered**: workspace mode only. The duplicate rail
   entry is gone.
3. **`sim` / `SimulationOverlay`** — a whole app with its own transport and no
   mockup page. Own page, or fold into Decide?
4. **`32-decide`** — I designed this page; there is no app behind it. Make it a
   real app, or drop the page?
5. **`AgentConsole` (⌘J)** — a conversational dock. The AIP terminal grammar
   fits it, but it is not in the mockup set.
6. **`ModeSurface`** — four full-screen workspaces (targeting, tasking, fmv,
   cop). Apps, or modes?
7. **Auth pages** — restyle to the console grammar, or leave them alone?
