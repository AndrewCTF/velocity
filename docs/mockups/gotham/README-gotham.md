# Gotham-grammar console · what was added 2026-08-01

Extends the existing `tmp/redesign/` set. Nothing here replaces the earlier
mockups; `00-index.html` and the three direction pages are untouched.

## Open these

| File | What |
|---|---|
| `gotham-console.html` | **The console.** Direction A rebuilt with Gotham's structural grammar. |
| `gotham-compare.html` | **The four-axis comparison.** Pixel, language, design, professionalism, each with its evidence. |
| `gotham-loading/empty/error/degraded.html` | The four states, same console with one region swapped. |

## Why this exists

The earlier mockups matched Gotham's *palette* exactly (Blueprint 5.1.16,
verified, 0 tokens outside the published ramp) and still read as a web app,
because the gap was never colour. It was structure: no menu bar, no window
chrome, no count badges, no sentence-form action bar, no status strip, and rows
that were 30% too tall.

## The measurement that made comparison possible

Gotham is Blueprint, and Blueprint publishes `$pt-button-height: 30px`. The two
accent-filled buttons in `_ref/oe-full.png` both measure **19px**, so that
screenshot sits at **19/30 = 0.633** of true scale and its 1161px width is an
1834px viewport, i.e. a 1920 screen. Every raw measurement divides by 0.633.

Nine independent measurements then land on published Blueprint control sizes,
which is the confirmation the factor is right. Full table in
`gotham-compare.html`, method in `_calibrate.py` and `_measure.py`.

**The correction this forced.** The earlier work used 26px rows and recorded the
density gap against Gotham as deliberate, believing the 12px floor forbade
matching it. Gotham's dense row is **20px**, and Blueprint pairs
`$pt-button-height-smaller: 20px` with `$pt-font-size-small: 12px`. The floor and
Gotham density were never in tension.

## Regenerating

```bash
cd tmp/redesign
python3 _gotham.py       # console + the four states
python3 _compare.py      # the four-axis comparison
npm install playwright-core   # once; uses the cached ms-playwright chromium
node _verify.mjs         # the gate, see below
```

`_verify.mjs` measures rather than asserts, because the same claims were made
about the earlier mockups and two were false when finally checked (76
keyboard-unreachable controls, every icon cropped). It checks, in a real browser:
0 text nodes below 12px, 0 focusables without an accessible name, 0
keyboard-unreachable controls, every symbol-referencing `<svg>` has a `viewBox`,
0 console errors, no horizontal overflow, and all six structural metrics against
the measured reference. Last run: **all checks passed**, 88 focusable controls on
the console.

## The corpus

`_corpus/` is 115 pages of Palantir's own published Gotham documentation, 34,119
words, scraped by `_scrape.py`. `palantir.com/docs` is server-rendered, so a
plain `urllib` GET returns the prose; `docs/sitemap.xml` lists every URL.

It is the evidence for the language axis. The three findings that mattered:

1. **3 em dashes in 34,119 words.** Velocity's no-em-dash rule was an
   independent operator decision. Palantir writes the same way.
2. **Velocity already uses Palantir's nouns.** "An Observation is a data
   container for the most granular unit of data that can be stored in Geotime."
   "A Track is a collection of Observations of the same entity over some period."
   Velocity's `ObservationStore` and `tracks.ts` name the same two concepts the
   same way.
3. **The action bar renders the query as English.** Palantir's query vocabulary
   is `eq · and · or · not · keyword · lt · gt · lte · gte · geoPointWithin`, and
   Object Explorer prints it as "Keeping Objects with property types matching any
   of _Marital Status_" with the operator's choices as underlined tokens. That is
   the single most-copied-wrong device in the product, and it is now built.

## Files

```
gotham-console.html      the console
gotham-compare.html      the four-axis comparison
gotham-{loading,empty,error,degraded}.html
gotham.css               structural grammar, layered on mock.css
_gotham.py               generates the console + states
_compare.py              generates the comparison
_verify.mjs              the browser gate
_measure.py              band / pitch / colour measurement of _ref/ crops
_calibrate.py            derives the 0.633 capture scale
_scrape.py               builds _corpus/ from palantir.com/docs
_corpus/                 115 pages, 34,119 words
_crops/                  regions cut from the render for side-by-side
_shots/gotham-*.png      renders at 1834x1032
```

## Still open

- The basemap is drawn, not tiled. Gaia runs real Mapbox imagery; that gap
  closes in the running app, not in static HTML.
- Nothing under `apps/` has changed. The file mapping is §8 of
  `docs/dashboard-redesign-2026-08.md`.
- Velocity's filter primitives are unnamed. Adopting Palantir's query vocabulary
  would let one sentence renderer serve every panel.
- Blueprint v6 moved the radius from 2px to 4px. This builds v5's 2px because
  the screenshots are v5-era. Tracking current Blueprint instead is a deliberate
  decision with a visible consequence.

> **`tmp/` is gitignored.** This set is one `git clean` from gone, the same way
> `tmp/mock.css` and `tmp/power.css` were lost while still being cited at
> `shell/instruments.tsx:4`. Copy it somewhere durable before cleaning the tree.

---

## What is NOT in this directory, and why

This repo is public, so the Palantir-derived material is deliberately left out:

- `_ref/oe-*.png`, `graph-*.png`, `inbox-*.png`, `gaia-*.png`, `video-transport.png`
  are Gotham UI screenshots extracted from Palantir's G-Cloud 14 service
  definition PDFs.
- `_corpus/` is 115 pages / 34,119 words of Palantir's published Gotham
  documentation, scraped by `_scrape.py`.

Both are third-party copyrighted material. `.gitignore` already excluded
`Palantir_Gotham_*.pdf` for the same reason, so this follows an existing decision
rather than making a new one.

**Consequences.** `gotham-compare.html` will show broken images on its
Palantir side, and `_measure.py` / `_calibrate.py` have nothing to measure.
Everything else, including all five console pages and `_verify.mjs`, works
standalone.

**To restore them locally:** re-run `python3 _scrape.py` for the corpus (it needs
only the stdlib and `docs/sitemap.xml`), and re-extract the crops from the two
G-Cloud PDFs named in `docs/dashboard-redesign-2026-08.md` §2.0 with `pdfimages`.

The four files in `_ref/` that ARE committed (`app-map.png`, `rail-layers.jpeg`,
`inspector-selection.jpeg`, `app-foundry.png`) are screenshots of Velocity's own
shipped app, not Palantir's.
