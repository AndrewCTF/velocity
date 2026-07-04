# Worked example — building the watch-officer agent

A real build, start to finish, as a concrete template for the method in SKILL.md. The
task was open-ended: "start implementation" of the roadmap's first Tier-1 item. Spec lives
at `docs/velocity-watch-officer-plan.md`; memory `[[watch-officer-agent-2026-07-04]]`.

## 1. Explore — two haiku agents, disjoint scope

Launched two `Explore` agents (`model: haiku`) in one message. Briefs asked for **exact
signatures + return shapes, file:line, "NOT FOUND if absent"** — not prose:

- Agent A: detectors + incidents + cue + watch + pol + `global_snapshot`.
- Agent B: inbox frontend + the HITL approval-gate + llm entrypoint + the lifespan
  background-task pattern.

Key discovery that shaped everything: **the substrate already existed.** `incidents.brief()`
(`intel/incidents.py`) already fuses, ranks, narrates, and cites; `incident_store.record()`
(`intel/incident_store.py`) already diffs `new`/`escalated`/`resolved` by a stable
`incident_key`. So the "agent" was mostly a loop gluing those together, not new analytics.

## 2. Verify the leads before writing a line

Read the actual files the plan depended on — `actions.py` (the `_PROPOSALS` queue),
`bus.py` + `types.py` (the `Alert` dataclass), `incident_store.py`, `main.py` lifespan,
`watch.py` start/stop, `InboxPanel.tsx`. Two things this caught that a subagent map alone
would have missed:

- The proposal queue's **approve → `dispatch()` executes a write-back action** — wrong
  semantics for an informational brief (approve of a brief = acknowledge, not execute).
- The `Alert` dataclass is **too thin** to carry a narrative + evidence + follow-up.

So the lazy "reuse the proposal queue or the alert bus" both had real edge-case
mismatches. The right call was a small dedicated brief store — *not* overengineering,
just correct-on-the-edges. This is exactly why you read the files yourself.

## 3. Spec — tight, citing verified integration points

Wrote `docs/velocity-watch-officer-plan.md`: the loop design, the one-playbook MVP
(dark-vessel → `cue.run` SAR tasking), the keyless-route decision (avoid the
Supabase-unset 401 trap), and a verification section with the exact commands. Marked the
deliberate simplification: brief() already narrates, so **no extra LLM call on the default
path** — add enrichment only if the canned narrative proves thin.

## 4. Implement — minimum vertical slice, reusing everything

- `intel/watch_officer.py`: `run_once()` = `brief()` → `incident_store.record("watch-officer",
  incs)` → for new/escalated high/elevated incidents, dedup by `incident_key`, run the
  playbook, file a brief in an in-memory `_BRIEFS` dict. Lifecycle **mirrored `watch.py`
  exactly** (`_TASK`/`_STARTED`/`start`/`stop`/`_run_forever`). Used its OWN
  `incident_store` scope so it doesn't collide with the geofence baseline.
- `routes/watch_officer.py`: GET briefs, POST dismiss/ack. No `current_user` dep.
- `main.py`: import + `include_router` + `start()` in lifespan `if background:` +
  `stop()` in `finally`. Followed the existing ordering and comment style.
- Frontend: `state/watchOfficer.ts` (a 30s `apiFetch` poll hook + optimistic triage) +
  a "Watch Officer" section in `InboxPanel.tsx` reusing the existing `Badge`/`Btn`
  instruments and Tailwind idiom.

Gotcha found while building: `incident_store.record`'s diff carries only **summaries** (no
evidence/follow_up), so the loop keys off the diff but pulls the **full** incident from
its own `brief()` result via `incident_key`.

## 5. Verify — with evidence, tiered honestly

- `pytest tests/test_watch_officer.py` → **5 passed** (pure logic: files a brief for a
  high incident, dedups on the second sweep, skips low, runs the SAR playbook for
  dark-vessel, dismiss/ack clear). Ran from repo root.
- Full suite `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` → **684
  passed** (no regression).
- `pnpm -r typecheck` → green.
- In-process `TestClient` smoke with `API_KEY=testkey` + `X-API-Key` header (needed
  because the box has Supabase → middleware enforces auth): empty→`200 {briefs:[]}`,
  filled→correct brief+playbook, dismiss→`404` on repeat, no-key→`401`. All **proven-live**.
- Frontend rendering in a real browser: **plumbed-unverified** — compiles + typechecks +
  hook wired, but not exercised in a browser (needs a logged-in user + a live high
  incident). Said so explicitly rather than claiming it worked.

## 6. Record

Wrote a memory file + one index line capturing the design, the `incident_store`-summary
gotcha, and the verification tiers. Did NOT commit (operator commits on request).

## The transferable shape

explore-cheap (haiku, parallel, disjoint, ask for signatures) → **verify the leads
yourself** → find the reuse → tight spec with a verification section → minimum slice that
reuses the substrate and mirrors an existing idiom → prove with real commands and tier the
claims honestly → record what was non-obvious. That loop is the job.
