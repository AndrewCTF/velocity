# Velocity console, 2026-08

Twenty-one pages, one grammar, measured against Palantir Gotham.

Open `00-index.html` over `file://`. No server, no network, no build step.

```bash
node _icons.mjs                  # once, or when the icon list changes
python3 _build.py                # all 21 pages
node _gate.mjs --shots           # the gate, in real Chrome, plus screenshots
```

## Why this set replaces `tmp/redesign/`

The operator's verdict on the previous set was that it read as a cheap
imitation. Four things were wrong with it, and each one is now a check that
fails loudly rather than a claim in prose.

| Complaint | What was actually wrong | What is here |
|---|---|---|
| "why do the UI have to have so many icons, they're just emojis" | The app has **190 emoji-as-icon sites across 63 files**. `✕` alone appears at **27**. Meanwhile `apps/web/src/normal/Icon.tsx` is a 48-name registry backed by 46 lucide imports, and `lucide-react` is already a dependency. | **131 real SVG symbols**, extracted from lucide-react's own path data by `_icons.mjs` into `_sprite.svg`. **897 icon uses across the set, zero emoji.** Gate 1. |
| "stop just showing me numbers, I want graph" | The Layers panel renders `ON` / `OFF` and `3/4` with no mark anywhere. Gotham's Histogram puts a bar on **every** row, carrying filtered share as well as magnitude. | **208 marks.** Every count sits inside a `.mark` with a bar, sparkline, dot matrix or meter beside it. Gate 3. |
| "I want my images" | 18 image surfaces already exist in the app, none of them on the surfaces Gotham puts pictures on: object lists and graph nodes. | Every object card carries a thumbnail, using the app's own silhouettes from `globe/icons.ts`. Gate 4. |
| "the replay feature is so bad, so hard to rewind" | One hardcoded number. See below. | The full transport from `tmp/palantir/parts/video-transport.png`, and a strip that spans the loaded range. |

Plus the basemap: the previous set drew its coastlines. This one uses **real
Carto dark-matter raster tiles**, the same source `apps/api/app/routes/tiles.py:138`
proxies, pre-fetched into `_tiles/` so `file://` still works offline. Gate 2.

## The replay finding

`timeline/Timeline.tsx` is far more complete than it looks. It already has a
draggable pointer-capture scrubber (`:335-388`), keyboard transport
(`:460-521`: space, arrows, `,`/`.`, `L`), clickable event lanes (`:765-796`),
auto-pause at events, and a coverage heat-strip.

It feels uncontrollable because of one line:

> `Timeline.tsx:262` requests `/api/timeline/density?window_sec=72000` — a fixed
> 20 hours. `playPct` (`:401-405`), `timeAtX` (`:327-333`), both seek buttons
> (`:566`, `:588`) and the keyboard clamp (`:473`) all read from
> `density.from/to`. **So during a 3d, 7d or past-day replay the playhead pegs
> at 0 % and the strip cannot reach the data that is playing.** The route
> accepts 72 h (`routes/timeline.py:33`); nothing asks for it.

`12-map-replay.html` is the build contract for fixing that. Four further
defects are drawn into it:

1. The range label always prints `now − replayWindow` even after a dragged span
   or a day load (`:729` vs `:179-196`, `:214-230`). Here the footer states the
   loaded range.
2. Window presets and the date input are `disabled={replay.active}` (`:637`,
   `:660`), so you must exit replay to change window.
3. The keyboard bindings have no on-screen equivalent. The ±15s and frame-step
   buttons drawn here need no new logic; the step function is at `:467-476`.
4. `App2D.tsx:38` renders `<Timeline />` with no viewer, so replay is inert in
   the 2D app.

## The pages

| | |
|---|---|
| `00-index.html` | the board |
| `01-kit.html` | every primitive at 1:1, with the measurement that produced it |
| `10` to `15` | map console: live, selected, replay, histogram, find, info |
| `16-states.html` | loading, empty, error, **degraded**, four up |
| `20` to `31` | the twelve analytical apps |

The app list is `AppId` from `apps/web/src/state/appView.ts:14-28`, so the set
covers every app exactly once. What each panel contains is predicted from
`docs/palantir-reference-2026-07.md` §11, which walks 23 Palantir panels.

## What a live demo of the product changed

The set was first measured against 2024 marketing PDFs. A 2026 conference demo
shows the shipping product, and it carries devices those captures never did.
Applied here to this repo's own domain, with its own content, symbology,
palette and identity:

