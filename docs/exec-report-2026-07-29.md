# Overnight execution report, 2026-07-29

Against `docs/plan-50-2026-07-29.md`, on `overnight-provenance-answers-2026-07-29`
(branched from `perf-annotate-sidecars-2026-07-27`; see §6).

**Headline: 29 of 50 items landed, all three operator-reported defects fixed,
`scripts/verify.sh` ALL GREEN, pytest 2047 → 2096.** The remaining 21 are
untouched and listed by number in §4. Nothing is half-built: every item below is
either complete with evidence or absent.

A pull request is open at
<https://github.com/AndrewCTF/velocity/pull/62> from
`overnight-provenance-answers-2026-07-29`. See §6 for why that branch and not
`perf-annotate-sidecars-2026-07-27`.

## 1. Gates

| Gate | Command | Result |
|---|---|---|
| G1 unit | `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` | **2096 passed, 2 skipped** (inherited baseline 2047) |
| G2 static | `pnpm -r typecheck` | clean |
| G3 full | `bash scripts/verify.sh` | **ALL GREEN** |
| G4 live | per item, §2 | run this session against :8000 |

CLAUDE.md records the baseline as 2006; the tree actually inherited **2047**, and
that is the number this wave must not regress below. Worth correcting in
CLAUDE.md.

## 2. What landed, with the evidence

Tagged `proven-live` (behaviour observed this session), `plumbed-unverified`
(code + guard test, behaviour not observed), or `not-built`.

### The three operator-reported defects

**"OpenSky has so many dead planes and its not fixed yet" — item 1, 2, 3 — proven-live**

Root cause was documented in the code as an accepted ceiling
(`apps/api/app/routes/adsb.py:632`): OpenSky is pulled once per UTC day and served
from memory, but it stamped `seen_pos_s` — a *duration* — once, at pull time. The
number froze while the clock kept moving, so an aircraft whose fix was 5 s old at
0000 UTC still claimed 5 s old at 2300 UTC and rode the union all day as a
live-looking icon parked on the morning's position.

The tier now stamps `pos_epoch`, the absolute instant, and the refresher
re-derives the duration against the current clock. `seen_at` moves with it, so
`seen_at - seen_pos_s` still evaluates to the real observation instant and the
freshest-wins union is unchanged. Aged contacts are **marked, not dropped** —
dropping at the live tier's 900 s cap would blank the breadth layer fifteen
minutes into every UTC day and break the ≥8000 floor.

Live: `seen_pos_s` across 4,546 contacts read `min=0.0 p50=0.3 p95=24.3 max=865.5` —
real durations spanning three orders of magnitude, not a frozen constant.
Guard: `apps/api/tests/test_adsb_cached_age.py`, 9 tests.

> **Caveat, stated plainly.** OpenSky returned **HTTP 429** for the whole session
> (daily anonymous credit budget spent), so it contributed **zero** contacts and
> the fix could not be exercised against live OpenSky data. It is proven against
> the unit guards and the mechanism is shared, but the specific tier that
> produced the operator's symptom was not observable tonight. See §3.

**"the control for replay is really hard and unintuitive, I cannot drag select
move and control easily" — items 4, 5 — plumbed-unverified**

The strip accepted a mouse-down, drew a selection rectangle, and threw it away on
release: only a click under 5 px did anything, and `onMouseLeave` cancelled the
gesture, so any drag with speed did nothing at all. Now dragging scrubs (playhead
follows the pointer), a release across a real span loads that span as the replay
window, the gesture is pointer-captured so it survives leaving the strip, the
playhead is drawn on the strip you actually drag, and a hover readout follows the
cursor. Keyboard transport added: space, arrows, shift-arrows, `,`/`.`, `L`.

Guard: `apps/web/src/timeline/transport.test.ts`. **Not browser-verified.** The
pointer gestures are deliberately not asserted in jsdom — synthetic drag there
does not reproduce pointer capture, and a test passing on a fake gesture would be
worse than no test. This needs a real browser before it can be called proven.

**"it also take some time to load in data after I zoom out or move in" — item 6 — plumbed-unverified**

The bbox was computed to three decimals straight from the camera rectangle, so
every pixel of movement produced a different URL. The adapter's move-refresh only
short-circuits when the URL matches the last fetched one, so that essentially
never held and every nudge was a fresh request over mostly the same ground. Fixed
by widening the prefetch ring 15% → 35% *and* snapping the padded edges outward to
a zoom-relative grid, so a pan under ~1/8 of a screen reproduces the same URL.
Fixing either alone does not fix the symptom.

