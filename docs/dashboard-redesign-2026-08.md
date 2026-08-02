# Dashboard redesign 2026-08 — navigation, panel grammar, and Foundry

Status: **direction chosen (A, with C's pinning). Ready to implement.**
Nothing under `apps/` has changed. This document is the decision record; the
mockups are in `tmp/redesign/` and are **not committed** (`.gitignore:74`).

Mockups: `tmp/redesign/00-index.html` is the board. Directions are
`a-panel-parity.html`, `b-verb-first.html`, `c-palette-first.html`; shared sheets
are `panels.html`, `foundry.html`, `components.html`, `states.html`,
`rehoming.html`, `mock.css`.

`panels.html` is all seven Palantir panels at fidelity, built from the same
markup the direction pages inject, so a panel cannot be convincing in the
gallery and thin in a direction. `_build.py` assembles the direction pages and
the gallery from one source of panel HTML; the output is plain self-contained
files that need no build step to view.

`rehoming.html` is the authoritative surface inventory: the shipped UI rendered
beside the proposal from `docs/media/panels/`, the six departures named with
justification, and every one of the **64 layers, 14 apps, 18 rail items and 9
routes** mapped to a home. Its counts are extracted from source, not typed by
hand: layer ids and titles from `registry/defaults.ts` joined to folders from
`normal/layerCatalog.ts`, apps from `state/appView.ts:30`, rail items from
`App.tsx:179-204`, routes from `AppRouter.tsx:55-65`.

Reference: `docs/palantir-reference-2026-07.md`. Prior design authority:
`docs/frontend.md` (five-zone layout, aesthetic rules),
`docs/velocity-visual-reskin-plan.md` (IA restructure, anti-AI-slop check),
`docs/decisions.md` (every guarded behaviour).

> **A note on the missing spec.** A design document numbered `§6.0-§6.7 / §7 / §8`
> is cited about thirty times across source comments (`AppRouter.tsx:73`,
> `App.tsx:120,125,134,176,275`, `state/appView.ts:1,95`, `shell/AppSurface.tsx:20`,
> `entity-panel/ObjectInspector.tsx:8`, `foundry/nav.ts:1`, `theme/tokens.css:71,85,109`
> and more). It does not exist in the repo; it was deleted in commit `1b26a1a`
> ("chore: tidy repo"). The single most-cited design authority in this codebase
> survives only as section numbers in comments. **This file replaces it**, and it
> lives in `docs/` for that reason.

---

## 1. Why

Velocity has more capability than navigation. Measured from source:

| Fact | Evidence |
|---|---|
| 41 entry points compete: 14 apps, 18 rail items, 9 routes | `state/appView.ts:14`, `App.tsx:179-204`, `AppRouter.tsx:55-65` |
| The ⌘K palette indexes **zero** apps, routes, rail items or settings | `command-bar/Omnibar.tsx:41-46,82-110` |
| 12 unrelated `keydown` listeners, 4 binding `Esc` | Omnibar, AgentConsole, App, SearchField, GlobeToolbar, ContextMenu, SettingsModal, AlertsPanel, Onboarding, InboxPanel, AnnotationPanel, WorkbenchTabs |
| The richer of two layer UIs is buried in a "more" drawer | `App.tsx:181` vs `App.tsx:197` |
| `LayerRegistry.setTimeWindow` has no UI at all | `registry/LayerRegistry.ts:65` |
| `rightTabs` (9) and `leftTabs` (10) are rebuilt every render for the mobile chooser only | `App.tsx:156-222`, `ConsoleShell.tsx:225-233` |
| `ConsoleShell`'s `overlayLeft` slot is implemented and never passed | `ConsoleShell.tsx:36,296` |
| 780 sub-11px font-size literals against a documented 11px floor | 748 at `text-[10px]`, 31 at `text-[9px]`, 1 at `text-[8px]` |
| `--sp-*` spacing scale: 0 consumers. `--fs-*`: 10, all in `Markdown.tsx` | `theme/tokens.css:71-78,102-107` |
| Three parallel primitive sets, no shared form controls | `shell/instruments.tsx` (79 importers), `foundry/ui.tsx` (3), `country/shared.tsx` (0) |

Two persona waves reached the same verdict independently: capability that is
*"reachable but invisible"*, that *"fails silently"*, with *"no in-app way to
discover"* a degraded feed. Finding six of
`docs/user-feedback-personas-2026-07.md` is titled **"Built-but-unreachable
capability keeps not converting."**

**What is already right and must not be disturbed:** the shell is already
map-first. The globe mounts once at `ConsoleShell.tsx:274` and never unmounts;
apps paint over it through `mainOverlay`. `EntityPanel` (27 blocks) and
`Timeline` (transport, replay, coverage strip, event lanes, density, auto-pause)
are the two strongest surfaces in the product. The Foundry backend is real.

---

## 2. The visual departure, and why each part of it

The first pass of these mockups was rejected by the operator for reading as a
refinement of the current console rather than a redesign. That was accurate: it
reused `theme/tokens.css` verbatim, the four-row `ConsoleShell` grid, the tinted
section-label bars, and the 11px density. Five signatures of the existing UI,
carried over unchanged.

The second pass departs on each, and **every departure closes something already
recorded as a defect**:

| Axis | Today | Proposed | The problem it fixes |
|---|---|---|---|
| **Colour** | warm ink `#191817`, accent `#6fb1dd` | instrument grey `#182026`, muted steel accent `#2B95D6` | Colour is the strongest signal of "same product". |
| **Analytical apps** | dark, same as the map | **light** (`#FFFFFF` / `#F5F7FA`) | Gotham is dark because it is operational; Foundry is light because it is analytical. The mode switch is itself information: dark when you are watching, light when you are building. |
| **Layout** | three columns; opening a panel makes the map narrower | **edge-to-edge map with panels docked flush over it**; nothing owns a grid track | The map is the product. A 336px column that permanently steals width is exactly the "covered by permanent chrome" that `docs/frontend.md:99` forbids. |
| **Shell** | 26px classification band + 42px bar + 158px timeline footer | a floating 52px bar, marking as an inline pill, time as a collapsible dock over the map | Four grid rows down to zero, about 230px of vertical returned to the map. |
| **Type** | body 13px, floor 11px, uppercase tracked labels | body 14px, floor 12px, 20px panel titles, sentence case | `docs/decisions.md:1017` already concluded the density, not the typeface, was what read as "AI dashboard". This finishes that argument instead of leaving 780 literals below the floor. |
| **Chrome** | tinted label bars with a 3px accent edge, nested bordered boxes, rules between rows | grouping by space and weight; hairlines only where two surfaces meet | The tinted eyebrow is the most recognisable ornament of the current UI and carries no information. |
| **Navigation** | 44px icon rail with tooltips | named text tabs, apps behind one launcher, palette over everything | An icon with a tooltip is exactly the reachable-but-invisible pattern the persona studies kept finding. |
| **Radii / rows** | 2/3/5px, ~24px rows | 2/3/4px, 30px rows | Hard corners at that density read as instrument cosplay; 24px rows put counts into labels. |

| **Map** | an abstract globe with blob landmasses | a **real basemap at the zoom the data implies**: Baltic approaches, 100 km scale bar, coastlines including the Hel peninsula and Vistula Spit, named places, labelled graticule, north arrow | The scenario reads 54.3181 N 018.7122 E. A globe at that scale is the wrong instrument. A geoint console is judged on its map before anything else, and a cartoon globe undoes every other decision. |
| **Density** | rows ~24px | rows 26px, two-line rows 38px, panel padding 16px, 17 layer rows per screen | Professional density is not small type. The type scale is unchanged; only the whitespace moved. |
| **Surface** | tinted label bars, bordered boxes | flat surfaces, 1px hairlines, rectangles not pills, small rectangular switch, no backdrop blur, no accent glow, shadow only on things that genuinely float | An intermediate pass used 14px radii, 28px blur, pill badges, a lozenge switch and a glowing accent, and the operator called it childish. It was: that is consumer-app language. Instruments build depth from a background step and a hairline. |

**What deliberately did not change:** the map data palette. The eight category
hex values and the absence of `PointGraphics` are asserted as literal strings in
`globe/invariants.test.ts`. The rule that the only saturated colour belongs to
data is precisely why the chrome went calmer rather than louder.

### 2.0 Checked against Palantir's own material

The palette and chrome were not designed from memory. Two official Palantir
G-Cloud 14 service definition PDFs were downloaded and their embedded UI
screenshots extracted and **pixel-sampled**:

- `801146272055049-service-definition-document-2024-11-26-1253.pdf` (Gotham, 24pp)
- `804537709233305-service-definition-document-2024-11-26-1252.pdf` (Foundry and AIP, 18pp)

**What the sampling found.** The dominant chrome colours in the Gotham Video and
Graph screenshots are `#30404D`, `#293742`, `#202B33`, `#394B59` and accent
`#137CBD`. Those are **classic Blueprint** dark-gray4/3/2/5 and blue2, to a
delta of 0. Gotham is built on Blueprint, which Palantir publishes as
`@blueprintjs/colors`.

**So the tokens here are Blueprint's, verbatim.** The current release is 5.1.16,
whose ramp was modernised for contrast and therefore differs from the 2024
screenshots. This design uses the current values, not the ones in the PDFs:

| Role | Token | Blueprint name |
|---|---|---|
| page | `#111418` | black |
| panels | `#1c2127` | dark-gray1 |
| inset, hover | `#252a31` | dark-gray2 |
| raised | `#2f343c` | dark-gray3 |
| edge | `#383e47` | dark-gray4 |
| primary text | `#f6f7f9` | light-gray5 |
| secondary | `#c5cbd3` / `#abb3bf` | gray5 / gray4 |
| muted | `#8f99a8` | gray3 |
| accent | `#2d72d2` | blue3 |
| ok, warn, alert | `#32a467`, `#ec9a3c`, `#e76a6e` | green4, orange4, red4 |

Light surface uses light-gray5/4/3, black, dark-gray1, gray1 and blue2. Every
colour token in both themes is a Blueprint value; verified programmatically, 0
tokens outside the published palette.

**Every UI screenshot in both PDFs was examined**, not a sample. Catalogue:

| Screenshot | Surface | Light or dark | What it contributed |
|---|---|---|---|
| gotham p6 | Browser, object view | light | property list layout |
| gotham p7 | **Object Explorer** | dark | shortcut rail, menu bar, tabs with count badges, property list with mini bars, **filter-path cards**, bottom action bar |
| gotham p8 | Chat | dark | message rows, channel grouping |
| gotham p9 | **Inbox** | light | channel list with collapsible groups, message list with filled-accent selection and unread dots, **entity tab strip with count badges and More overflow**, **change history with date gutter and plus-marked groups**, redaction bars |
| gotham p10 | Slides | light | deck chrome, not adopted |
| gotham p11 | **Dossier** | light | document surface, confirms Gotham is not uniformly dark |
| gotham p12 | Graph | dark | window chrome, classification strip, five labelled toolbar groups, histogram with two sections |
| gotham p13 | **Graph** | dark | **context menu with submenu**, **histogram tree**, panel header and icon bar |
| gotham p14 | **Gaia** | light panel over satellite | tab strip, tree, **map tool cluster top-left**, **status strip**, real basemap |
| gotham p15 | **Video** | dark | transport bar with time ruler and density histogram, left card stack |
| foundry p3, p7 | diagrams | light | not UI |
| foundry p18, gotham p24 | cover art | dark | not UI |

**Component-level parity.** `tmp/redesign/gotham-parity.html` puts each rebuilt
component beside the original crop at a normalised scale, with the measurement
that produced it. Built from the screenshots: the **context menu** (26px rows,
bold section headers, 14px monochrome icon, right submenu chevron, hairline
separators, background-step hover, submenu top-aligned to its parent), the
**histogram tree** (uppercase group with disclosure triangle and right-aligned
total; 22px item rows carrying a type icon, label, monospace fraction and a
two-tone bar on a dark track; selection as an accent outline, not a fill), the
**labelled toolbar groups** (a muted label above each cluster, vertical hairline
dividers, split buttons with chevrons), the **panel header** (title with close,
then a right-aligned icon bar with a rule before search) and the **tab strip**
(icon plus label, accent underline and accent-tinted icon when active).

On scale: the PDF screenshots are themselves a downscale of an unknown capture
width, so a raw 3x of theirs is not comparable to a raw 3x of mine. Both sides
are normalised on a measured component instead. Their context-menu item pitch is
20 image pixels and ours is 26 CSS pixels, so theirs is shown at 3x and ours at
2.3x, which makes the rows the same height on screen.

Gotham runs a row-height to font-size ratio near 2.4, small text in a roomy row.
This design holds a 12px floor, so 26px over 12px (2.17) is as close as it gets
without breaking the accessibility rule. That gap is deliberate and recorded.

**A bug the parity work exposed.** Every inline `<svg>` in these mockups
referenced a 24-unit symbol without a `viewBox`, so each icon rendered only its
top-left 15x15 corner. Every icon in the whole set was silently cropped.
`tmp/redesign/_a11y.py` now injects a `viewBox` on every symbol-referencing
`<svg>` and the fix is unit-tested; 0 remain without one.

**Three structural corrections the screenshots forced**, all of which this
design had wrong:

1. **Gaia's map is a real basemap**, Mapbox Streets and Satellite, with roads,
   place labels and highway shields. Not a stylised dark vector map and
   certainly not a globe.
2. **Gaia's map toolbar is a small horizontal cluster at the top-left of the
   map**, about 30px tall, not a vertical rail down one side.
3. **Gaia carries a thin status strip along the bottom** ("Online · View · 3
   interactive elements"), and the side panel stops above it.

One further finding worth recording because it contradicts a common assumption:
**Gotham is not uniformly dark.** Dossier is a light document surface, Graph and
Video are dark, and Gaia's own side panel is white over the satellite basemap.
The light analytical surface in this design is therefore consistent with the
product, not a departure from it.

### 2.1 Decision

**Direction A, with C's pinning folded in.** The operator's words were "A or C is
fine", and the two compose rather than compete, so this takes A's model and C's
best idea instead of picking one and discarding the other.

- **From A:** four named left panels (Layers, Find, Histogram, Info) as text
  tabs, always visible, each on a number key. Selection, Series and Time
  selection stack in one right column. Apps behind one launcher.
- **From C:** the tab row also carries **panels the operator pins**, so the four
  fixed names never move but the set is extensible. The palette stays a visible,
  labelled control in the bar rather than an invisible keystroke.
- **From B:** the multi-select summary header ("14 selected · 9 military ·
  1 emergency"), which the Select tool needs anyway.

Why A is the base and not C: the brief puts ease of navigation above prettiness,
and A is the only direction where every panel has a name, a permanent position
and a single key. C's ceiling is higher for someone who already knows the
product, but its floor is a map and a search box. Pinning gives A most of C's
ceiling at no cost to its floor.

B is not carried forward as a shell. Its verb grouping (Watch, Find, Understand,
Decide, Build) remains the right way to group the **app launcher**, and that is
where it lands.

The three direction mockups stay in `tmp/redesign/` as the record of what was
compared. None is deleted.

### 2.2 Non-negotiables, whichever direction wins

1. The globe is the substrate. It mounts once, never unmounts, and no permanent
   chrome covers it.
2. The palette indexes everything: 14 apps, 9 routes, 18 panels, 64 layers, 7
   tools, every setting, live entities, saved searches.
3. One keyboard registry, one `?` sheet generated from it, one documented Escape
   order.
4. The reference panel grammar, named: left **Layers · Find · Histogram · Info**;
   right **Selection · Time selection · Series**; toolbar **Select · Search
   around · Draw · Capture · Measure · Annotate · Delete**.
5. Four states per surface: loading, empty, error, **degraded**.
6. Foundry works like Foundry, on a light surface.
7. The copy rules hold (§7).

---

## 3. The layout

```
┌─ 48px  Velocity · Find ⌘K · Apps ▾ · area ▾ ······ alerts · stats · UNCLAS ─┐
│ 336px                    │                          │  384px               │
│  Layers Find Histogram   │                          │  Selection           │
│  Info      (text tabs)   │      G L O B E           │  Series              │
│                          │      never unmounts      │  Time selection       │
│                          │      7-tool toolbar      │                      │
│                          │   ┌─ time dock ⌃ ─┐      │                      │
└──────────────────────────┴───┴───────────────┴──────┴──────────────────────┘
```

Two grid rows instead of four. The classification band becomes an inline pill in
the bar; the timeline becomes a dock floating over the map, collapsed by default
and expanded with `t`.

Full-screen apps keep the existing `chrome: 'full'` path in `state/appView.ts:50`
and gain the light token set. `⇧Esc` returns to the map.

---

## 4. Re-homing

Every surface has a home. The complete row-by-row inventory (64 layers, 14 apps,
18 rail items, 9 routes, 10 other surfaces) is `tmp/redesign/rehoming.html`;
per-direction click depths are in `tmp/redesign/00-index.html`. The pattern:

**Left panels absorb the rail.** `layers` + `allsources` merge into one **Layers**
panel keeping `LayerRail`'s health dots, live counts, opacity and four mission
presets *and* `LayerCatalog`'s folders, and finally exposing `setTimeWindow` plus
a per-layer **loading method** (Auto · Tile · Object). `search-objects` +
`chokepoints` + `extract` + `countries` merge into **Find**, behind one input
that sniffs its own content: a string parsing as DD, DMS, MGRS or UTM flies
there, anything else searches objects. `filters` becomes **Histogram** under its
real name. `feeds` + `ops` + `field` + `SysStats` + `MapHealthStrip` become
**Info**.

**Right panel is selection context.** `EntityPanel`'s 27 blocks keep their order
inside **Selection**; **Time selection** carries range, current timestamp, View
latest, time zone and auto-pause; **Series** is new.

**Tools become tools.** `annotate` and `watch` leave the rail for the toolbar.
Capture gains a map entry point it has never had. Delete is new. Select gains
invert, select-all-in-view and a multi-select summary.

**Applications stay applications**, full screen over the globe. The four `uiMode`
overlays (`tasking`, `targeting`, `fmv`, `cop`) fold into the apps that own them
and the parallel mode concept goes away.

**Settings becomes a place**, absorbing the eight preferences outside
`state/settings.ts` today: `velocity.theme`, `velocity.dashboardMode`,
`csl.rightW`, `csl.leftW`, `velocity.appView`, `velocity.openModeDismissed`,
`velocity.captures`, and the in-memory `uiMode`.

**Deleted:** `rightTabs`, `leftTabs`, and the `overlayLeft` dead slot. The mobile
chooser reads the same panel registry as desktop.

### 4.1 Layers, specifically

64 registered layers (`registry/defaults.ts`, 55 literal + 9 generated at
`:731-753`), 6 on by default. The curated catalog is **7 folders, 53 rows**
covering 61 ids with 3 hidden (`normal/layerCatalog.ts:159`).

> Correction for the reference doc: `docs/palantir-reference-2026-07.md:503-504`
> says 52 rows. It is 53. Four declared groups carry zero layers and should be
> removed or filled: `rf`, `signals`, `seismic`, `imagery`
> (`packages/shared/src/layer.ts:5-19`).

The most load-bearing line in the reference (§2) is that Palantir's answer to too
many objects is not a faster renderer, it is *changing what you load per layer
based on how much there is*. The measured evidence agrees: the largest layer on
screen was **NASA FIRMS at 14,818 fire detections**, an off-by-default long-tail
layer costing exactly what the primary feed costs
(`docs/perf-results-2026-07-27.md:186-206`). The Layers panel therefore surfaces
a per-layer loading method and flags the largest layer in view. Building the
loader behind it is a separate, measured decision.

---

## 5. Components to build

`shell/instruments.tsx` (422 lines, 79 importers) covers **display** atoms and
survives, restyled. The missing half is **form and interaction** atoms.
Specified in `tmp/redesign/components.html`:

| Primitive | Today |
|---|---|
| `Tooltip` | does not exist; every hover explanation is a native `title=` |
| `Select`, `Tabs`, `Field`, `EmptyState`, `FilterChips` | exist **only** inside `foundry/ui.tsx`, not shared |
| `Input`, `Checkbox`, `Radio`, `Slider`, `Table`, `Menu`, `Pagination`, `Skeleton` | do not exist at the shared layer |

Two consolidations come with it: `country/shared.tsx` (0 external importers) is
absorbed or deleted, and `foundry/ui.tsx` re-exports from the shared layer.

**The 12px floor holds.** New and touched components use `--fs-cap` /
`--fs-dense` / `--fs-body` rather than inline `text-[Npx]`. The 780 existing
sub-11px literals are a sequenced cleanup, not a prerequisite.

---

## 6. Keyboard

One registry file. The `?` sheet is generated from it. Full table in
`tmp/redesign/states.html`; the shape:

- **Global** — `⌘K` palette · `?` shortcuts · `⌘,` settings · `⌘J` analyst
  console · `/` focus find · `Esc` dismiss topmost.
- **Navigation** — `1`-`4` the four left panels · `⌘1`-`⌘9` apps · `⇧Esc` back to
  the map · `⌘B` / `⌘⇧B` collapse panels · `a` alerts · `i` inbox.
- **Map tools** — `h` `v` `r` `d` `c` `m` `n` `⌫` · `g` `c` `2` scene mode.
- **Time** — `space` · `[` `]` · `,` `.` · `l` view latest · `t` toggle the dock.
- **Selection** — `⌘A` · `⌘I` · `⌘⇧A` · `f` flag · `⌘⇧F` follow.
- **Lists and editors** — `j` `k` `g` `G` `e` · `⌘Z` `⌘⇧Z` · `⌘↵`.

**Escape has one handler and one order**, replacing four independent ones:
first-run gate (does nothing) → modal or slide-over → dropdown or context menu →
full-screen app (returns to the map) → active map tool (returns to Pan) →
selection (clears). The order is the existing z-scale in `theme/tokens.css:85-100`.

`space`, `[`, `]`, `f`, `g`, `c`, `2` are already specified in
`docs/frontend.md:148` and were never bound.

---

## 7. Copy and states

The voice rules are already law (`CLAUDE.md`, `docs/decisions.md:1137+`) and are
inherited unchanged: no em dashes in dashboard copy; ` · ` separators in
subject-first order; a lone `—` means "no value reported" and is guarded by
`entity-panel/placeCards.test.tsx`; errors are sentences that keep the code
(`Cameras unavailable (HTTP 503)`, never `cams 503`); lowercase micro-labels
(`loading…`) stay; trace a string to a render before rewriting it.

**The one addition is a fourth state.** `docs/frontend.md:147` requires loading,
empty and error to be distinct, and `layer-rail/OpsPanel.test.tsx:34` guards it.
Both persona waves still found silent failure, because the real case is
**degraded**: the surface has some data and is quietly missing the rest. A vessel
count that reads low because one of two sources is wedged must say so.

---

## 8. Where this lands in `apps/web/src`

| Work | Files |
|---|---|
| Token rewrite | `theme/tokens.css` values change; names do not. A `.light` scope (or `data-theme` at the app-surface level) drives the analytical apps |
| Shell rebuild | `shell/ConsoleShell.tsx` goes from 4 grid rows to 2; classification moves into `command-bar/CommandBar.tsx`; the timeline footer becomes `timeline/TimeDock.tsx` |
| Panel registry | new `shell/panels.ts`; `App.tsx:156-222` deleted; `ConsoleShell.tsx:225-233` reads the registry |
| Four left panels | `shell/LeftIconRail.tsx` replaced by a text tab strip; `layer-rail/LayerCatalog.tsx` + `layer-rail/LayerRail.tsx` merge; new `find/FindPanel.tsx`; `explorer/HistogramPanel.tsx` renamed in the UI only; new `info/InfoPanel.tsx` absorbing `FeedsPanel`, `OpsPanel`, `CommandBar.tsx:224` `SysStats`, `ConsoleShell.tsx:483` `MapHealthStrip` |
| Three right panels | `entity-panel/ObjectInspector.tsx` gains compact mode and the multi-select header; new `series/SeriesPanel.tsx` reading `/api/history/tracks`; time controls split out of `timeline/Timeline.tsx` |
| App launcher | new `shell/AppLauncher.tsx`, replacing `shell/AppSwitcher.tsx` |
| Seven tools | `globe/GlobeToolbar.tsx` and `globe/mapTools.ts` gain `select`, `around`, `capture`, `delete`; `globe/draw.ts` modes exposed directly rather than through the annotation kind picker |
| Multi-select | `state/stores.ts:42` `useSelection` widens from one id to a set, single-id read kept for compatibility |
| Palette index | `command-bar/Omnibar.tsx` sources from `shell/panels.ts`, `state/appView.ts:30`, `registry/LayerRegistry`, `globe/mapTools.ts`, `state/settings.ts` |
| Keyboard registry | new `shell/keys.ts`; the 12 `keydown` sites collapse into it; new `shell/ShortcutSheet.tsx` |
| Primitives | new `shell/ui/`; `foundry/ui.tsx` re-exports; `country/shared.tsx` absorbed |
| Settings as a place | `settings/SettingsModal.tsx` becomes `settings/SettingsApp.tsx`; the 8 stray localStorage keys move behind `state/settings.ts` |
| Foundry | light surface; `foundry/nav.ts` gains `health`, `lineage`, `analysis`; new `foundry/HealthView.tsx`, `LineageView.tsx`, `AnalysisView.tsx` |

**Not touched:** `globe/adapters/styles.ts`, `globe/adapters/PollGeoJsonAdapter.ts`,
`globe/GlobeCanvas.tsx` viewer options, `globe/adapters/deadReckon.ts`, the
Foundry backend, `apps/api` in general.

---

## 9. Guards, including the two this redesign deliberately changes

A guard failure means an operator decision regressed. Fix the code, or revoke the
decision deliberately by changing **both** the guard and `CLAUDE.md`.

**Must keep passing, unchanged:**

- **`globe/invariants.test.ts` scans source text, not behaviour.** `styles.ts`
  must literally contain `#facc15 #2dd4bf #c084fc #93c5fd #f59e0b #ef4444
  #14b8a6 #d97706` and must not contain `PointGraphics`. `GlobeCanvas.tsx` must
  contain `requestRenderMode: true`, `maximumRenderTimeChange: 0`, and the exact
  five-visualizer callback. `PollGeoJsonAdapter.ts` must not contain
  `.removeAll(`. Every `new WebSocket(` must have `withWsKey(` within 250
  characters.
- **`entity-panel/placeCards.test.tsx`** pins exact rendered strings and the lone
  `—`.
- **`layer-rail/OpsPanel.test.tsx`** pins the three-states rule.
- **`state/appView.test.ts`** requires `APP_GROUPS` to cover every `AppId` once.
- **ESLint** bans raw `fetch` outside `src/transport/**` and bans `removeAll` in
  `PollGeoJsonAdapter.ts`.

### 9.1 Contrast, measured

The palette was solved against `theme/contrast.test.ts` rather than around it,
and computing it caught a real failure in the light surface. Every `--txt-*`
tier, worst case across `--bg-1` and `--bg-2`:

| Tier | Dark | Light |
|---|---|---|
| `--txt-0` | 16.11 | 16.54 |
| `--txt-1` | 11.69 | 9.35 |
| `--txt-2` | 8.08 | 5.25 |
| `--txt-3` | 5.36 | 4.64 |
| `--txt-4` | 5.36 | 4.64 |

All clear the 4.5:1 floor and the muted ramp stays monotonic in both themes.
The light `--txt-3` started at `#66738a`, which measured **4.26:1 on `--bg-2`**
and would have failed the guard; it is `#616d83`. Over the map, where panels are
translucent glass, the worst case is the brightest ocean gradient point showing
through at 14%, which computes to 5.62:1 for `--txt-3`.

### 9.2 Keyboard and semantics, measured

These were asserted first and then measured, which is the wrong order and it
showed: the first pass claimed every primitive was keyboard reachable while the
mockups used `<div>` and `<span>` for rows, chips, switches and the whole map
toolbar. Measured in a browser, that was **76 unreachable controls on the map
console alone**, and 8 toolbar tools whose only name was a `title` attribute.

The mockups now demonstrate the contract rather than asserting it
(`tmp/redesign/_a11y.py` performs the upgrade and the generator applies it):

| Element | Was | Now |
|---|---|---|
| Map tool | `<div title>` | `<button aria-label>` |
| Layer switch | `<span class="toggle">` | `<button role="switch" aria-checked>` |
| Filter chip | `<span class="chip">` | `<button aria-pressed>` |
| Layer row | `<div>` | focusable; rows owning a switch become `role="group"` and focus moves to the label, so a control is never nested inside another control |
| Palette result | `<div>` | `role="option" tabindex="0"` |
| Status dot | `<span>` | `aria-hidden`, the adjacent word carries the meaning |

Measured across all nine pages: **0 text nodes below 12px, 0 unreachable
controls, 0 focusable elements without an accessible name.** The map console has
98 focusable controls, the panel gallery 116.

Remaining commitments, to hold during implementation:

- Focus is always visible: `2px solid var(--accent)` at a 3px offset.
- The link-analysis canvas is mouse only today and must gain keyboard traversal.
- `prefers-reduced-motion` disables the selection pulse, makes camera slew an
  instant set, and removes fades.

**Deliberately revised, with the decision recorded here:**

- **`theme/contrast.test.ts`** parses `tokens.css` and requires every `--txt-*`
  to clear 4.5:1 against both `--bg-1` and `--bg-2` in **both** themes, with the
  muted ramp monotonic. The new palette was solved against this constraint, not
  around it: on the dark surface `--txt-3: #808D9E` measures **4.89:1 on
  `--bg-1`** and **4.55:1 on `--bg-2`**. The guard does not change; only the
  values it reads do, and it is the first thing to run.
- **`shell/ConsoleShell.test.tsx`** asserts five zones and a literal **158px**
  footer row. The redesign removes the classification band row and the permanent
  footer, so this guard **must be rewritten** as part of the shell work, not
  deleted. The replacement asserts: two grid rows, the globe mounted exactly
  once, the time dock present and collapsible, and `fullBleed` keeping hidden
  regions mounted.

Gate: `bash scripts/verify.sh` green, `pnpm -r typecheck` at every commit
boundary, backend baseline at or above **2141 passed + 2 skipped**.

---

## 10. Foundry

Foundry is not a stub: five views (`foundry/nav.ts:8`), 11 dataset detail tabs,
deep links via `?fv=&fid=&ftab=`, and a real backend (`apps/api/app/foundry/`:
transforms, sqlrun, scheduler, monitors, checks, binding, geo, ingest, builds,
store, seed, with 14 test modules).

It gets the **light surface**, and three additions
(`tmp/redesign/foundry.html`):

1. **Health** — checks promoted out of a per-dataset tab into one surface that
   answers "what is broken right now": freshness, row delta, null rate, schema
   drift, quarantine count, and a pass/fail history strip per dataset. A dataset
   that has never built shows `—` in every measured column, never a confident zero.
2. **Lineage** — the whole chain in one graph, upload → transform → build →
   ontology → map layer, so a wrong number on the globe walks back to the upload
   that produced it. Today lineage is a tab inside one dataset.
3. **Analysis** — the reference draws Palantir's split as dataset-versus-object,
   not chart type: Contour is tabular and top-down (a chain of boards, each one
   step), Quiver is object and time series. Velocity has neither. The series
   workbench shares its implementation with the map's Series panel: one
   component, two homes.

**Fences, already decided.** Multi-tenant ACL and MLS, distributed compute,
streaming CDC, and connector catalogues are out of scope
(`docs/decisions.md:298`, `docs/foundry-gap-analysis-2026-07-08.md:105`,
`docs/roadmap-ontology-2026-07.md` §6). Re-opening any needs a new decision.

**Do not design from the stale scorecard.** `foundry-gap-analysis-2026-07-08.md`
predates the 2026-07-09 hardening wave (`docs/decisions.md:292-331`), which
closed several of its rows including row-level quarantine, dead-letter,
non-lossy ingest, regex safety, and ontology auto-sync after every version.
Re-verify each gap against current source before building a panel for it.

---

## 11. Open questions for the operator

1. **Direction.** A recommended; B and C are built and openable.
2. **Light for which apps.** The spec puts Foundry, Workflows and Explorer on the
   light surface. Graph, Reports and Country are arguable either way.
3. **Per-layer loading method** (Auto · Tile · Object). The Layers panel exposes
   the control; building the loader behind it is a measured piece of work, and
   FIRMS at 14,818 entities is the case that justifies it.
4. **Scope of the sub-11px cleanup.** 780 literals. New work holds the floor
   regardless; sweeping the rest is a separate sequenced pass.
5. **`/2d`, `/studio`, `/news` as routes.** Kept as routes here. Folding them
   into apps is possible but changes existing deep links.

---

## 12. Verification of the mockups themselves

- Static files opened with `file://`. No server, no network, no script tags.
  `mock.css` is a relative link, which is not a network fetch. Verified: zero
  console errors and zero failed requests on all seven pages.
- The map data palette in the mockups is the guarded palette from
  `globe/adapters/styles.ts`, kept as a deliberately separate colour system.
- Contrast for the new chrome palette was computed by hand against the rule
  `theme/contrast.test.ts` enforces, before the mockups were drawn.
- Copy rules checked mechanically: no ` — ` anywhere; em dashes appear only as
  the lone `—` meaning "no value reported", plus one deliberate wrong-example row
  in `components.html`.
