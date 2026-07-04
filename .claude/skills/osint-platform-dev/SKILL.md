---
name: osint-platform-dev
description: >
  Read this BEFORE doing any work on the Velocity/OSINT intelligence platform in
  this repo (apps/api FastAPI backend, apps/web React+Cesium frontend, apps/desktop
  Tauri). It is the retiring lead's operating manual: how to explore the codebase
  cheaply, how to plan and verify, the hard guardrails you must not regress, the
  feed/perf traps that already cost real time, and where the project is going. Use
  it whenever the task touches ADS-B/AIS feeds, the Cesium globe, the intel/ontology
  layer, imagery, the watch-officer, or anything under apps/. Even for a "quick fix",
  skim the guardrails first — most regressions here came from a confident one-liner
  that undid a hard-won invariant.
---

# Working on the Velocity / OSINT platform

You are picking up a large, live OSINT intelligence console. It fuses real-time
ADS-B (~13k aircraft), AIS (~21k vessels), satellites, imagery, ground photos,
ACARS, digital-OSINT, and news into a Cesium globe with a Palantir-Gotham-style
analyst workflow (ontology graph, entity resolution, behavioral detectors,
tip-and-cue, incident briefs, an autonomous watch-officer). Most capability you
need already exists. Your job is almost never to build from scratch — it is to
find the existing substrate, extend it without breaking an invariant, and prove
your change with evidence.

Read `CLAUDE.md` at the repo root in full before your first edit. It is the source
of truth for the sacred operator-visible behaviors. This skill teaches the *method*;
CLAUDE.md holds the *invariants*. When they disagree, CLAUDE.md wins.

## The one rule that governs everything: evidence over assertion

The operator enforces a hard anti-hallucination standard (global hooks check it).
Never write "done / works / fixed / verified" without showing the evidence THIS
turn — the command and its real output, a file:line you actually read, or a
screenshot. Tag every claim:

- **proven-live** — you ran it and are showing the output right now.
- **plumbed-unverified** — built and wired, but not exercised; name exactly what is
  missing (e.g. "compiles + typechecks, but not rendered in a browser").
- **not-built.**

It is fine to fail, to be unsure, to say "I could not verify X". It is not fine to
assume-then-assert. A subagent's report is not proof — check its evidence before you
relay it. The words **global / complete / full / parity / already covered** are banned
unless a live probe with a COUNT backs them up that turn. When unsure of coverage,
MEASURE (hit the endpoint, count distinct ids) before you write a claim.

## How to explore — cheaply, in parallel, with the right model

Exploration is where juniors burn the most context. Do it like this:

1. **Delegate breadth to `haiku` Explore agents.** For "where is X", "map this
   subsystem", "what are the exact signatures of Y" — launch `Explore` subagents with
   `model: haiku`. They read excerpts and return conclusions, so your main context
   eats the answer, not the file dumps. Launch up to 3 in ONE message (parallel), each
   with a **disjoint** scope, so they don't collide or duplicate.
2. **Ask for exact signatures, not prose.** A good explore brief says: "return the
   real `def` lines (file:line) + arg/return shapes; say NOT FOUND if absent." Vague
   briefs get vague answers you then can't build on.
3. **Never read a subagent's raw JSONL transcript** (`tasks/<id>.output`) — it
   overflows your context. Wait for the completion notification; it carries the result.
4. **Verify the load-bearing claims yourself before writing code.** Subagent maps are
   a lead, not gospel. Open the 3-4 files you're about to depend on and read the actual
   function you'll call. This is the single highest-leverage habit — most "it doesn't
   work" moments trace to building against an imagined signature.

Use the built-in `Explore`/`Plan` agents for read-only work; reserve `general-purpose`
for when a task genuinely needs to write. Do not delegate a search and then also run it
yourself — pick one.

## How to plan

For anything beyond a trivial edit, plan before you build. The repo has the
`superpowers:brainstorming` skill (design dialogue → spec) and `superpowers:writing-plans`
(spec → step plan) — use them for features. The rhythm that works here:

1. **Orient** with haiku explorers (feature surface + exact integration points).
2. **Find the reuse.** Before proposing new code, ask "what already does 80% of this?"
   The answer is usually yes — `incidents.brief()` already fuses+narrates+cites;
   `incident_store.record()` already diffs new/escalated; the `_PROPOSALS` queue,
   the `bus` alert pub/sub, the `PollGeoJsonAdapter` upsert, the SVG icon dispatch —
   all exist. Extending beats rebuilding and won't regress an invariant.
3. **Write a tight spec** to `docs/<feature>-plan.md` citing the real file:line
   integration points you verified. Include a **verification section** — the exact
   commands that will prove it.
4. **Question the scope (be lazy in the good way).** Ship the minimum that works and
   name what you skipped and when to add it. Speculative abstractions, a new dep for
   what a few lines do, an interface with one implementation — skip them. The best
   code here is the code you didn't write, because there's less of it to break an
   invariant.

## How to implement without regressing the sacred behaviors

