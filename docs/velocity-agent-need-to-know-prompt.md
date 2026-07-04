# Implementation prompt — paste into a fresh Claude Code session

> Copy everything in the fenced block below into Claude. It is self-contained,
> TDD-ordered, and ends with a test loop that will not let Claude claim done
> without green pytest output.

```
Implement "AI need-to-know on the intel agent" per docs/velocity-agent-need-to-know-plan.md.
Goal: the /api/intel/agent tool-calling loop must redact every read-tool result to the
caller's clearance/compartments BEFORE the data reaches the LLM or the SSE tool_result
frame — reusing the EXISTING classification + security modules. Least privilege: keyless
caller ⇒ clearance 0.

RULES OF ENGAGEMENT
- Read docs/velocity-agent-need-to-know-plan.md first. It has the file:line map.
- Invoke the test-driven-development skill and the verification-before-completion skill.
- TDD strict: write the failing test FIRST, watch it fail, then implement, then green.
- Do NOT invent new clearance logic. Reuse classification.can_read / redact_for / marking
  and security.current_principal. One file, one owner — touch only the files the plan lists.
- Honesty: do NOT claim the fix "secures the feeds." Live OSINT feeds carry no
  classification field (no-op); the teeth are on classified ontology rows. Say that in the
  PR and in a code comment.
- Never write done/passing/green without pasting the actual `pytest -q` tail that proves it.

STEP 0 — INVESTIGATE (no code, ~5 min)
Determine which token the ontology-backed read tools (intel_brief and any lookup_/baseline/
ontology query reached from agent.py via intel/analytics.py) use to hit Supabase: the
user's token (RLS already filters) or a service/anon token (RLS bypassed). Write the answer
in one line to use later in the PR body. This sets whether the fix is the sole guard or
defense-in-depth. Do not change behavior based on it — just record it.

STEP 1 — RED: write the failing test
Create apps/api/tests/test_agent_need_to_know.py covering:
  - redact_for: clearance 0 drops {"classification": 3}, keeps {"classification": 0}.
  - redact_for: clearance 3 keeps level 3, drops level 4.
  - compartment: row needs ["FVEY"], holder of () dropped; holder of ("fvey",) kept (case-insensitive).
  - redact_features (NEW helper you are about to add): a FeatureCollection
    {"type":"FeatureCollection","features":[{"properties":{"classification":3}}, {"properties":{"classification":0}}]}
    filtered at clearance 0 keeps only the level-0 feature; at clearance 3 keeps both.
Run: cd apps/api && .venv/bin/pytest -q tests/test_agent_need_to_know.py
Confirm it FAILS (redact_features does not exist yet). Paste the failure tail.

STEP 2 — GREEN part A: classification.redact_features
In apps/api/app/intel/classification.py add, beside redact_for:
  def redact_features(user_clearance, user_compartments, fc): -> fc with fc["features"]
  filtered by can_read(clr, comps, f["properties"].get("classification", 0),
  f["properties"].get("compartments")). Tolerate a non-dict / missing "features" by
  returning fc unchanged. Extend the __main__ self-check with one redact_features assert.
Re-run the new test file until the redact_features cases pass.

STEP 3 — GREEN part B: thread clearance into run_agent
In apps/api/app/intel/agent.py:
  - run_agent signature (currently run_agent(q, bbox, ctx) at ~L517): add
    clearance: int = 0, compartments: tuple[str, ...] = () with those defaults.
  - In the tool-dispatch loop, after a read tool (TOOLS) returns its result, redact it
    BEFORE it is appended to the LLM conversation AND before the tool_result frame is
    emitted: FeatureCollection -> classification.redact_features(clearance, compartments, result);
    plain list[dict] -> classification.redact_for(clearance, compartments, result).
    Leave ACTION_TOOLS / CONTROL_TOOLS untouched.
  - Add operated_at_clearance: classification.marking(clearance, compartments) to the final
    frame (and/or a one-time note frame).
Add a focused test in the same file: a fake read tool returning a FeatureCollection with one
SECRET + one UNCLASSIFIED feature, driven through the redaction path, asserts the SECRET
feature is gone at clearance 0 and present at clearance 3. (Call the redaction seam directly
if running the full SSE loop is heavy — test the unit, not the network.)

STEP 4 — GREEN part C: wire the route
In apps/api/app/routes/intel.py agent endpoint (~L385): after the existing ctx resolve, add
  principal = await current_principal(request)   # already least-privilege on failure
and pass principal.clearance, principal.compartments into run_agent(...). Import
current_principal from app.security (mirror extract.py's import). Do NOT add a try/except
that elevates clearance on error — least privilege.

STEP 5 — LOOP: verify until green AND no regression
Run the loop below. Do not stop until BOTH conditions hold, pasting the tail each iteration:
  cd apps/api && .venv/bin/pytest -q
  (a) the new tests pass, AND
  (b) total passed >= the pre-change baseline (run pytest ONCE before Step 1 and record it;
      a lower count = you broke something — fix it, do not delete tests).
If red: apply the systematic-debugging skill, fix the smallest root cause, re-run. Repeat.
If you touched any apps/web file: also run `pnpm -r typecheck` and get it green.

STEP 6 — REPORT
Summarize: files changed, the Step-0 finding (user-token vs service-token), the honest scope
note (no-op on unclassified feeds; teeth on ontology rows), and paste the final pytest tail
showing passed >= baseline. Tier every claim proven-live / plumbed-unverified. Do NOT mention
any AI tool in commit messages (global hook strips it; write human-style). Do not commit
unless asked.
```

## Optional: run the loop autonomously

Instead of babysitting Step 5, you can hand the whole prompt to the self-pacing loop:

```
/loop implement docs/velocity-agent-need-to-know-plan.md following docs/velocity-agent-need-to-know-prompt.md; each iteration run `cd apps/api && .venv/bin/pytest -q`, fix the top failure, stop when the new tests pass and total passed >= baseline
```

The loop re-enters until the test condition holds, then ends itself.