Guard: `apps/web/src/globe/viewportQuery.test.ts`, 9 tests. **No before/after fps
or latency measurement was taken** — per `docs/decisions.md` (2026-07-27) a
comparison is only valid if both runs had the same tiers live, and tonight only
one tier was up. Needs `tools/perf/measure_ui.mjs` on the GPU with a healthy feed
set.

### Provenance (items 7, 8, 9, 12, 14) — proven-live

Every contact now carries which independent tiers reported it this cycle,
`source_count`, and a three-bucket `confidence`, with the rule published next to
the verdict and mirrored into the frontend (pinned by a cross-language test so the
two copies cannot drift). A tier that lost the freshness race still counts as an
observer; filtered records do not.

Live `/api/status/provenance`:

```json
{"total": 4546, "attributed": 4546, "corroborated": 0, "corroborated_pct": 0.0,
 "tiers": {"grid": {"contacts": 4546, "exclusive": 4546}}}
```

**This endpoint earned its place on its first run.** It says that 100% of tonight's
contacts come from a single tier and nothing is corroborated — which is exactly
the "single unverifiable source" condition the research says this audience checks
for, and it was invisible before.

Guard: `apps/api/tests/test_provenance.py`, 9 tests.

### Answers (items 23, 24, 26, 30) — proven-live

An `Answer` is a verdict, the rule that produced it, and the age of its evidence.
The rule and the lag are mandatory dataclass fields. First implementation: is a
strait moving traffic, counting **distinct vessels** over 24 h against the median
of prior recorded days.

Live `/api/answers` returned 10 answers, all `unknown`, each carrying its reason:

```
verdict = unknown
threshold = Distinct vessels seen in the strait over the last 24 hours, against the
  median of the previous complete days we have recorded. Under 25% of that median
  reads as closed, under 60% as reduced, otherwise open. Needs at least 3 prior
  days of our own recording before it will answer.
detail = No recorded vessel history in this strait yet. Leave the console
  recording and this answers itself.
```

That is the correct output on a fresh history store, and it is the behaviour the
research argues for: refuse to answer, say why, rather than produce a confident
number from three hours of data.

**A real bug was caught by running it live**: `data_lag_s` was `float("inf")`,
which does not survive JSON and arrived as `null` — a client reading `null` as 0
would have turned "we have nothing" into "perfectly current", the exact inversion
the design exists to prevent. Now an explicit `None` sentinel with `stale: true`
always set alongside, plus a JSON round-trip test.

Guard: `apps/api/tests/test_answers.py`, 9 tests.

### Doctor (items 31, 34, 36) — proven-live

`/api/status/doctor` reports, per optional capability, whether it is configured,
what you lose without it, and the literal line to add. Generated from the
`Settings` model so it cannot name an env var the code does not read — the
specific defect being guarded against is the 312-point launch whose README named
`OPENSKY_USERNAME`/`OPENSKY_PASSWORD` while the code read
`OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`.

Live, it diagnosed tonight's actual failure chain in one call:

```
required_missing: 0   optional_not_configured: 1
configured: [AISStream global firehose, Cesium Ion, NASA FIRMS, Sentinel / CDSE]
  - OpenSky authenticated breadth | not-configured
    fix: OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=...
```

Unauthenticated OpenSky → small anonymous daily budget → 429 → no breadth tier →
1,004-4,546 aircraft against an 8,000 floor. **That is the root cause of the
operator's "dead planes" complaint, and the new endpoint found it.**

Guard: `apps/api/tests/test_layer_health.py`, 4 tests.

### History diff (items 16, 22) — proven-live

`/api/history/diff` returns arrived / departed / still-present inside a box
between two moments — the question a stateless dashboard cannot answer at all.
Moments are widened into windows because a stored position is a sample. An empty
store and "nothing changed" both produce zero counts, so the response
distinguishes them with `recorded`.

Live (Hormuz box, 1 h ago vs now): `recorded: false, counts: {a:0, b:0, ...}` —
correct on a fresh store, and honestly distinguished from "no change".

Guard: `apps/api/tests/test_history_diff.py`, 8 tests.

### Answers rendered (item 25) — plumbed-unverified