| Device | Why it earns its place |
|---|---|
| **Panel title as an ALL-CAPS subject with a live state line** (`COLLECTION QUEUE` / `Last refresh 4 s ago · Refresh`) | A panel that states its own freshness is instrumented. One that just says "Layers" is furniture. |
| **Icon tab strip + filter chip row** at the top of a panel | Sibling views and scope filters are one row each, above the content, instead of a menu. |
| **Work card**: status chip, label-ABOVE-value micro grid, nested sub-cards, footer holding the deciding fact | In a decision queue the label is the question and the value is the answer, so stacking reads faster than the console's right-aligned column. |
| **Decision dock** with Reject / Re-task / Approve | Every other page in this set shows what is true. None of them let anyone decide anything, and a console whose only verb is "look" is a viewer. |
| **Gantt with hour columns and a red now-line** | A tasking window is a span against a clock, which a list cannot show. |
| **Toast at the top of the surface the action changed** | Confirmation lands where the change happened. |
| **Map labels as chips** rather than shadowed text | Bare text disappears over bright imagery; a chip does not. |
| **Bearing readout** on the map edge | North-up is an assumption, and an instrument states its assumptions. |
| **A distinct hue for model output** (indigo, off the map data palette) | An operator should never have to work out whether a number is a reading or a recommendation. |
| **Half-dial + stepper** for weights | A weight is a quantity you nudge, so the control shows the quantity and the nudge together. |

`32-decide.html` is the page built from it.

## Why things are not welded together

The first cut of this set had everything sharing an edge: panels butted against
the map with a 1px border, groups ran straight into each other, and the time
dock was pinned to `left: 0; right: 0; bottom: 0`. That was deliberate and it
was wrong. Gotham's *window chrome* is welded, which is what the reference crops
show, but two things inside it are not, and copying the outer grammar without
the inner one is how density becomes a wall:

- **Groups are separated.** Gotham's Histogram panel puts real vertical space
  and a rule between SUMMARY, ENTITY and EVENT. Taking its 20px row and not its
  group rhythm made a 40-row Layers panel read as one undifferentiated column.
  `.sect` now carries a top margin and a hairline.
- **The map is a canvas, not a slab.** Panels, map and dock each have four
  edges and sit in an 8px gutter of the window background (`--g-gap`), so each
  reads as a surface rather than a region of one continuous mass. The globe
  keeps every pixel it had minus the gutter; nothing is placed on top of it.
- **The dock floats.** It is an instrument over the map, so it is inset with a
  shadow rather than being a fourth welded edge.

That last change broke something the eye had been missing at every viewport:
the dock covered the scale bar and coordinate readout. Both had hand-tuned
`bottom` values re-tuned at two breakpoints, which is a specification for
overlap — any change to the dock's height silently invalidates four numbers.
They are now flow children anchored to the bottom of the map column, so they
stack and **cannot** overlap whatever either one's height becomes, and
`_gate.mjs` checks five floating pairs for intersection at every viewport.

## Other computers

The frontend this set specifies has **4 `@media` queries in its entire source**
(`index.css:22`, `news/news.css:225,232,238`), three of them on the news page.
That is the whole content of "it works on my computer": the console was drawn
once at one size and never opened at another.

So this set is checked at **1366x768, 1440x900, 1920x1080, 2560x1440 and
1834x1032** — every page, every check, every size. 21 pages x 5 viewports x 9
checks. Four real defects came out of turning that on, none of them visible at
the size the set was drawn at:

1. **A number was silently wrong.** `.kv dd` is right-aligned with
   `text-overflow: ellipsis`, and a right-aligned ellipsis eats the *leading*
   characters. At 1366 the Altitude row rendered **"8,975 ft" for 38,975** with
   nothing on screen saying it had been cut. Values now never truncate; the
   label yields instead. Gate check `clipped` distinguishes the two cases: a
   left-aligned name may ellipsis, because the cut is visible; a value may not
   clip at all.
2. **The document title printed on top of the contact count.** It was
   absolutely positioned at `left: 50%`, so it overlapped the right-hand items
   as soon as the bar got tight: `Baltic approaches watch☆13,204`. It is now a
   flow item that shrinks.
3. **The basemap ran out.** A 6x4 tile grid covers 1536x1024; the map well at
   2560x1440 is about 1966x1318, so the imagery stopped two-thirds of the way
   across and contacts floated over bare background. Now 9x6 = 2304x1536, and
   the gate measures tile coverage against the map well rather than merely
   checking the tiles loaded.
4. **The map strip sat under the toolbar**, clipped mid-word, because it was
   centred over a right-anchored toolbar.

