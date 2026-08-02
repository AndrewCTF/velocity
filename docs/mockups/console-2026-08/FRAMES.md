# Frame analysis of the 2026 product demo

Source: a public conference demo posted to X, 1920x1080, 111.7 s, **3348 frames**
at 29.97 fps.

## Method

The first pass at this was a 4-second skim, 28 frames, of which 6 were read
closely. That is a sample, not an analysis, and it missed roughly half the
states below. This pass:

```
ffmpeg -i pltr.mp4 -vf "select='gt(scene,0.04)'" ...   # 44 scene changes
ffmpeg -i pltr.mp4 -vf "fps=1,tile=6x5"        ...   # 112 frames, 4 contact sheets
```

The scene threshold is 0.04, low enough that a panel opening counts as a change.
The 1 fps tiling exists because scene detection misses states that fade in
rather than cut. Every frame of the 1 fps sample was viewed via the contact
sheets; the 44 scene frames were viewed at full resolution where a sheet was
ambiguous.

**What is taken from it is structural grammar** — layout, control affordances,
information hierarchy, state transitions. No branding, wordmark, symbology,
palette or mission content is reproduced. Everything below is applied to this
repo's own domain.

## The states

| t | State | Devices it carries |
|---|---|---|
| 0-4 s | Analytic choropleth map | graduated-fill polygons, sensor coverage wedges, point markers over the fill |
| 4-17 s | Map product, layer tree open | 3 text tabs (layers / sources / tools), tree with disclosure triangles, per-row status dot and enable badge, basemap chip + overlay count in the footer |
| 17-20 s | Map + selection panel | entity header with type icon, inline label-then-value list, cross-references as blue links, full-width `Actions` button, collapsible sections each with icon + chevron, embedded video preview |
| 20-30 s | Imagery analysis, two-up | left properties column + right image, detection outlines drawn on the image, oblique view |
| 30-36 s | Imagery, context menu on a detection | menu header carrying the detection id and a measurement, verbs incl. measure, nominate, **mark missed detection**, debug toggle |
| 36-46 s | Detection card on a plain surface | (presentation slide, not product UI) |
| 46-52 s | Object-model canvas | typed cards colour-coded by object type, laid out in columns with link lines, one card selected |
| 52-56 s | Model canvas + slide-over, then **empty state** | "no assets proposed", a target glyph, a filled primary action, and a secondary "or you can …" escape |
| 56-70 s | Tasking app, dark map | icon-tab strip, ALL-CAPS panel subject with a live "last refresh" line, filter chip row, map labels as chips, right-edge control strip with a bearing readout |
| 70-76 s | Radius search | circle AOI with a diameter line and its distance label |
| 76-84 s | AI weighting panel | **its own hue**, a grid of removable metrics, half-dial + stepper per metric, "show all", two-verb footer |
| 84-88 s | Top-match card | two entities side by side, attribute row aligned to attribute row, live/simulation footer |
| 88-96 s | Range rings | concentric rings around a point with distance labels |
| 96-102 s | Tasking board + decision dock + Gantt | proposal card with status chip, label-above-value grid, nested sub-cards, footer with the deciding fact; dock with Reject / Re-task / Approve; Gantt with hour columns and a now-line; toast on success |
| 102-104 s | **Dock resolves** | Reject disappears, primary turns green and restates in the past tense, card chip goes proposed to approved |
| 104-112 s | FMV player | own compact menu bar, red live-mode indicator, tag button, centred timestamp, transport with date+time inputs, symmetric skip controls, red live button, ruler with :30 ticks, playhead chip |

## What was built, and what was not

| Device | Status |
|---|---|
| Panel subject in caps + live refresh line | built — `.ptitle` |
| Icon tab strip, filter chip row | built — `.itabs`, `.chiprow` |
| Proposal card: status chip, label-above-value, sub-cards, deciding footer | built — `.wcard`, `.mkv`, `.subcard` |
| Decision dock, Reject / Re-task / Approve | built — `.ddock-h` |
| **Dock resolves: reject leaves, primary turns green, past tense** | built — `.btn.done`, shown as the second dock on `32-decide.html` |
| Gantt, hour columns, now-line | built — `.gantt` |
| Toast on the surface that changed | built — `.toast` |
| Map labels as chips | built — `.lbl` |
| Bearing readout | built — `.compass` |
| Distinct hue for model output | built — `.ai-surface` |
| Half-dial + stepper | built — `.dial`, `.stepper` |
| **Match card, attribute row aligned to attribute row** | built — `.match` |
| Empty state with a primary **and a secondary escape** | built — `.state .esc` |
| Radius AOI with a diameter label | built and placed — `.aoi-circle` on `14-map-find.html` |
| Concentric range rings | built and placed — `.rings` on `14-map-find.html` |
| Choropleth + coverage wedges | **not built.** The map here is a live contact picture, not a modelled-risk surface, and inventing a risk model to have something to shade would be fiction. It belongs with a real detector score per cell. |
| Detection outlines drawn on imagery | **not built** as a static mockup. `24-video.html` draws detection boxes on the sensor frame, which is the same device on the surface this product actually has. |
| Context menu with "mark missed detection" | **partly.** `14-map-find.html` has the cascading menu; the missed-detection verb needs a detector-feedback loop that does not exist in this repo. |
| Object-model canvas with typed cards | **covered by an adjacent surface.** `27-foundry.html` draws the transform DAG and `20-graph.html` the link canvas; a third node-and-edge surface would be a duplicate, not a gap. |
| Layer tree with disclosure triangles | **styled, not placed** — `.tree` exists; `10-map.html` still renders flat groups. The tree matters when layers nest under an operation, which this repo's registry does not model yet. |

Five of the twenty-one devices are honestly incomplete and named above rather
than quietly dropped. Three of those are deliberate: they need data this repo
does not have, and drawing them anyway would be a picture of a capability
rather than a specification for one.
