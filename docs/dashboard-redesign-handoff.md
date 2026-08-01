# Dashboard redesign — handoff

**State:** mockups and spec complete, direction chosen, no production code written.
**Next actor:** whoever implements it, or whoever wants to change the direction first.

---

## What this is

A from-scratch redesign of the Velocity dashboard, mockup-first, built against
`docs/palantir-reference-2026-07.md` and against Palantir's own published
material. The brief was **ease of navigation and use over prettiness**.

The problem it solves is not a missing feature. It is that 41 entry points
compete (14 in-console apps, 18 left-rail items, 9 routes), the ⌘K palette
indexes **zero** of them, twelve separate `keydown` listeners own the keyboard
with four of them binding Escape, and two persona waves independently reported
capability that is *"reachable but invisible"*.

---

## Where everything is

| Path | What |
|---|---|
| `docs/dashboard-redesign-2026-08.md` | **The spec.** 568 lines. The only committed artifact. Decision, departures, re-homing, keyboard registry, file mapping, guards. |
| `tmp/redesign/00-index.html` | The board. Start here. Three directions side by side, comparison table, click depths. |
| `tmp/redesign/a-panel-parity.html` | Direction A, the chosen one. |
| `tmp/redesign/b-verb-first.html` | Direction B, retained. |
| `tmp/redesign/c-palette-first.html` | Direction C, retained. |
| `tmp/redesign/panels.html` | All seven Palantir panels at fidelity. |
| `tmp/redesign/foundry.html` | Foundry on the light surface, plus Health, Lineage and Analysis. |
| `tmp/redesign/gotham-parity.html` | 8 components beside the real Palantir crops. |
| `tmp/redesign/rehoming.html` | Every surface mapped: 64 layers, 14 apps, 18 rail items, 9 routes. |
| `tmp/redesign/states.html` | Four states per surface, Escape order, 39 keyboard bindings. |
| `tmp/redesign/components.html` | Token sheet and the primitives that must be built. |

> **`tmp/` is gitignored.** Only the spec is committed. This is exactly how the
> previous mockups this codebase was built from (`tmp/mock.css`, `tmp/power.css`,
> still cited at `shell/instruments.tsx:4`) were lost. Copy `tmp/redesign/`
> somewhere durable before cleaning the tree.

### Regenerating

`_build.py` generates the three directions and the panel gallery from one source
of panel HTML; `_parity.py` generates the parity page; `_a11y.py` post-processes
everything. Output is plain self-contained HTML needing no build step to view.

```
cd tmp/redesign
python3 _build.py && python3 _parity.py
python3 _a11y.py 00-index.html components.html states.html rehoming.html foundry.html
```

---

## What was decided

**Direction A, with C's pinning folded in.** The operator said "A or C is fine",
and the two compose rather than compete.

- From A: four named left panels (Layers, Find, Histogram, Info) as text tabs,
  always visible, each on a number key. Selection, Series and Time selection
  stack in one right column. Apps behind one launcher.
- From C: the tab row also carries panels the operator pins, so the four fixed
  names never move but the set extends. The palette is a visible labelled
  control, not an invisible keystroke.
- From B: the multi-select summary header, which the Select tool needs anyway.
  B's verb grouping survives as the grouping of the **app launcher**.

B is not carried forward as a shell. All three mockups are retained as the record
of what was compared.

---

## What was proven, and how

Everything below was measured, not asserted.

- **Palette is Palantir's own.** Two official G-Cloud 14 service definition PDFs
  were downloaded, their embedded UI screenshots extracted with `pdfimages` and
  pixel-sampled. Gotham's chrome measures `#30404D`, `#293742`, `#202B33`,
  `#394B59`, accent `#137CBD` — classic Blueprint at delta 0. Every colour token
  in both themes is now a verbatim `@blueprintjs/colors` 5.1.16 value; 0 tokens
  outside the published palette.
- **Contrast.** Dark 13.47 / 8.84 / 6.83 / 5.01 / 5.01; light 16.03 / 14.06 /
  4.70 / 4.70 / 4.70. All clear 4.5:1, ramp monotonic. This caught a real defect:
  the light `--txt-3` was 4.26:1 and would have failed `theme/contrast.test.ts`.
- **Accessibility.** 10 pages: 0 text nodes below 12px, 0 keyboard-unreachable
  controls, 0 focusable elements without an accessible name. First measurement
  found **76 unreachable controls** and 8 tools named only by a tooltip.
- **Icons.** Every inline `<svg>` referenced a 24-unit symbol without a
  `viewBox`, so each icon rendered only its top-left 15×15 corner. Every icon in
  the set was silently cropped until this was found. Fixed in `_a11y.py`, unit
  tested, 0 remain.
- **Inventory.** 64 layers, 14 apps, 18 rail items, 9 routes, extracted from
  `registry/defaults.ts`, `normal/layerCatalog.ts`, `state/appView.ts:30`,
  `App.tsx:179-204`, `AppRouter.tsx:55-65` rather than typed by hand.

---

## Things that will bite you

