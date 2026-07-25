# Velocity site, build plan v3 (full redesign)

Supersedes v2. v2 was iterated section by section against live client feedback
until the hero held up; this plan rebuilds the whole page on what those rounds
actually proved, rather than patching further.

## What the measurements settled

Eight sites captured live at 1440px, 2026-07-25, scrolled to force lazy load.

| Site | Height | Bordered els | Images | 1 image per | Motion | Font sizes | Density | H1 |
|---|---|---|---|---|---|---|---|---|
| Anduril | 5,403 | **0.0%** | 11 | 491px | 3 | 8 | 166 | visual-led |
| Saronic | 9,362 | 0.8% | 6 | 1,560px | 5 | 10 | 135 | 21px |
| Epirus | 10,581 | 1.3% | 52 | 203px | 8 | 8 | 567 | 90px / **300** |
| Palantir | 6,649 | 1.9% | 39 | **170px** | 6 | **16** | **1,695** | 80px / **400** |
| Primer | 10,470 | 2.7% | 7 | 1,496px | 7 | 6 | 388 | 80px / 700 |
| Applied Intuition | 5,229 | 5.0% | 7 | 747px | 0 | 6 | 348 | 36px |
| Shield AI | 5,937 | 7.4% | 20 | 297px | **14** | 12 | 155 | 100px / **400** |
| Velocity v2 | 8,962 | 11.7% | 11 | 815px | 2 | 11 | 475 | 98px / 400 |

Four findings drive this rebuild:

1. **Display type is light, not heavy.** Palantir 400, Shield AI 400, Epirus
   300. v1 and most of v2 ran 560 to 620 on the theory that heavy reads as
   authority. It reads as loud. Fixed late in v2; this plan bakes it in.
2. **Borders are near zero.** Anduril literally 0.0%, Palantir 1.9%. v2 still
   sits at 11.7% and it is the worst in the set. Separation comes from surface,
   space and image edges, never from an outline round a card.
3. **Motion is plural.** Between 3 and 14 moving elements. v2 has 2.
4. **Density is the sleeper.** Palantir fits 1,695 characters per unit area
   against our 475, and one image every 170px against our 815. The page is not
   airy, it is thin. Height is not the problem: Epirus and Primer both run
   longer than us.

## Direction, unchanged from v2 and now proven

"The console at altitude." True black `#05070a` sampled from the app's own
space background, one light band at the archive argument, chrome carrying no
hue at all and every colour coming from real imagery. Archivo on the width axis
for display, Geist Mono for operational labels. The V-track mark. All of that
survived client review; none of it is reopened here.

## What changes structurally

- **Cut both grey statement bands.** Two full-height sections of large grey type
  restating a claim made better elsewhere, roughly 1,000px for 40 words. That
  space buys density.
- **Domains become an index, not cards.** Six hairline rows carrying number,
  name, detail and a live thumbnail, in the grammar Palantir uses for its
  capability list. Denser per pixel and it kills the last card grid.
- **The archive gets the biggest treatment on the page**, because it is the only
  claim no competitor can match. Light band, comparison table, and a recording
  of the scrubber actually rewinding rather than a still of it.
- **The footer becomes a real index.** Palantir's footer carries roughly sixty
  links and that alone signals an ecosystem. Ours lists real things we have:
  twelve apps, six domain groups, every upstream source, the licence set.
- **Motion target 5 or more.** Hero loop, console loop, replay loop, count-ups,
  scroll reveals.

## Section table

Heights are targets at 1440. Accent column is bone, CTAs only.

| # | Section | Family | Belief | Artifacts | Motion | Target h |
|---|---|---|---|---|---|---|
| 1 | Release strip | fixed strip | it ships, recently | dated release, linked | retract | 40 |
| 2 | Nav | transparent bar | orientation | 5 links, GitHub | fade | 64 |
| 3 | Hero | full-bleed loop | an operational system | H1 98/400, 2 CTA, data rule | 360 loop | 900 |
| 4 | Live scale | graphite strip | the numbers are measured | 6 count-ups | count-up | 210 |
| 5 | Console | full-bleed live recording | real, dense, moving | caption chip | live loop | 600 |
| 6 | Domain index | hairline rows | breadth is real per domain | 6 rows, number-led | reveal | 760 |
| 7 | Archive | LIGHT band | the archive is the argument | table, note, replay loop | replay loop | 900 |
| 8 | Workspace | edge-to-edge bento | twelve apps, not one map | 6 tiles, names at 26px | hover | 760 |
| 9 | Agent | asymmetric terminal | agents get real eyes | terminal, 46 tools | reveal | 520 |
| 10 | Evidence | hairline chain | findings survive scrutiny | 3 steps, hashes | reveal | 470 |
| 11 | Limits | 4 truths | it states its own edges | 4 truths, unchanged copy | reveal | 600 |
| 12 | FAQ | accordion before exit | objections answered | 6 items | expand | 700 |
| 13 | Close | quick start, one ask | one thing to do | 4 commands, copy, 1 CTA | reveal | 520 |
| 14 | Footer | 5-column index | there is a system here | apps, domains, sources, legal | none | 460 |

Target roughly 8,500 of scroll at meaningfully higher density than v2, since two
statement bands leave and the index and footer both carry far more per pixel.

## Lints

Floors:
- 5 or more moving elements.
- 5 or more full-bleed bands.
- 12 or more real images, every one a capture of the running product.
- Display reaches 96px at 1440 and stays at weight 400.
- Every number traceable to the README, the measured Show HN draft, or the live
  backend at capture time.

Ceilings:
- Bordered elements under 6%. Table rules, FAQ separators and control
  boundaries are the only permitted borders.
- 2 accent fills, both CTAs. No accent bands, no accent cards.
- Radius scale: 2 tokens plus the status dot.
- Em dashes visible: 0. External hosts at runtime: 0.
- Consecutive sections sharing a layout family: 0.

## Authenticity

No customers, no testimonials, no logo wall, no invented metrics. The project
has 36 stars, 3 forks and 2 contributors; those are not on the page because
they are not yet an argument. The limits section stays exactly as written, per
the operator, and it survived three adversarial judge rounds.