Panel gutters are one token, `--g-pad` (14px, stepping to 11px on the smallest
screens), and the panels were **widened by the same amount they spend on it**
(left 308 to 336, right 286 to 308) so breathing room is not bought with
truncated layer names. `.row .sub` was `display: block` inside an ellipsised
parent, which clips a subtitle HARD, because a parent's `text-overflow` does not
reach a block child: `Unavailable (HTTP 503)` simply ended mid-word with nothing
marking the cut. It now ellipsises, and the gate's hard-clip check covers
`.sub`, `.row` and `.kv dt` so it cannot come back. `.panel-body` reserves its
scrollbar with `scrollbar-gutter: stable`, so a panel that starts scrolling does
not shove its own rows under the gutter.

The breakpoints drop **redundancy first**: trend sparklines beside numbers that
are still shown, menu items also reachable from the palette, legend entries for
categories already visible on the map. Panels narrow before anything is
dropped, the right column becomes an overlay below 1150px rather than
disappearing, and the map is the last thing to give up pixels. A `pointer:
coarse` block raises hit targets to 26px without changing the mouse grammar.

## The gate

`_gate.mjs` runs eleven checks on every page at every viewport in real Chrome
and exits non-zero on any failure. It exists because the previous set made these same claims in prose
and two were false when finally measured: 76 controls were keyboard-unreachable
and every icon was cropped.

```
21 of 21 pages pass  (897 icon uses, 208 marks, 629 focusable controls)
```

1. **emoji** — no codepoint above U+00FF in rendered text. Sixteen typographic
   characters are allowed by name (the lone `—` no-value sentinel, the ` · `
   separator, curly quotes, `…`); everything else is a pictograph standing in
   for an icon.
2. **basemap** — the map well resolves real tile images and none failed to load.
3. **marks** — every `.count` sits in a `.mark` containing a bar, spark, dots or
   meter.
4. **thumbs** — every `.obj-card` contains an `img` or `svg` thumbnail.
5. **floor / viewbox / a11y** — no text under 12px outside a named exemption
   list; every symbol-referencing `<svg>` has its own `viewBox`; every
   focusable has an accessible name and none is keyboard-unreachable.
6. **copy** — no ` — `; the em dash survives only alone.
7. **overflow** — no horizontal scroll at any of the five viewports.
8. **clipped** — no value is truncated; no name is hard-clipped without an
   ellipsis.
9. **stray** — no text node loose in `<body>`. A build step once appended its
   own progress line to the sprite and put `icons.mjs: 131 symbols` at the top
   of every page; it is ASCII, so nothing else here would have caught it.
10. **overlap** — five pairs of floating map furniture checked for intersection
    (the dock covered the scale bar and coordinate readout at every viewport
    before this existed).
11. **welded** — no two sibling surfaces share an edge. Two pairs are allowed by
    name, because a title bar and the tab strip under it are one header unit, as
    are an app's title row and its sub-tabs. Everything else sits in the gutter.
12. **console** — zero page errors.

The 11px exemptions are `clas`, `tl`, `tbtn`, `ax`, `tgroup`, `gl-label`,
`badge`, `attrib`, `ph-stamp`, `hud`, `det-label`. All are non-prose tokens
welded to a control or burned into an overlay. A callsign is a name the
operator reads, so it holds 12px.

## What was measured, not chosen

The structural metrics come from `tmp/redesign/_calibrate.py` and `_measure.py`
and are carried over verbatim. Blueprint v5 publishes `$pt-button-height: 30px`;
the two accent-filled buttons in the reference capture both measure 19px, so it
sits at 19/30 = 0.633 of true scale. Nine measurements then land on published
Blueprint control sizes, which is the confirmation the factor is right. The full
table is on `01-kit.html`.

The colour ramp is Blueprint 5.1.16 dark, with zero tokens outside it. Row hover
is a half step (`#2a2f37`) rather than the full `dark-gray3`, because `--txt-3`
measures 4.35:1 on `dark-gray3` and layer subtitles are `--txt-3` on rows that
hover; the half step measures 4.67:1 against the 4.5 floor
`theme/contrast.test.ts` enforces.

The font stack is Blueprint's own. The previous mockups asked for Inter and IBM
Plex Sans, **neither of which is installed on this machine**, so they silently
fell through to Noto Sans. That is a large part of why the result read as
not-Gotham.

## Two deliberate departures from the earlier plan

