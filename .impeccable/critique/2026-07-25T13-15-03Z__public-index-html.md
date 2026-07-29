---
target: the marketing site vs palantir.com
total_score: 23
max_score: 36
na_heuristics: 9
p0_count: 2
p1_count: 3
timestamp: 2026-07-25T13-15-03Z
slug: public-index-html
---
Method: dual-agent (A: design review · B: detector + browser evidence). Reference measured live off palantir.com the same session; full spec in `scratchpad/reference-spec.md`.

## Where your read is right, and where it isn't

Right, and worse than you said: **video** (three clips, none hover-triggered, and the best one is 38% erased by a decorative gradient), **CTA placement** (9,023px — ten viewports — with no in-body ask, and the mobile menu's primary CTA is painted behind the overlay and cannot be tapped), and **flatness** (nine `<h2>`s, eight at exactly 50px).

Wrong on three counts, all in your favour:

1. **The below-fold carousel does not auto-advance.** I sampled its `scrollLeft` for 9.5s: constant at 20715. It changes on chip-click or the per-slide ← →. What drifts is the thin *index strip* of 9 chips: `horizontalScrollingCardsTrack 324s linear infinite`, 8640px ÷ 324s = **26.7 px/s**. You don't need an auto-rotating hero carousel; you need a near-subliminal drifting index over a click-driven slide.
2. **The hover video has no mobile counterpart.** At 390px all five compute `display:none`; rows flip to `column-reverse`, tagline over wordmark, no video. They drop it.
3. **The imagery is not AI-generated.** The AIPCon slide is a real stage photograph; the careers band is a documentary frame of an engineer walking a Pelican case across a forward base at dusk. That is the source of the gravity you're reacting to, and it is the one thing you cannot generate.

**And your hero is not the problem.** It is the strongest thing on the page: 98px/0.96, two lines, one primary + one secondary CTA. Palantir's h1 is *smaller* (80px) — it only feels bigger because it is centred across 93% of the viewport with nothing else in the frame.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Nav state, `copy`→`copied`, live chips all work; `details[open] .x` at 1.76:1 gives no visible open state. |
| 2 | Match system / real world | 3 | Domain vocabulary is exact throughout (ADS-B, MMSI-dedup, SGP4, custody log, MCP). Nav labels match no section heading. |
| 3 | User control and freedom | 3 | Topbar dismissible, FAQ collapsible, Escape + `inert` handled carefully. `scroll-behavior: smooth` over 10,279px makes anchor jumps long and uncancellable; no back-to-top. |
| 4 | Consistency and standards | 2 | `.light` renders **dark** (`--paper #101317`); 12 of 25 footer links are duplicates in two groups of six; FAQ breaks the eyebrow+h2+lede pattern used by five sections; `.dom` rows carry hover affordances and no link. |
| 5 | Error prevention | 2 | Six duplicate self-overriding colour declarations shipped; no `<noscript>` on a page that hides 43 blocks by default; `summary:hover` erases the text it highlights; mobile menu CTA unreachable. |
| 6 | Recognition rather than recall | 2 | Six bento app names invisible at 1.01–1.46:1; no active-section indicator across 11 viewports; four aircraft counts with three denominators spread 2,000px apart. |
| 7 | Flexibility and efficiency | 3 | A real expert path exists — nav "Quick start", `#start`, copy button. The copy button is 1.79:1 and the fast path sits 9,428px down. |
| 8 | Aesthetic and minimalist | 2 | Type system is genuinely excellent. But 11.4 viewports desktop / 15.5 mobile for one argument stated five times, and two of fifteen bands are stock filler. |
| 9 | Error recovery | n/a | No forms, no inputs, no network-dependent UI. The one error path (`main.js:99` `copy failed`) is a sentence, not an internal. Nothing to score. |
| 10 | Help and documentation | 3 | FAQ is substantive, "What it will not pretend" is exemplary, NOTICE/DISCLAIMER/README linked. The FAQ is the last content before the ask. |
| **Total** | | **23/36** | **Acceptable (64%)** |

## Design Specificity Verdict

**Authored above the fold, find-and-replaceable below it.**

Un-swappable and genuinely yours (7 of 15 bands): the hero over a globe with real ADS-B crosses; the band naming Flightradar24's 7 days and MarineTraffic's "24 hours, down from 72"; the console recording of 15,774 live entities; the comparison table at `index.html:198-206`; the MCP terminal with real signatures (`query_aircraft(lat=25.1, lon=55.3, radius_nm=150)`). No other product's page can carry that table.

Category-interchangeable, by name:
- **`index.html:222-227`** — a stock container terminal at dusk carrying "No account. No API key." 520px that works verbatim for a freight insurer or a Kubernetes vendor. The product *tracks ships*; this is a photograph of a port, not the product tracking ships.
- **`index.html:236-252`** — Capture → Custody → Report as three text columns with no artifact. It *asserts* a chain of custody on the page whose thesis is that trust comes from showing your edges.
- **`index.html:302-307`** — the most specific content on the page in the most generic 2×2 of unstyled `h3`+`p`.

Three of six domain thumbnails are borrowed from other domains, and the alt text gives it away: Signals shows `hero-selected-track.jpg` with `alt="A selected aircraft and its recorded track"` — not a jamming cell. Hazards shows `plate-orbit-wide.jpg`. On a page that says it will not pretend, a label its own image contradicts is a content defect.

**Deterministic scan**: `detect.mjs --json` on `public/index.html` → `[]`, exit 0. Clean. I re-ran it myself to confirm. The detector finds no anti-pattern here, which is correct and also the point: nothing on this page is *cheap*. The failure is structural, and no linter sees structure.

**Visual overlays**: not available. Both assessments ran headless Node scripts rather than an injected in-page overlay, so there is no live overlay tab to look at. Evidence is screenshots (read, not just captured) and computed-style measurements.

## The measured gap

| | palantir.com | this page |
|---|---|---|
| scroll height @1440×900 | 6,649px (7.4 viewports) | **10,279px (11.4)** |
| scroll height @390×844 | 6,562px (7.8) | **13,102px (15.5)** |
| content bands | 5 + footer | **14 + footer** |
| `<h2>` | ~4, all different sizes | **9, eight at exactly 50px** |
| distinct easing curves | 10+ (in/out/inOut cubic, easeOutCirc) | **1** (`.16,1,.3,1`, used 12×) |
| `@keyframes` | 40 | **2**, and one has a single target |
| videos | 6 — 1 hero + 5 hover-triggered | **3, none hover-triggered** |
| in-body conversion CTAs | 1 persistent + 2 terminal slabs (660×190, 44px type) | **3 identical 212×48 buttons** |
| hero video weight | 40.6 MB | 2.3 MB |

**The diagnosis is flatness, not lack of polish.** Nine section headings at one size is a brochure with nine equally important chapters. Palantir's page is one statement (68px, with a phrase in light grey *inside* the sentence), one list whose items are set at 160px, one proof band, one ask. There is no flat sequence of same-size headings anywhere on it. Your page front-loads at 98px, drops to 50px, and never returns.

**The corollary: you already have the assets and you're wasting them.** The console recording is the best thing you own — thousands of aircraft over Europe and the Med, a real layer rail, counters moving. It arrives third, appears once, is sourced at 1280×675 (upscaled 1.125× at 1440), and 288px of its 758px frame — 38% — is erased by `.bleed::after`, an opaque-white top veil and a 92%-black bottom veil that land exactly on the app's status bar and its scrubber. Meanwhile Palantir spends 40.6 MB on its hero and 38–51 MB per hover clip. Your entire `assets/` directory is 9.4 MB. **You have roughly 20× the asset headroom you're using.** The gap is not budget or taste. It's that video is being treated as atmosphere when it is the only proof this product has.

## What's working

1. **"What it will not pretend" (`index.html:295-309`) is the best thing here and it isn't close.** "only 13.5% of velocity fits survive contact with the next fix" is a number no marketing page volunteers. "Community feeder terms do not allow public redistribution, so there is no demo instance to click" converts a missing feature into proof of integrity. It works because every claim is falsifiable and because it pre-empts the exact objection that kills self-hosted conversion — *is this real, or a mock?*
2. **The two-font discipline.** Archivo with tracking scaled to size (−0.024em at h3 → −0.038em at h1/98px/0.96), and Geist Mono held to exactly one job: provenance at 11px uppercase (`MEASURED ON ONE DEVELOPMENT BOX · 17 JULY 2026`). Two fonts, two jobs, zero drift across fifteen bands. The `.datarule` hairline-tick motif lifted from the app's own scrubber chrome is a real signature — the one element that would let someone recognise a second page in this system.
3. **The comparison table (`index.html:198-206`).** Four rows carry the whole thesis, and the third column ("Archive owner: You / Them / Them / Them") reframes the category. The footnote concedes the one thing a skeptic would attack — "Live coverage is similar community feeder data everywhere. The paywall is the history" — and wins anyway. It invites verification instead of asking for belief.

## Priority issues

### [P0] Six app names are invisible
`.tile b` (`styles.css:820`) declares no `color`, so after the light-base inversion it inherits `--txt` `#14161a` at 26px — and it sits above the figcaption's `linear-gradient(to top, rgba(5,7,10,.95), transparent)` where the scrim has already faded. Measured **1.01–1.46:1** against the photos behind. I read the screenshot: Explorer, Workflows, Briefs, Foundry, Satellites and Layers are ghosts, while their subtitles (`#9aa6b3`, explicit) read fine.

**Why it matters**: the section is titled "Twelve apps, one workspace" and it is the page's only evidence for that claim. A visitor leaves knowing six subtitles and zero app names.

**Fix**: `.tile b { color: #fff; text-shadow: 0 1px 12px rgba(5,7,10,.8) }`. Then do the real thing — this is precisely where Palantir's mechanism belongs. Replace the shrunken screenshots (nothing in the Explorer table is legible at tile scale) with a large wordmark plus a 3–6s muted loop on `pointerenter`, `preload="none"` and no `autoplay`, IntersectionObserver-triggered for touch. Their spec, measured: video capped at `max-width: 450px`, `border-radius: 2px`, plus a 99vw background wash behind the row, the wordmark nudged +16px over 500ms, and the index number animated grey→black over 300ms — with the exit authored explicitly as `:not(:hover)` reverse animations rather than left to a transition.

**Command**: `/impeccable animate` then `/impeccable colorize`

### [P0] Scroll motion gates content instead of decorating it
All 43 `.reveal` blocks start at `opacity: 0` in CSS (`styles.css:914`) with no `<noscript>` and no `@media (scripting: none)` fallback. `io.unobserve` fires on first intersection, so a block scrolled past too fast never gets a second chance.

- JS off → 43/43 blocks stay invisible: hero, footer, three background images, nothing else.
- Press **End** → 11 blocks stranded at opacity 0 (including a 560px full-bleed band that renders as pure white).
- A and B disagreed here and both were right: incremental scrolling to the bottom leaves 0/43 stuck; an End-key jump leaves 11. The failure is interaction-dependent, which is worse than deterministic.

**Why it matters**: the people most likely to want a keyless self-hosted tool are the people most likely to be running NoScript. And the failure mode is a white void mid-page — that reads as broken, not as un-animated.

**Fix**: invert the default. `.reveal { opacity: 1 }`; an inline head script adds `.js` to `documentElement`; gate the hidden state on `.js .reveal`; add `@media (scripting: none) { .reveal, .wipe, .wipe-r { opacity: 1; clip-path: none } }`. Drop `io.unobserve`.

**Command**: `/impeccable harden`

### [P1] Ten viewports with no ask, and the mobile CTA cannot be tapped
20 anchors point at github.com but only 4 carry `.btn`, and one of those is desktop-invisible. Between the hero CTA at y=707 and the close at y=9730 there are **9,023px with no in-body button** — only three inline text links inside body copy.

On mobile it's a functional failure. `.nav-foot` is declared `z-index: 43` at `styles.css:1047` and `z-index: 39` at `styles.css:1051`; the second wins, and `.nav-links` is `z-index: 42` with an opaque white background. Verified with the menu open: the button is 350×52 at y=768, `opacity: 1`, `visibility: visible`, `tabindex="0"` — and `elementFromPoint` at its centre returns `DIV.nav-links`. **It is painted behind the panel.** Keyboard can reach it; a thumb cannot. Same rule set leaves the wordmark `#fff` on `#fff` — 1:1.

**Fix**: `.nav-foot { z-index: 44 }`, delete the duplicate. Promote the nav pill from "GitHub" to a `btn-primary` reading "Get started" once `.scrolled`. Add a quickstart + primary CTA immediately after the archive section (~y=5,600) so your best argument converts in place instead of 4,000px later. Then take the close seriously: Palantir ends on two 660×190 slabs at 44px, buyer and builder split — `Request a Demo →` and `Start Building →`. Your equivalent is `Run it yourself →` and `Read the code →`.

**Command**: `/impeccable layout`

### [P1] The page never mentions another human being
No star count, no contributor, no release cadence, no "someone else is already running this", no `good first issue`. This is the real gap behind the two Palantir bands you singled out — "There is so much left to build / Palantirians deliver mission-critical outcomes…" and "What our partners say about us". Both are social proof doing the work of a CTA: the careers band's actual button is a *small outlined* `LEARN MORE`; the photograph and the sentence carry it.

**Why it matters**: you are asking a stranger to run four shell commands against their own disk. Community evidence is simultaneously the missing indirect CTA and the only social proof you can honestly claim — and there is none on the page.

**Fix**: one band before the close. Contributors, release cadence, an invitation to build, and — if the numbers are flattering — stars. Set it against a real photograph, not a render. Copy that earns its place next to theirs: *"The archive is the easy part. There is a decade of feeds left to fuse."*

**Command**: `/impeccable shape`

### [P1] Six colour regressions shipped with the light-base inversion
Commit `bf49562` flipped `--txt` to near-black without re-checking rules that paint onto dark surfaces. Each is a duplicate declaration overriding a correct earlier one:

| Element | Wins | Measured |
|---|---|---|
| `summary:hover` (`styles.css:857`) | `#fff` on a white page | **white-on-white** — the FAQ question vanishes on hover |
| `.nav-links a` (`:260` → `:282`) | `rgb(71,77,85)` | **2.36:1** over the hero, on the primary nav |
| `.copy-btn` (`:777` → `:788`) | `var(--txt-2)` on `#21262c` | **1.79:1** |
| `details[open] .x svg` (`:868`) | `var(--txt-2)` on `#202730` | **1.76:1** |
| `:focus-visible` (`:176`) | `--bone` `#14161a` over hero `#05070a` | **1.10:1**, first nine tab stops |
| `.nav .brand` in open menu | `#fff` on `--void` | **1:1** |

I verified the first three, the focus ring and the brand myself. `summary:hover` is a bare selector — hovering an FAQ question turns it white on white, which reads as a broken page.

**Fix**: introduce `--on-dark` / `--on-dark-2` and apply them to every rule painting onto `.hero`, the four `.bleed`s, `.light`, `.term`, `.tile` and the transparent nav. Delete the six duplicates rather than adding a seventh override. Focus ring: `currentColor` with a white variant over dark.

**Command**: `/impeccable audit`

### [P2] One argument, five times, across 10,279px
The keyless/own-your-archive claim appears in the hero subhead, the hero datarule, the nav datarule, the `.overlay-band` h2, the port band, and FAQ #1. Three consecutive bands (y=900 → 6,143, i.e. 5,243px) argue the same point.

**Fix**: cut the port band; fold the retention comparison into `#archive`. That removes ~1,280px, deletes one restatement, and moves the comparison table — your best argument — about 1,300px earlier, into the viewport where the deepest valley currently sits.

**Command**: `/impeccable distill`

## Persona red flags

**Jordan (first-timer)** — the six `.dom` rows are bare `<div>`s with `:hover` background and thumbnail scale, so they look tappable and do nothing. Nav says *Capabilities / Archive / Evidence / Agent*; the sections are headed *Every feed on one globe / History nobody can take back / From sighting to signed report / Give your agent real eyes* — no label maps to any heading, and there's no active-section indicator across eleven viewports. Footer "Domains" is six links all resolving to `#capabilities`; "Workspace" is six all resolving to one README anchor — **12 of 25 footer links are duplicates wearing different labels** (verified: two groups of six).

**Riley (stress tester)** — disables JS, loses 43/43 content blocks. Presses End, strands 11. Hovers an FAQ question and watches it disappear. Counts the aircraft numbers: 21,186 peak / 13,000 typical / 9,000 floor / 15,774 entities — four numbers, three denominators, on a page whose voice is "we state our edges" — then catches the 1.4s count-up displaying values that are simply wrong on the way up. Tabs from the top through nine stops with a 1.10:1 focus ring. Reads `styles.css:635` and finds the class named `.light` setting `background: var(--paper)` = `#101317`. Enables reduced motion and all three videos go `display:none` — the poster stills are wired, so it degrades, but "every counter moving in real time" is then asserted over a static frame.

**Casey (mobile, 390×844)** — opens the menu: no wordmark, and the only CTA is untappable. The hero video crops to a patch of desert; at 390px the product is not visible in the mobile hero. `.nav-toggle span` is `#14161a` over the near-black hero. `.overlay-band::before` is a `to right` gradient sized for a two-column desktop layout, so at 390px the right-hand stats sit on the unscrimmed bright half of the image. `index.html:88` uses hard `<br>`s, so the headline breaks as "MarineTraffic keeps 24 / hours." The mobile bento leaves two empty white cells. 15.5 viewports, three videos, 4.41 MB above the fold — 14.3s to load on Fast-3G.

## Minor observations

- **Dead CSS took the parallax with it.** `.onworld`, `.statement`, `.overband`, `.g12`, `.c-half`, `.c-third` all match **0** elements (verified). `.onworld` co-owns the `--plate` view timeline (`styles.css:959`), so `plateDrift` now has exactly **one** target — and it lives in the band most likely to fail to reveal. The scroll-linked drift the CSS comment presents as the page's signature motion has, in practice, near-zero visible instances. `heroSettle` is the only view-timeline effect actually running.
- **`heroSettle` fades the primary CTA while it's still on screen.** At scrollY=700 of a 900px hero, `.hero-inner` computes **opacity 0.22** (verified). Someone still reading the subhead watches the CTA dim out. Start the range later or exclude `.hero-ctas`.
- **Mono thousands separators read as spaced.** Geist Mono gives the comma a full advance, so the flagship numbers render as "21 , 186" and "1 , 972". Visible in the screenshot. Set numerals in Archivo with `font-variant-numeric: tabular-nums`.
- **The hero serves the heavier encode.** `hero-orbit.webm` is 2,335,650 B against `hero-orbit.mp4` at 1,739,830 B — 34% larger — and webm is listed first, so every Chrome and Firefox visitor downloads the bigger file as the LCP-adjacent asset. The other two videos are ordered correctly (their webm is smaller). Re-encode or swap the source order.
- **`preload="none"` is a no-op beside `autoplay`.** All three videos reach `readyState 4` within seconds; the two off-screen ones transferred 483,140 B and 313,603 B unprompted. Total 4.41 MB before any scroll, 6.48 MB after. (A and B disagreed on whether the off-screen pair actually *plays*; headless video decode is unreliable here, so treat playback state as unverified — the transfer is not in doubt.)
- **The first 2,418px is 100% dark** — hero + overlay band + console. The light base that `styles.css:19-22` sets as the whole design premise doesn't appear until viewport 3.
- **`.overlay-band { min-height: 760px }`** holds ~590px of content, leaving ~150px of flat black below the datarule.
- One heading skip: `h2` → `h4` in the footer. 0/15 images missing alt; 0/49 interactive elements missing an accessible name; no horizontal overflow at 390/768/1024/1440/2560; 0/43 reveals stranded on incremental scroll; reduced motion otherwise handled properly. 0 console errors, 0 failed requests.
- `assets/band-air-world.jpg` and `assets/band-orbit-world.jpg` ship unreferenced. `band-air.jpg` (654 KB) is used twice.
- `.chip` at 12.69:1 with the `#3fb996` dot is the one place "live" gets a colour, and it works. Keep it.

## Questions to consider

1. **Your best asset is a recording of 15,774 live entities moving, and the page treats it as wallpaper.** It appears once, 1,660px down, at 1280×675, with 38% of its frame erased by a decorative gradient and the fixed nav painted across its top edge. If the entire claim is "this is live and it's yours" — why is the live artifact background texture instead of the protagonist of every section? What happens if all six bento tiles play their own four-second loop?
2. **Nine headings at one size, or one statement and one list?** Palantir's page has no flat sequence of same-size headings. If you had to collapse fifteen bands into five, which four survive — and does the answer tell you the other ten were restatement?
3. **Four aircraft numbers, three denominators, one page that says it states its edges.** Is the honest move to publish four numbers with four provenances, or one number with a link to the measurement and the rest in the FAQ? And on a page whose governing rule is evidence-before-assertion, what is the argument for animating through numbers that are not true for 1.4 seconds?
