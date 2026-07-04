# Plan — AI need-to-know on the intel agent (Gotham parity #3)

_Compiled 2026-06-29. Grounded in file:line reads this turn. Closes the single
cheapest high-value Gotham gap: "the LLM cannot see data above the reader's
clearance — **by policy**." The clearance model already exists and is DB-enforced;
the agent simply does not use it._

## Problem (verified this turn)

- `apps/api/app/routes/intel.py:385` `GET /api/intel/agent` resolves the user
  best-effort and **degrades to `ctx=None` on auth failure** (L417-419,
  `except HTTPException: ctx = None`). Comment L414: *"token-less/keyless run gets
  ctx=None: the agent keeps every read-only tool."*
- `apps/api/app/intel/agent.py:517` `run_agent(q, bbox, ctx)` — `ctx` is a
  `UserCtx`, which (`keys.py:130`) carries **only `user_id` + `token`. No
  clearance, no compartments.** So the agent has nothing to redact against.
- `apps/api/app/intel/agent.py` calls **no** `classification` / `redact_for`
  (negative grep this turn). Read tools (`TOOLS`, L200) return data straight to
  the LLM and to the `tool_result` SSE frames (L704, L804) with no clearance
  filter.
- The clearance machinery already exists and is the single source of truth:
  - `apps/api/app/intel/classification.py` — `can_read(user_clearance,
    user_compartments, row_level, row_compartments)` (L97), `redact_for(clr,
    comps, rows, *, level_key="classification", comp_key="compartments")` (L126),
    `marking(level, comps)` (L90), 0..4 ladder.
  - `apps/api/app/security.py` — `Principal(clearance:int=0,
    compartments:tuple, roles:tuple)` (L24); resolver `current_principal(request)`
    (L78), **defaults to least-privilege (clearance 0, analyst) on any failure**
    (its own docstring). Already imported by `extract.py`/`collab.py`/`audit.py`.

**Net:** the agent runs with no need-to-know. A static-API-key (keyless) caller, or
any caller, gets the agent's full read surface regardless of the reader's clearance.
RLS protects the ontology tables *when queried with the user's token* — but the
agent path resolves `ctx=None` and its ontology-backed tools may read with an
over-broad/service token (← **must be verified in step 0**, it decides whether this
fix is the sole guard or defense-in-depth).

## Fix (least-privilege, reuse existing parts)

Thread the reader's clearance into `run_agent` and redact every read-tool result
through the existing `redact_for` before it reaches the LLM or the SSE frame.

### Phase 0 — investigate (no code)
Confirm which token the ontology-backed read tools (`intel_brief`, any
`lookup_*` / `baseline` / ontology query in `agent.py` + `intel/analytics.py`)
use to hit Supabase: the **user token** (RLS already filters → this fix is
defense-in-depth) or a **service/anon token** (RLS bypassed → this fix is the
*only* guard). Record the answer in the PR description. Either way the fix is
correct; this just sets the honesty label.

### Phase 1 — backend need-to-know (core)
1. **Route** (`routes/intel.py` agent endpoint): alongside the existing `ctx`
   resolve, add
   `principal = await current_principal(request)` (best-effort; it already
   returns least-privilege clearance 0 on failure — do **not** add a second
   try/except that elevates). Pass `principal.clearance` and
   `principal.compartments` into `run_agent`.
   - Keyless stays allowed (CLAUDE-sanctioned `ctx=None` keyless design) but now
     pinned at **clearance 0 / no compartments** — least privilege, not full read.
2. **`run_agent` signature** (`intel/agent.py:517`): add
   `clearance: int = 0, compartments: tuple[str, ...] = ()` (defaults =
   least-privilege so every existing caller is safe with no change).
3. **Redact in the dispatch loop**: after a read tool returns, filter its rows
   through `redact_for(clearance, compartments, rows)` **before** (a) appending the
   result to the LLM conversation and (b) emitting the `tool_result` frame.
   - Tool results are GeoJSON `FeatureCollection`s; the `classification` lives in
     `feature["properties"]`, not top-level. Add one small helper (in
     `classification.py`, beside `redact_for`):
     `redact_features(clearance, comps, fc)` → returns `fc` with
     `fc["features"]` filtered by `can_read(clr, comps,
     f["properties"].get("classification", 0), f["properties"].get("compartments"))`.
     Plain dicts (ontology rows) keep using `redact_for`.
   - **Honest scope note (state in code + PR):** live OSINT feeds
     (`query_vessels`/`query_aircraft`/`gps_jamming`) carry no `classification`
     field → redaction is a **no-op** on them (defense-in-depth + future-proof).
     The teeth land on ontology-backed rows (`intel_brief`, lookups) that *do*
     carry a level. Do not claim it "secures the feeds" — it secures the
     classified ontology rows.
4. **Surface the level**: include `operated_at_clearance:
   marking(clearance, compartments)` on the agent's `final` (or a one-time `note`)
   frame, so the UI + audit show what level the run executed at. If the agent
   writes an audit row, stamp the effective clearance into its params.

### Phase 2 — tests (gate)
New `apps/api/tests/test_agent_need_to_know.py` (pure-logic, no network — call
`redact_for` / `redact_features` / the new `run_agent` param path with a fake
tool that returns tagged rows):
- keyless ⇒ clearance 0 ⇒ a `{"classification": SECRET}` row is **dropped**; an
  UNCLASSIFIED row passes.
- clearance SECRET ⇒ SECRET row passes, TOP_SECRET row dropped.
- compartment: row needs `["FVEY"]`, user holds none ⇒ dropped; user holds FVEY
  ⇒ passes (case-insensitive).
- `redact_features`: a feature with `properties.classification = SECRET` dropped
  for clearance 0; kept for clearance SECRET.
- regression: the existing `classification.py` `__main__` self-check asserts
  still hold (import + call, or keep as is).

### Phase 3 — frontend banner (optional, skip unless asked)
Show `operated_at_clearance` as a caveat banner in the agent panel
(`apps/web/src/command-bar/*`), reusing `apps/web/src/security/classification.ts`.
Ponytail: skip until the backend is green and someone wants the visual.

## Acceptance
- `cd apps/api && .venv/bin/pytest -q` green, **≥ baseline** (no regression; floor
  ≥25 per CLAUDE.md, current suite far above).
- New test file fails before the agent change, passes after (TDD order).
- If frontend touched: `pnpm -r typecheck` green.
- PR description states the Phase-0 finding (user-token vs service-token) and the
  honest scope note (no-op on unclassified feeds).

## Files
- `apps/api/app/intel/classification.py` — add `redact_features` (+ extend `__main__`).
- `apps/api/app/intel/agent.py` — `run_agent` params + redact in dispatch loop + `operated_at_clearance`.
- `apps/api/app/routes/intel.py` — resolve `current_principal`, pass clearance/comps.
- `apps/api/tests/test_agent_need_to_know.py` — new.
- (opt) `apps/web/src/command-bar/*` — banner.

## Out of scope (named, not silently dropped)
- NOFORN/negative caveats (classification.py v1 treats caveats as positive grants).
- The other Gotham gaps (data-integration platform, Apollo deploy, corpus
  explorer, model-ops, federation) — see `docs/gotham-vs-velocity-2026-06-23.md`
  and this session's gap table.