1. **One dark surface.** `docs/dashboard-redesign-2026-08.md` §2.2 rule 6 puts
   Foundry on a light surface. Operator decision 2026-08-01 revokes that: dark
   everywhere, one token set. **That doc still says otherwise and needs
   editing**, or the next reader will read this as a regression.
2. **This lives in `docs/mockups/`, not `tmp/`.** `.gitignore:74` ignores `tmp/`.
   The previous set's own README closed by warning it was one `git clean` from
   gone, which is what happened to `tmp/mock.css` while it was still being cited
   at `shell/instruments.tsx:4`.

## What this set does not do

- **No app code.** Nothing under `apps/` changed for this. The icons, marks and
  replay controls are specified here and land in a build pass.
- **No app-side responsive work.** The specification here is responsive and
  gated (see below); wiring the same breakpoints into `apps/web/src` is the
  build pass.
- **No fps.** A static page cannot render 39,000 entities. That is tracked
  separately against `globe/adapters/PrimitiveEntityLayer.ts`.
- **No new dependencies.**

---

## Track B, fps: the measurement retracts the plan

Measured on this machine's GPU, headful, `--profile all-toggles --seconds 75`,
backend and `pnpm dev` both live:

| | |
|---|---|
| **renderMsEMA p95** | **33.7 ms** (budget 16.7) — verdict **POOR** |
| renderMsEMA p50 | 10.6 ms |
| rendersPerSec | p05 20 · p50 55 · max 151 |
| entities | p50 34,392 · max 54,685 |
| dataSources | 78 |
| ScriptDuration / TaskDuration | 66.5 s of 69.9 s = **95 % JS-bound** |
| heap | p50 1.76 GB · **p95 3.31 GB** |
| longtasks | p50 70/min |
| drainMsLast | p95 20.8 ms |

**The remedy this plan was built on is already done.** `docs/perf-results-2026-07-27.md:221-227`
names the fix as "extend `PrimitiveEntityLayer` to the other ~45 layers". Counted
live in the browser with every toggle on:

```
total entities:        19,207
on the Entity path:       665   (billboards + labels DataSourceDisplay walks per frame)
scene primitives:           7

layer                                      ent     bb    lbl     pt  poly
conflict.gdelt.live                        388    388    259      0   315
aviation.adsb.global                    12,473      0      0      0     0
maritime.keyless                         6,000      0      0      0     0
hazards.usgs.quakes                        246      0      0    246     0
```

12,473 aircraft and 6,000 vessels carry **zero** per-entity graphics. 665 of
19,207 entities are still on the Entity path and **388 of those are one layer**,
`conflict.gdelt.live`. `PollGeoJsonAdapter.ts:620-651` already routes fire,
camera, facility, warning, hazard, airport, port and base through `BATCHED`.

### One hypothesis tested and REFUTED

With all 58 layers enabled the viewer holds **78 `DataSource` objects, 42 of them
empty**. That looked like the leading suspect, and `PrimitiveEntityLayer.ts:120-130`
appeared to support it: 11 collections / 26,841 entities measured 2.09 ms, 49
collections / 53,934 entities measured 11.26 ms.

It is wrong. Removing the empty ones at runtime, under continuous camera
rotation so frames actually render, changed nothing:

| | renderMsEMA p50 | p95 | DataSources |
|---|---|---|---|
| before | 28.8 ms | 30.5 ms | 78 |
| after removing 38 empty | 27.7 ms | 31.1 ms | 40 |

Within noise, and p95 moved the wrong way. **Empty DataSources are free.** Do not
spend a refactor on them; that measurement is the whole point of running the
experiment before writing the code.

### What is left, none of it verified

1. The **36 non-empty DataSources** and their visualizers, which the experiment
   above did not touch.
2. **3.3 GB heap at p95** with 70 long tasks a minute. GC pressure at that size
   would produce exactly the p50-to-p95 spread seen here.
3. `drainMsLast` p95 **20.8 ms** — applying a single push can cost more than a
   whole frame budget.
4. `/api/places/infrastructure` fetched **173 times in 71 s**, 43 % of all
   requests, despite `globe/pollGate.ts` having been written for this symptom.
   Nine `infra.*` layers carry nine distinct `?category=` URLs, so the gate
   spreads them but cannot dedupe them.

**Do not cite `docs/perf-results-2026-07-27.md` as the plan for this.** Its
remedy shipped and its 5-7 fps figure no longer reproduces (p50 renders/sec is
55). The next pass starts from the four items above, with the DataSource count
already eliminated.

**This is not fixed.** It is measured, one candidate is eliminated, and the
remaining four are written down. Nothing here claims an improvement.