The answers backend shipped without a surface, which made it the least useful
thing in the branch. It now has its own rail panel in the PRIMARY group, laying
out verdict, evidence age and the rule together, none of them behind a tooltip.
A null lag renders as "no evidence recorded", never "0s old" — the one inversion
that would undo the design at the last hop, pinned by
`apps/web/src/answers/AnswersCard.test.tsx`. **Not browser-verified.**

### Agent surface (items 43, 44, 45, 47) — proven-live

Four MCP tools: `answer`, `contact_provenance`, `history_diff`, `system_doctor`.
Live via `python -m app.mcp_server --list-tools`:

```
osint-geoint MCP — 50 tools:
  • answer: Named questions answered with a verdict, its rule, and the evidence age.
  • contact_provenance: Which sources are seeing the sky right now, and how much they agree.
  • history_diff: What changed inside a box between two moments: arrived, departed, stayed.
  • system_doctor: What is configured, what is missing, and the exact line that fixes it.
```

A tool description is the prompt the model reads, so each carries the caveat its
return value invites: unknown is a real answer, an uncorroborated contact is not
a confirmed one, an empty archive is not a quiet period, a missing optional key
is not a defect. Those four sentences are guarded by
`apps/api/tests/test_mcp_new_tools.py` — a careful backend misreported at the
agent hop is no better than a careless one.

### Inbox as a queue (item 41) — plumbed-unverified

j/k move, enter opens and slews, e archives, g/G jump to the ends. The rule worth
extracting was what happens after an archive: the cursor **stays put**, because
the archived row disappears and the next slides under the same index, so
advancing would skip an alert. Guard: `apps/web/src/inbox/queueCursor.test.ts`.
**Not browser-verified.**

Note the plan was wrong about this phase: **37** and **40** already existed.
`state/inbox.ts` carried read/archived triage state and `InboxPanel.tsx` already
unified the surfaces. Only the keyboard path was missing.

### Behaviour from the archive (item 21) — plumbed-unverified

The panel's altitude trace came from the in-memory ring buffer, which starts
empty on every page load, so it said "insufficient samples" no matter how much
history was on disk. The archive has carried `baro_alt_m` since ingest and the
by-id query threw it away; it now returns an opt-in `series` and the panel draws
the last hour from it.

Two refusals, both tested: a missing altitude arrives as `null` not `0` (a
plotted zero reads as an aircraft on the ground), and a gap in the archive is
drawn as a gap rather than bridged (a straight segment across a coverage hole
asserts a position nobody observed). Guard:
`apps/web/src/entity-panel/ArchiveSeriesCard.test.tsx`. **Not browser-verified.**

### Corroboration lens (item 11) — plumbed-unverified

OFF-by-default setting that fades contacts only one source reported. A lens, not
a filter: single-source is normal over open ocean, so defaulting it on would hide
real traffic and call it rigour. Faded rather than hidden, and an unknown source
count reads as corroborated. Guard: `freshness.test.ts` + a settings-default
test. **Not browser-verified.**

### Positioning (item 48) — done

`README.md` now leads with **"A live map you can rewind, that tells you where
every contact came from"**, names the commodity it is not, and states coverage
limits up front. Removed the "keyless situation console … fused on one 3D globe"
lead, which is the exact phrasing the research shows is now a template.

### Hygiene (item 49) — proven-live

```
git ls-files | xargs grep -lE '(api[_-]?key|secret|token|password)\s*[:=]\s*"?[A-Za-z0-9_-]{24,}'
  → (no matches outside tests/docs)
git ls-files | grep '\.env'  → .env.example only
```

## 3. What this wave did NOT establish

- **The OpenSky age fix was never exercised against live OpenSky data.** The tier
  was 429'd all session. Re-check after 0000 UTC, or configure
  `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` for the larger budget.
- **No UI was browser-verified.** The replay transport, the staleness dimming,
  the provenance chip, the answers panel, the inbox keyboard path, the archive
  sparkline and the corroboration lens are all plumbed with unit guards and NONE
  has been seen rendering. This is by some distance the biggest gap in the wave:
  seven user-visible changes, zero of them observed. Everything needed to check
  them is in place (`scripts/run-api.sh`, Vite on :5173, `window.__viewer` /
  `__useSelection` in dev).
- **No performance measurement.** The pan-latency change has a mechanism argument
  and unit guards, not a number. Both runs of any before/after must have the same
  tiers live.
