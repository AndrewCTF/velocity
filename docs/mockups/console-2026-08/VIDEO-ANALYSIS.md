# Channel analysis: 470 videos enumerated, local transcription, panel comparison

Source: the public `@palantirtech` channel. This is a design reference exercise
against publicly published product demos. What is taken is structural grammar
and measurement; no branding, symbology, palette or content is reproduced.

## Scope

The first attempt at this listed the channel through `head -60` and hand-picked
ten videos, which is 2 % of it. The complete enumeration is:

| | |
|---|---|
| Videos on the channel | **470** |
| Total runtime | **102.1 h** |
| Classified UI-bearing | **93** (19.0 h) |
| Downloaded | **91 of 93** (2 unavailable) |
| Transcribed locally | **91 videos, 15,078 segments** |
| Frames extracted | **8,703** (1 per 4 s on short, 1 per 8 s on long) |
| Frames that contain UI | **4,269**, across **86** videos |

Every UI-bearing video was fetched and transcribed, not a sample.
Classification is by title against two regexes, one for product surfaces and
demo formats and one for talks, earnings, culture and ceremony; the full result
is in `yt/classified.json` at analysis time. The 57 UI-bearing videos longer
than 7 minutes are conference sessions and customer stories. They were fetched
and processed too, at a coarser 1-per-8-s frame rate.

UI frames were separated from talking heads mechanically rather than by eye: a
frame is kept when it contains at least four long axis-aligned edges and has a
standard deviation above 18, which is what a screen recording has and a person
on a stage does not. 4,269 of 8,703 frames passed.

**The filter has a known false positive and it is worth stating.** A slide deck
also has long axis-aligned edges, so marketing decks pass as UI. The densest
"UI" video by frame count, a 2022 Foundry demo, is mostly slides. Frame counts
below are therefore an upper bound on product UI, not a measurement of it. A
text-density or chrome-detection second stage would fix this and was not built.

### Videos ranked by UI-frame density

| UI frames | Video |
|---|---|
| 68 | AIP for Santa (demo) |
| 65 | AIP for Santa, Supply Chain Edition |
| 62 | Foundry Data Integration Series, Part 3 |
| 54 | Introducing Palantir AIP: capabilities and product demo |
| 53 | On the Field with Palantir AIP |
| 50 | Foundry Data Integration Series, Part 4 |
| 29 | Feature Release: Bring Your Own Model |
| 28 | Foundry Reference Project overview |
| 27 | Feature Release: LLM Evals in Pipeline Builder |
| 26 | Feature Release: SQL Studio and Time Travel |

Nine DevCon "Feature Release" clips (44-122 s) are the densest per second. Two
Gotham videos also surfaced in the classification and were fetched.

## The original ten

Ten were examined first:

| Video | Duration | Surface it shows |
|---|---|---|
| Feature Release: Interfaces in Workshop | 62 s | Workshop app builder, object-set config |
| Feature Release: Native SQL, Widget Controls, Visual Rebasing in Workshop | 70 s | Workshop widget config |
| Feature Release: LLM Evals in Pipeline Builder | 122 s | Pipeline Builder node graph + sidebar |
| Feature Release: SQL Studio, Incremental Job Debugging, Time Travel | 102 s | SQL Studio, table history |
| Feature Release: Query the Ontology Directly in Ontology SQL | 61 s | Ontology SQL |
| Feature Release: Bring Your Own Model with Registered Models | 114 s | Control panel, model registry |
| Feature Release: Global Branching & Bulk Model Migration | 67 s | Workflow lineage |
| Feature Release: Code Execution for AIP Agents | 63 s | Agent surface |
| Feature Release: Text Extract in AIP Workflow Optimization | 44 s | (silent, no narration) |
| Palantir for Builders: Deploying into Maven Smart System | 1090 s | interview, little UI |

## Speech to text, locally

`faster-whisper` 1.2.1, model `base.en`, `device=cuda`, `compute_type=float16`
on the RTX 5090. **1768 segments across 36 videos.** No cloud API, no network
call for inference.