CLAUDE.md lists invariants that are *sacred* — they encode operator decisions that
were made deliberately, sometimes after a feature was rejected two or three times.
The recurring failure mode is a subagent "simplifying" or "fixing" one of them
without knowing the history. The big ones (read CLAUDE.md for the full list + the why):

- **Aircraft/vessels render as category SVG icons, never bare dots.** Icon + label +
  rotation dispatch lives in `apps/web/src/globe/adapters/styles.ts` + `labelStyle.ts`.
- **Refresh is upsert-by-id, never `removeAll()+add()`** (`PollGeoJsonAdapter`). Aircraft
  **teleport to real fixes** by default — do NOT re-introduce interpolation/dead-reckoning
  on the default path to "smooth the jump"; the operator rejected synthesized motion
  repeatedly. There's a sanctioned opt-in toggle; the default stays teleport.
- **World-view decimation must be STABLE across polls** (md5(id) subset, not a positional
  stride) or the upsert churns and motion resets.
- **The global aircraft snapshot must carry ≥8k (~13k normal).** OpenSky `/states/all`
  is the breadth source; airplanes.live grid is the freshness overlay. A drop to
  hundreds is a regression.
- **`requestRenderMode: true` stays on** for the default scene.
- **Keyless layers must keep working without any API key** (ADS-B grid, Baltic AIS,
  USGS quakes, Carto basemap, CelesTrak sats with `FORMAT=tle`).
- **`apiFetch` / `withWsKey` wrap every browser→backend call**; WS handlers call
  `require_ws_key` BEFORE `accept`. No raw `fetch`/`new WebSocket`.

Subagent rules of engagement: one file, one owner (serialize edits to a shared file);
a subagent touching `styles.ts`/`PollGeoJsonAdapter`/`requestRenderMode` must preserve
the invariant above, not "clean it up".

If a change would touch one of these, and you're not certain, leave that code path alone
and say so. A correct smaller change beats a confident regression.

## How to verify — the commands that actually prove it

- **Backend tests:** run from the **repo root**, not `apps/api` — from `apps/api` the
  `.env` auth resolves and you get a wall of 401s.
  `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` — must stay green
  (baseline is ~684 passed; never below the CLAUDE.md floor of 25).
  `OSINT_DISABLE_BACKGROUND=1` skips the boot-time feed pollers so tests don't hit live
  upstreams.
- **Frontend typecheck:** `pnpm -r typecheck` must be green at every commit boundary.
- **Route smoke without a browser:** construct the app in-process and drive it with
  `fastapi.testclient.TestClient`. Note the box has Supabase configured, so the
  `ApiKeyMiddleware` enforces auth on all non-public routes — pass `API_KEY=testkey` in
  the env (env overrides `.env` in pydantic) and send `X-API-Key: testkey`. This gives a
  deterministic live check without minting a Supabase token or waiting on live feeds.
- **Live app for real behavior:** boot the backend with `bash scripts/run-api.sh` (port
  8000, run from repo ROOT so pydantic resolves the intended `.env`; it LD_PRELOADs
  jemalloc — do NOT set glibc `M_ARENA_MAX=2`, it made memory worse). Then vite on 5173.
  Verify via the DEV globals `window.__viewer` / `__Cesium` / `__useSelection`
  (`.getState().select(id)`). Kill servers by PORT holder (`ss -ltnp | grep :PORT` → kill
  pid), never by a guessed argv pattern.
- **Headless Playwright cannot measure real GPU fps** (software raster). It can measure
  main-thread longtasks during a scripted pan. Never claim an fps win from a headless
  number — verify on real hardware or say it's unverified.

Non-trivial logic leaves one runnable check behind (a `test_*.py` or an assert-based
self-check). Trivial one-liners don't need a test.

## Memory discipline

There is a persistent memory at `~/.claude/projects/-home-andrew-Projects-OSINT/memory/`
with an index `MEMORY.md` loaded each session. It is the compressed institutional memory
— read the index, and open the specific file when its one-line hook matches your task.
When you learn something non-obvious that will matter next time (a trap, a decision, a
measured number), write a new memory file + one index line. Convert relative dates to
absolute. Don't record what the repo already says (code structure, git history).

`references/gotchas.md` in this skill is a curated map into that memory for the traps
that bite most often.

## Commit voice

A global hook strips AI attribution and the operator wants human-style commits: describe
what the change does and why, measured not marketing ("union climbs to ~14k", not "now
global"). No `Co-Authored-By` / "Generated with" lines. Commit or push only when asked;
if on the default branch, branch first.

## Deeper references

- `references/architecture.md` — the current feature surface: backend routes, capability
  modules, frontend panels, and the known half-wired loose ends. Read when you need to
  place your work in the whole.
- `references/gotchas.md` — the hard-won traps (feeds, memory, auth, boot races, testing,
  Playwright) with pointers into project memory. Read before debugging a feed, a
  "slow/stale" report, or a memory/perf issue.
- `references/roadmap.md` — where the platform is going and why, what's explicitly NOT
  being built, and how to pick the next thing. Read when the task is open-ended
  ("what should we build") or you're choosing scope.
- `references/worked-example.md` — a full worked build (the watch-officer agent) from
  explore → spec → implement → verify, as a concrete template for the method above.