1. **`shell/ConsoleShell.test.tsx` must be rewritten, not deleted.** It pins five
   zones and a literal 158px footer. Both are gone: the shell goes from four grid
   rows to a 46px bar over an edge-to-edge map, with time as a dock and a 22px
   status strip. The replacement should assert two rows, the globe mounted
   exactly once, and the dock present and collapsible.
2. **`globe/invariants.test.ts` scans source text, not behaviour.** Renaming or
   restructuring can fail it with no behaviour change. `styles.ts` must literally
   contain the eight category hex values and must not contain `PointGraphics`.
   The redesign does not touch map symbology; keep it that way.
3. **`theme/contrast.test.ts` parses `tokens.css`.** Run it first on any palette
   change. The values above were solved against it, not around it.
4. **Foundry's gap analysis is stale.** `docs/foundry-gap-analysis-2026-07-08.md`
   predates the 2026-07-09 hardening wave, which closed several of its rows.
   Re-verify against source before building a panel for a "gap".
5. **`--sp-*` and `--fs-*` had zero and ten consumers respectively.** The new
   scales are used throughout; do not let that regress.
6. The `.gitignore` shows a `+.gstack/` line. That came from the browse tooling
   during this work, not from the redesign.

---

## Open, and genuinely undecided

1. **Which apps go light.** Currently Foundry, Workflows and Explorer. Graph,
   Reports, Country, Markets and Targeting are arguable either way. Worth knowing:
   Gotham is **not** uniformly dark — Dossier is light, Graph and Video are dark,
   and Gaia's own side panel is white over satellite imagery.
2. **Per-layer loading method** (Auto · Tile · Object). The Layers panel exposes
   the control; building the loader behind it is separate, measured work. NASA
   FIRMS at 14,818 entities is the case that justifies it.
3. **The 780 sub-11px literals** in the shipped app: 748 at `text-[10px]`, 31 at
   `text-[9px]`, 1 at `text-[8px]`. New work holds the 12px floor; sweeping the
   rest is a sequenced pass.
4. **`/2d`, `/studio`, `/news`** are kept as routes. Folding them into apps is
   possible but changes existing deep links.

---

## Known not-done

- **The basemap.** Gaia runs Mapbox Streets and Satellite: real aerial imagery
  with roads, place labels and highway shields. The mockup has a hand-drawn
  Baltic coastline with a labelled graticule, scale bar and north arrow. That
  gap closes with a real tile layer in the running app, not in static HTML.
- **Slides, Chat and Foundry's own light analysis chrome** were catalogued from
  the PDFs but not rebuilt, because none maps onto a Velocity surface that
  exists. Rebuilding them would be copying rather than extending the grammar.
- **Gotham's row-height to font-size ratio is ~2.4**, small text in a roomy row.
  This design holds a 12px floor, so 26/12 = 2.17 is as close as it gets. The
  gap is deliberate.
- **The link-analysis canvas is mouse only** and needs keyboard traversal. That
  is implementation work in `graph/InvestigationCanvas.tsx`.

---

## First implementation step

Read `docs/dashboard-redesign-2026-08.md` §8, which maps the design onto real
files. The cheapest high-value change in it is independent of the rest of the
redesign: **make the palette index the product.** `command-bar/Omnibar.tsx`
currently indexes four workspace actions, layer toggles and live entities, and
zero of the 14 apps, 9 routes, 18 rail items or any setting. Sourcing it from a
single `shell/panels.ts` is one index file and it is the largest navigation win
available.

---

## Verifying this handoff

Every path and number above is checkable. Run this from the repo root; it should
print no `FAIL` lines and `780`.

```bash
# every file this document points at
for p in docs/dashboard-redesign-2026-08.md docs/palantir-reference-2026-07.md \
         apps/web/src/shell/instruments.tsx apps/web/src/registry/defaults.ts \
         apps/web/src/normal/layerCatalog.ts apps/web/src/state/appView.ts \
         apps/web/src/App.tsx apps/web/src/AppRouter.tsx \
         apps/web/src/command-bar/Omnibar.tsx apps/web/src/shell/ConsoleShell.test.tsx \
         apps/web/src/globe/invariants.test.ts apps/web/src/theme/contrast.test.ts \
         apps/web/src/graph/InvestigationCanvas.tsx; do
  [ -f "$p" ] || echo "FAIL missing $p"
done

# the guard claims
grep -q 158 apps/web/src/shell/ConsoleShell.test.tsx      || echo "FAIL 158px footer"
grep -q PointGraphics apps/web/src/globe/invariants.test.ts || echo "FAIL PointGraphics"
grep -q tokens.css apps/web/src/theme/contrast.test.ts    || echo "FAIL contrast parse"
grep -q tmp/mock.css apps/web/src/shell/instruments.tsx   || echo "FAIL lost-mockup citation"

# the sub-11px count
grep -rhoE 'text-\[(8|9|10)px\]' apps/web/src --include=*.tsx | wc -l
```

If `tmp/redesign/` is still present, the pages regenerate with:

```bash
cd tmp/redesign
python3 _build.py && python3 _parity.py
python3 _a11y.py 00-index.html components.html states.html rehoming.html foundry.html
```

Last run of the above: all paths resolved, all four guard claims held, count was
**780**, all three generators exited 0, and the ten regenerated pages rendered
with 0 console errors and 0 accessibility violations.