**The honest result: the transcripts were nearly useless for design work.**
Across the nine narrated videos, a regex for layout vocabulary (panel, tab,
sidebar, widget, column, toolbar, …) matched **10 segments out of 203**. The
narration describes what a feature *does*, never where anything sits. The one
video with the most UI-referencing lines, Maven Smart System, is an interview in
which the product is barely on screen.

What the transcripts *were* good for is routing: they identify which product
surface each clip shows, which is how the frame extraction above was targeted.
That is a real but modest return, and it is worth recording so nobody spends a
GPU hour on it again expecting more.

## Frames

235 frames at 1 per 3 s across the nine feature videos, plus per-video contact
sheets, plus full-resolution stills at moments the sheets showed a panel open.
Panel regions were cropped and upscaled 2x for measurement.

---

## The finding that matters most

**Palantir's builder tools are LIGHT, not dark.** Workshop, Pipeline Builder,
SQL Studio, Ontology SQL and the control panel are all a white/near-white
surface with dark text. Every one of the nine feature videos shows a light
application.

This repo went dark everywhere on 2026-08-01 by operator decision, which
*revoked* the light-surface rule the earlier plan had
(`docs/dashboard-redesign-2026-08.md` §2.2 rule 6). The decision stands. But it
should be recorded as a deliberate divergence from the reference rather than as
convergence with it: **the operational map surface in this repo matches the
Gotham-family dark grammar; the analytical surfaces do not match the
Foundry-family light grammar, on purpose.**

---

## Panel comparison, measured across eleven element types

Theirs: measured off native 1920x1080 stills, cropped and upscaled, values
divided back to frame scale. Type size inferred from cap height, so ±1 px.
Ours: `getBoundingClientRect` + `getComputedStyle` in Chrome at 1920x1080,
`deviceScaleFactor: 1`.

| Element | Theirs | Ours (before) | Verdict |
|---|---|---|---|
| **Data table body row** | **~42 px**, ~13-14 px type | **26 px**, 12 px | **Ours was 38 % tighter. Fixed.** |
| **Data table header row** | **~34 px** | **26 px** | **Ours was 24 % tighter. Fixed.** |
| Column header type | ~11-12 px, caps, letterspaced, muted | 12 px / 600 / 0.4 px caps | Match |
| Table row carrying a thumbnail | ~42 px | 41 px | Match |
| I/O schema card, pitch | ~54 px | 44 px (`.subcard`) | Ours 19 % tighter; different object, left alone |
| Section header, collapsed accordion | ~57 px | 46 px (`.sect` block) | Different object, left alone |
| Section header type | ~13 px semibold caps | 12 px / 600 / 0.6 px | One step smaller |
| Field control height | ~30 px | 24 px | Ours is the `sm` tier; default is 30 px |
| Work-card header | n/a | 31 px | — |
| Impact tile | n/a | 49 px | — |
| Object card | n/a | 53 px | — |

### The defect this found

**A dense list row and a data table row are not the same object, and I had
built them as one.** Our table inherited the 20 px dense-list metric measured
off Gotham's layer panel. But a list row carries one label you scan past, while
a table row carries several values you compare across columns, and the
reference gives the latter ~42 px with ~13 px type.

Fixed: `--g-row-tbl: 40px` and `--g-row-tbl-h: 32px`, with body type raised to
13 px. The dense list row is untouched at 20 px.

## Original single-panel comparison

Theirs: measured off 1920x1080 stills, 2x upscaled crops, values halved back to
frame scale. Type size inferred from cap height, so treat as ±1px.
Ours: measured in Chrome at 1920x1080, `deviceScaleFactor: 1`, via
`getBoundingClientRect` and `getComputedStyle`.

| Element | Theirs (Workshop config panel) | Ours (`11-map-selected.html`) | Read |
|---|---|---|---|
| Collapsed section row, pitch | **~57 px** | **46 px** (26 header + 14 margin + 6 pad) | Ours is ~20 % tighter. Theirs is a *collapsed accordion row*, ours is a *group heading over live rows*; the two are not the same object, so this is not a defect. |
| Section header type | ~13 px, semibold, caps, tight tracking | 12 px, 600, caps, 0.6 px tracking | Effectively the same device. Ours is one step smaller. |
| Section divider | full-bleed 1 px hairline between every section | 1 px `--brd-soft` above each section | Match. |
| Panel head | title + icon cluster | 30 px, 13 px type | Match. |
| Dense two-line row | n/a in this surface | 38 px, 12 px | — |
| Key/value row | n/a — see below | 20 px, 12 px | — |
| Object card | n/a in this surface | 53 px, 13 px title | — |
| Primary button | filled blue, ~30 px | 24 px (`sm`) / 30 px (default) | Match at default size. |
| Panel width | ~195 px visible (partly occluded by a popover, so low confidence) | 308 px | Not comparable with confidence. |

