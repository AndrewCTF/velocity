# Phase 1 — ground truth before building (2026-08-30)

Phase 1 of `Answer God's Eye View`. It edits no product code by design: its job
is to re-establish the baseline and *observe* the seven user-visible features
that `docs/exec-report-2026-07-29.md` §3 said were shipped with unit guards and
never seen rendering. Findings here re-price the later phases.

Branch `osint-book-intel-2026-08` at `5a03e24`. Backend on :8000 via
`scripts/run-api.sh`, Vite on :5173 via `pnpm dev`, real Chrome, clean profile.

## Baseline, re-run

`OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` from the repo
ROOT with :8000 free:

    2559 passed, 2 skipped in 153.26s

Matches the number in `/CLAUDE.md` exactly. No phantom regression to chase.

## The measurement was broken before the features were

Three browser harnesses under `tools/perf/` set `velocity.onboarded`. The gate is
`velocity.onboarded.v1` (`onboarding/Onboarding.tsx:8`). The key was versioned at
some point and the harnesses were not updated, so **every `tools/perf` browser run
since then measured the console with the WELCOME modal open over it**. The five
`scripts/screenshot-*.mjs` all use the correct key, which is why this went
unnoticed: the screenshots looked right and the perf numbers did not.

There is a second, independent first-run gate the harnesses never knew about:
`AppRouter.tsx:163` `AiSetupGate` renders a full-screen **LOCAL AI SETUP** modal
when zero models are installed and llama.cpp is not running. On a genuinely clean
profile a new self-hoster meets that modal — a picker offering 22-97 GB GGUF
downloads — before they have seen the globe. It is deliberate and correctly
gated; whether it should be the *first* thing a first-run user sees is an
operator call, and it is recorded here as a first-run finding, not a bug.

Fixed in this commit, harness-only:

- `app_reachability_check.mjs`, `console_frame_check.mjs`,
  `phase1_feature_sweep.mjs` now set `velocity.onboarded.v1` **and**
  `velocity.aiSetupSeen`.
- `console_frame_check.mjs`'s tier check asserted `tierMarks >= 20`, a floor
  calibrated against the folder open-state of 2026-08-05. It failed at 16 while
  **every one of the 16 visible rows still stated its tier**. The invariant is
  "a visible row with no tier", which `TierMark` renders as an aria-hidden 21px
  spacer (`shell/panels/LayersPanel.tsx:49`). The check now counts spacers and
  requires zero. Measured: 16 rows state a tier, **0** render the spacer.

A gate that fails for a reason unrelated to the thing it guards trains people to
ignore it, which is how the 2026-08-05 threshold outlived the UI it described.

## The seven features, observed

`node tools/perf/phase1_feature_sweep.mjs` (new; report + screenshots).

| Feature | Verdict | Evidence |
|---|---|---|
| replay transport | **RENDERED** | play=1, return-to-live=1, scrubber=1 — matched by the controls' own accessible names (`TimeDock.tsx:178,201,296`), not a guessed text cluster |
| provenance chip | **RENDERED** | selected `aircraft:a8a3ce`; tier vocabulary present; PROVENANCE section visible in the dossier |
| archive sparkline | **RENDERED** | archive wording present, 207 svg polyline/path nodes |
| answers panel | **RENDERED, but see below** | the card mounts and then sits on `Loading…` |
| corroboration lens | **CONTROL RUNS** | the View menu item (`TitleBar.tsx:226`) clicks and toggles |
| inbox keyboard path | **UNVERIFIED** | handler is real (`InboxPanel.tsx:96-137`, j/k/g/G/Enter/e on a window listener) but the triage queue was empty, and the handler returns early on an empty queue by design (`:98`). Not a defect; not evidence either |
| staleness dimming | **UNMEASURABLE BY SCRIPT** | contacts draw as PRIMITIVES since the entity→primitive rewrite, so per-contact alpha is not reachable from the entity graph, and forcing a stale contact needs a frozen upstream. Saying so beats inventing a pass |

`console_frame_check.mjs`: 4/4 PASS — globe fill 0.878 of the map frame at
11,651 km, right dock 656 chars with nothing selected, tier marks as above,
0 console errors.

`app_reachability_check.mjs`: all 14 apps and all 4 left panels render.
`app:investigate` reads **21,593** chars against **2,684** in the 2026-08-05
report — that jump is the modal fix, not new work, and it means the old
per-surface numbers in `docs/plan-99-2026-08.md` §2.1 are not comparable.
Thinnest surfaces are still `workflows` (1,130) and `city` (1,277), matching
plan-99's read. Three failing requests, exactly the three plan-99 documented:
`401 /api/targets/board` and `401 /api/collab/shared-notes` (both by-design
local-first) and **`404 /api/ontology/object/control:workspace`**, which
plan-99 called "a real miss, unfixed" and still is.

## Two findings that re-price later phases

### Phase 20's premise was wrong, and so was the correction

The plan said the union never records a second source. A review said the July
`corroborated_pct: 0.0` was an artefact of one tier being live. **Both are
wrong.** Measured now, on a healthy snapshot with the floor met:

    /api/status/provenance
    total 8562 | attributed 539 | unattributed 8023 | corroborated 14 | 2.6%
    tiers: opensky 539 contacts (525 exclusive), feeds 14 (0 exclusive)

Two tiers *are* live and 14 contacts *are* corroborated. The real defect is that
**93.7% of contacts carry no `sources` field at all**. Pulling the snapshot
directly: 8,588 features, 507 with `sources` (all `['opensky']`), and 8,081 with
`properties.source == 'adsb'` and no `sources` list.

Cause: `_stamp_sources` (`routes/adsb.py:1849`) skips any contact whose `seen_by`
set is empty (`if not tiers: continue`), and the tier supplying 8,081 of 8,588
contacts never registers one. `status_provenance` is honest about this — it
buckets them as `unattributed` rather than guessing — so the reader is right and
the writer is incomplete.

Consequence for the UI: the corroboration lens dims anything not corroborated
(`PrimitiveEntityLayer.ts:370`), so today it would dim ~97% of the map. That is
the finding, not a rendering bug.

### The answers surface is honest and slow

`/api/answers` returns **11** answers in **20.5 s**. Ten read `unknown` with the
reason "No recorded vessel history in this strait yet"; `aircraft-coverage` reads
`open` with a real number (9,242 against a floor of 8,000, 116%). So the panel is
not stuck — it is waiting 20 s, which is why it reads `Loading…` on arrival.

This confirms Phase 23's premise and sharpens it: the answers do not need to be
written, they need recorded history (Phase 11) and they need to not take 20 s.

## What Phase 1 did NOT establish

- Staleness dimming, per the table above.
- The inbox keyboard path against a non-empty queue.
- Anything about GPU frame rate: headless Chrome cannot measure fps, and no
  number is offered.
- Whether the 20 s `/api/answers` cost is the chokepoint history queries or
  something else. Not profiled; Phase 23 should measure before optimising.