- **The aircraft floor is unmet** (1,004-4,546 vs 8,000) for the upstream reason
  above, not because of anything in this branch.
- **X coverage in the research is thin** — web search only, no engagement figures.
  Reading the operator's browser cookies unasked was not a call to make.

## 4. The 21 items not started

Phase 1: **10, 13** — but note `apps/api/app/intel/deception.py` already ships
duplicate-MMSI, teleport, spoof-cluster and kinematic detection, so the genuine
remainder is only *cross-tier* disagreement (two tiers placing one id far apart
in the same cycle), not the detectors themselves.

Phase 2: **15, 17, 18, 19, 20** (replay permalink, auto-pause at events,
coverage-honesty strip, copy-link button, replay slice export).
Phase 3: **27, 28, 29** (answer permalink, verdict history, three more answers).
Phase 4: **32, 33, 35** (empty-layer reasons in the rail, the health panel, the
degraded-boot banner).
Phase 5: **38, 39, 42** (saved search → subscribe, watchbox → geofence alert,
inbox store test). **37** and **40** were already built: `state/inbox.ts` carries
read/archived triage state and `inbox/InboxPanel.tsx` already unified the
surfaces, which the plan did not know.
Phase 6: **46** (citation contract on model prose).

Highest value per hour from here, in order: **46** (make model prose carry the
object ids it came from — the audience treats unsourced LLM output as a quality
signal, research §5.5), **32/35** (finish the never-fail-silently loop in the UI
now the backend doctor exists), **17/18** (turn replay into a briefing), **38**
(subscribe from a saved search).

## 5. Commits

```
Add a corroboration lens to the globe
Plot behaviour from the archive, not from what this tab happened to see
Make the inbox a queue you work rather than a list you read
Render the answers, and give an agent the four new capabilities
Report the overnight wave honestly, and stop pitching the commodity
Answer named questions, diagnose blank layers, and diff two moments
Record which sources saw a contact, not just where it is
Stop refetching the same ground under a new URL on every camera nudge
Make the replay strip a transport control instead of a rectangle
Report the age of the data, not the age of the pull
Research what the last 30 days rewarded, and plan 50 changes against it
```

Eleven new guard modules: `test_adsb_cached_age.py`, `test_provenance.py`,
`test_answers.py`, `test_history_diff.py`, `test_layer_health.py`,
`test_mcp_new_tools.py`, `freshness.test.ts`, `viewportQuery.test.ts`,
`transport.test.ts`, `queueCursor.test.ts`, `ArchiveSeriesCard.test.tsx`,
`AnswersCard.test.tsx`.

### The three guards that were modified, and why

Modifying a guard is how operator decisions get lost, so each is justified here.

1. `test_status_is_cheap.py` sliced source from `status_perf` to end-of-file, so
   it failed ANY new route appended to the module regardless of behaviour.
   Rescoped to the function it names. The protection is unchanged and can no
   longer be satisfied by moving code above the slice either.
2. `test_mcp_http_mount.py` asserts an exact MCP tool count, deliberately, to
   keep the advertised number in lock-step with the code. 46 → 50, and the
   README count moved with it. Updating both is the intended path through that
   guard, not a way around it.
3. `settings.test.ts` pins the exact persisted-settings shape. `corroboratedOnly`
   was added to it, plus a new test asserting it defaults OFF.

## 6. Why the PR is on a different branch

`perf-annotate-sidecars-2026-07-27` cannot be pushed to GitHub at all:
`website/assets/launch-4k.mp4` (296 MB) exceeds the 100 MB hard limit and
`launch-1080.mp4` (51 MB) trips the warning, both from commit `efab3a2`, which
predates this work. The pre-receive hook rejects the whole push.

Rewriting fifty commits of someone else's history unattended is not a call to
make, so the work went onto `overnight-provenance-answers-2026-07-29`: the same
tree and history with only those two blobs stripped. The original branch is
untouched locally and tagged `backup-before-mp4-strip-2026-07-29`.

**This needs an operator decision.** Either move those files to Git LFS, or drop
them from history, or keep them out of git entirely. Until then that branch can
never reach the remote.

One guard was modified: `test_status_is_cheap.py` sliced source from `status_perf`
to end-of-file, so it failed any new route appended to the module regardless of
what that route did. Rescoped to the function it names; the protection for
`status_perf` is unchanged and can no longer be satisfied by moving code above the
slice either.