### Three devices they have that we do not

1. **Field label above the control, with a help affordance.**
   `OBJECT SET ⓘ` sits as a caps micro-label *above* its input, with a question
   mark the operator can hit. Our `.kv` is label-left / value-right, which is
   right for a *readout* and wrong for a *control*: a control needs its label
   above so the input can be full width, and needs somewhere to explain itself.
   We have no help affordance anywhere in the set.

2. **Bound-value echo.** Under a control that takes a variable, a read-only row
   restates what the variable currently resolves to (`Current value: undefined`).
   That single row is the difference between "I configured a binding" and "I
   know what the binding is doing". We have nothing equivalent.

3. **A caps sub-label tier.** Between the section header and its controls sits a
   muted caps label on its own row (`ENABLE FILTERING BY TABLE …`). It is a third
   heading level below the section. Our `.row .sub` is sentence-case and
   subordinate to a *name*, not to a *section*, so it is a different tier.

### Two devices we have that they do not, on this surface

- **A mark beside every count.** Their config panels are text and controls; ours
  puts a bar, sparkline or dot matrix next to every number. That was the
  operator's explicit requirement and it holds.
- **A four-state contract** (loading / empty / error / **degraded**). Their
  feature clips are happy paths throughout; nothing degraded appears in 235
  frames.

---

## What this changes

Implemented from this pass:

| Component | What it is | Why it earns a place |
|---|---|---|
| `.field` | label above the control, with a help affordance | A readout puts its label left and its value right. A control puts its label above, so the input takes the full width and there is somewhere to hang an explanation. |
| `.echo` | bound-value restatement row | The difference between "I configured a binding" and "I know what the binding is doing". |
| `.sublabel` | caps tier between a section header and its controls | A third heading level, subordinate to a section rather than to a name. |
| `.modebar` | a sandbox states itself on the surface, with its exits | This repo already treats "simulated" as a correctness concern. A caveat inside one card is not enough when the whole workspace is a sandbox. |
| `.impact` | outcome tiles tinted by valence | The point of an impact readout is not the number, it is whether the number is good. Tint answers that before the number is read. |
| `.sweep` | one row per parameter value, outcomes in columns, chosen row marked | A parameter sweep read as three separate runs is three things to hold in the head. |
| `.prompt` | one full-width input closing a conversational surface | — |
| `--g-row-tbl` | data-table row raised 26 to 40 px, type 12 to 13 px | The measured defect above. |
| `.applist` | app launcher, starred entries pinned above the full list | Fourteen apps flat means the four used daily are found by reading past ten that are not. `docs/dashboard-redesign-2026-08.md` §2.1 already carried this from direction C and it was never built; the reference confirms the shape. |

Not implemented, with reasons:

- **Light analytical surfaces.** Contradicts a standing operator decision. Named
  above as a deliberate divergence, not carried out.
- **Workshop-style app builder.** This repo has no app-builder surface and
  inventing one to hold the config panel would be a page about a capability that
  does not exist. The three devices above are added to the kit so the surface
  that eventually needs them has them.

## Reproducing

```bash
yt-dlp --flat-playlist --print "%(duration)s|%(id)s|%(title)s" \
  "https://www.youtube.com/@palantirtech/videos"          # select
yt-dlp -f "bv*[height<=1080][ext=mp4]+ba" -o "yt/%(id)s.%(ext)s" <id>   # fetch
python -m venv sttenv && sttenv/bin/pip install faster-whisper          # local STT
ffmpeg -i in.mp4 -vf "fps=1/3,scale=960:-1" out_%02d.jpg                # frames
ffmpeg -pattern_type glob -i "out_*.jpg" -vf "scale=760:-1,tile=4x3" sheet.jpg
```
