# Velocity site, build plan v2 (defense-contractor parity)

Supersedes v1. v1 was rejected on sight against palantir.com, l3harris.com and
peers. This plan fixes the structural cause, not the styling.

## Measured gap that triggered the rebuild

Captured live 2026-07-25, 1440px viewport, full page, scrolled to force lazy load:

| Site | Body base | H1 | Page height | Images >300px | Image per px | video/canvas |
|---|---|---|---|---|---|---|
| Anduril | `#000000` | visual-led | 5,403 | 11 | 1 / 491 | 3 |
| Shield AI | `#050506` | 100px | 5,937 | 20 | 1 / 297 | 14 |
| Palantir | white, banded | 80px / -3.4px | 6,649 | 39 | 1 / 171 | 6 |
| Northrop | white | 60.8px / 700 | 3,362 | 7 | 1 / 480 | 12 |
| L3Harris | white | 48px | 5,485 | 6 | 1 / 914 | 3 |
| **Velocity v1** | **`#efeeec` cream** | **68px** | **8,257** | **4** | **1 / 2,064** | **0** |

v1 is the tallest page in the set and the least visual, by 4x against the
weakest reference. It reads as a long essay with four postage stamps.

Three structural causes:

1. **Cream base.** Every product asset is a dark console. On paper they can only
   sit in bordered boxes with drop shadows, so nothing can ever go full bleed.
   The references put the subject edge to edge; v1 structurally cannot.
2. **One layout family repeated.** Headline, lede, screenshot right, five times
   running. The references change band shape every section.
3. **No subject imagery.** v1 leads with a staged laptop on a desk. Every
   reference leads with the actual thing: the ship, the aircraft, the globe.

## Direction: "the console at altitude"

**Category defaults named, both avoided.** (a) Cream editorial SaaS landing with
floating screenshot cards, which is v1. (b) Near-black plus neon cyan glow plus
glass cards, which is what an AI tool produces for "defense tech". This page is
true black with the product's own rendered colour as its only accent.

- **Base** `#05070a`, sampled from the app's own space background. Surfaces
  `#0e1116` and `#161b21`. One light band at the archive argument, the way
  Palantir uses white as punctuation between cinematic bands.
- **Accent** `#d946ef`, the product's own selection colour, already an enforced
  invariant in `globe/adapters/styles.ts`. CTAs only. Earned, not decorative.
  Data colours (amber aircraft, orange incidents, teal clusters) appear only
  inside real imagery, never as page chrome.
- **Type** Geist, self-hosted, already in `assets/fonts`. The reference
  differentiator is scale and tracking, not family: display goes to
  `clamp(52px, 7.4vw, 104px)` at weight 560 and `-0.035em`, against v1's flat
  68px / -0.022em. Geist Mono carries 11px uppercase operational micro-labels,
  which is what Anduril and Shield AI both do at 12px.
- **Signature** the hairline data rule: a 1px rule carrying mono tick marks and
  a value at its right end, lifted from the app's own scrubber chrome. Repeats
  as the section divider and under the hero.
- **Imagery** every plate is a real capture of the running product at 2560x1440,
  from a live backend carrying 11,532 aircraft and 2,867 vessels. Nothing
  generated, nothing staged. The v1 generated desk plates are retired.

## Section table

Heights are targets at 1440px. Accent column = magenta permitted.

| # | Section | Layout family | Belief it earns | Artifacts | Imagery | Accent | Target h |
|---|---|---|---|---|---|---|---|
| 1 | Nav | fixed bar | orientation | 5 links, GitHub button | none | button | 64 |
| 2 | Hero | full-bleed plate, type bottom left | an operational system | eyebrow, H1, sub, 2 CTA, data rule | `plate-gulf` | primary CTA | 900 |
| 3 | Live scale | graphite strip, 6 count-ups | the numbers are measured | 6 stats, mono caption | none | no | 240 |
| 4 | Statement | centred giant grey type | the competitor keeps your history | 2 sentences, payoff in white | none | no | 400 |
| 5 | Console | full-bleed screenshot band | it is real and it is dense | caption chip | `plate-console-europe` | no | 720 |
| 6 | Capabilities | 3x2 card grid, drawn icon tiles | breadth is real, per domain | 6 cards with real counts | 2 inset shots | no | 820 |
| 7 | Archive | LIGHT band, table plus shot | the archive is the argument | compare table, note | `replay-scrubber` | no | 800 |
| 8 | Second statement | full-bleed limb plate, type over | you own it outright | one sentence | `plate-baltic` | no | 520 |
| 9 | Evidence | hairline chain strip | findings survive scrutiny | 3 steps, hashes | none | no | 480 |
| 10 | Agent | asymmetric terminal split | agents get real eyes | terminal, 46 tools | none | no | 540 |
| 11 | Workspace | edge-to-edge bento mosaic | twelve apps, not one map | 6 tiles, mixed sizes | 6 shots | no | 760 |
| 12 | Honesty | 4 truths, hairline dividers | it states its own edges | 4 truths | none | no | 620 |
| 13 | FAQ | accordion, immediately before exit | objections answered | 6 items | none | no | 700 |
| 14 | Close | quick start plus single ask | one thing to do | 4 commands, copy, 1 CTA | none | primary CTA | 520 |
| 15 | Footer | 4 columns plus base | trust, legal, sources | links, licence | none | no | 380 |

Total target 8,460 including the fixed nav, so roughly 8,100 of scroll. That is
above the reference median and the copy is worth keeping, so density carries
parity: 13 real images over ~8,100px is one image per 623px, inside the Anduril
band of 1/491 and well past L3Harris at 1/914.

## Lints, floors and ceilings

Floors, fail the build if missed:

- 13 real images minimum, every one a capture of the running product.
- 3 full-bleed bands minimum, zero side margin.
- 12 distinct layout families across 15 sections.
- 2 CTA bands minimum, both to the same destination.
- Motion inventory 3 minimum: hero plate drift, stat count-ups, scroll reveals.
- Display type reaches 96px at 1440.

Ceilings, fail the build if exceeded:

- Accent fills: 2 on the whole page, both CTAs. No accent bands, no accent cards.
- Eyebrows: 5 across 15 sections, one per three.
- One contact ask before the footer. Footer is links plus one base line.
- Consecutive sections sharing a layout family: 0.
- Em dashes visible on the page: 0. Middot as separator: 1 per line.
- External hosts fetched at runtime: 0. Fonts stay self-hosted.
- Pill radius: none. Radius scale is 4px controls, 10px cards, 0 on bands.

## Authenticity

Every number traces to the README, the measured Show HN draft, or the live
backend at capture time. No invented metrics, no testimonials, no logo wall, no
customer claims. The project has no customers to name, so it names none.
