# Gotham Gap Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Gotham/AIP capability gaps from `~/.claude/plans/tidy-singing-lightning.md` Part 2/3: graph History helper, orphan cleanup, human-in-the-loop action approval, need-to-know LLM redaction, metrics-over-time strategic effects, Stencil templated planning, and desktop FMV live-detection fusion.

**Architecture:** Every task reuses an existing module (zustand stores, `history.db` sqlite, the audited `actions.py` dispatch, the `intel/agent.py` SSE loop, ReportsApp tabs, the Tauri YOLO sidecar). No new services, no new dependencies. Backend gates are server-side (the agent runs server-side, so a frontend-only gate would be bypassable).

**Tech Stack:** React 18 + zustand + vitest (apps/web), FastAPI + sqlite + pytest (apps/api), Tauri `detect_image` command (desktop only, task 7).

## Status corrections vs. the source gap map (verified 2026-07-03)

- **Cap #22 (typed write-back Actions) is NOT a full gap.** `apps/api/app/routes/actions.py` already exposes `GET /api/actions` (catalog) + `POST /api/actions/{name}` → `dispatch(name, params, ctx)` with an audit receipt, and `routes/intel.py:403` documents the agent invoking "the audited write-back actions (flag_entity / promote_incident / …)". The real gap is cap #20: those actions run **without operator approval**. Task 3 fixes that.
- The two orphans (`SelectionBar.tsx`, `CommandDock.tsx`) still exist and have **zero importers** (grep verified).
- `MetricsPanel.tsx:70` already polls `/api/history/timeseries` — Task 5 adds the *ops-events* rollup, not raw counts.
- The need-to-know spec already exists at `docs/velocity-agent-need-to-know-plan.md`; Task 4 executes it.

## Global Constraints

- `pnpm -r typecheck` green at every commit boundary (CLAUDE.md).
- `apps/api/.venv/bin/pytest -q` run **from the repo root** (running from `apps/api` picks up `.env` auth → 143×401 failures), ≥25 passed floor.
- Do not touch `PollGeoJsonAdapter`, `styles.ts`, `requestRenderMode`, snapshot/decimation code — all guardrailed in CLAUDE.md; nothing in this plan needs them.
- Commit messages: human voice, no AI attribution of any kind (global commit-msg hook enforces; don't test it).
- Words "global/complete/full/parity" banned from code/commits unless measured this turn.
- One file, one owner: tasks 3 and 4 both edit `intel/agent.py` and `routes/intel.py` — **execute Task 3 fully before Task 4** (or vice versa), never in parallel.
- Branch: continue on `gotham-console-rebuild`.

---

### Task 1: Delete the two orphaned command-bar files (P0)

**Files:**
- Delete: `apps/web/src/command-bar/SelectionBar.tsx`
- Delete: `apps/web/src/command-bar/CommandDock.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — pure deletion. Superseded by `Omnibar.tsx` / `AgentConsole.tsx`.

- [ ] **Step 1: Re-verify zero importers (state may have moved since planning)**

Run:
```bash
grep -rn "SelectionBar\|CommandDock" apps/web/src --include="*.ts" --include="*.tsx" | grep -v "command-bar/SelectionBar.tsx\|command-bar/CommandDock.tsx"
```
Expected: no output. If any importer appears, STOP and wire instead of delete (decision per `ConsoleShell.overlayLeft` slot) — do not delete a file that gained an importer.

- [ ] **Step 2: Delete both files**

```bash
git rm apps/web/src/command-bar/SelectionBar.tsx apps/web/src/command-bar/CommandDock.tsx
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -r typecheck`
Expected: green (exit 0).

- [ ] **Step 4: Commit**

```bash
git commit -m "Remove dead SelectionBar and CommandDock (superseded by Omnibar/AgentConsole)"
```

---

### Task 2: Graph History helper — change-over-time + author + scrubber (P0, cap #11)

Gotham's Graph "History" helper shows how the canvas changed over time and who changed it. Our canvas state lives in `InvestigationCanvas.tsx` component state (`objects: Map<string, OntObject>` at line ~199, `edges: OntLink[]` at ~200); the zustand store (`graph/investigationStore.ts`) holds only `rootId`/`openSeq`. We record a revision (author + timestamp + node-id snapshot) into the store at every mutation, and a small `GraphHistory` component renders the revision list + a scrubber; scrubbing filters the rendered node set to the selected revision (read-only view, no refetch).

**Files:**
- Modify: `apps/web/src/graph/investigationStore.ts` (extend the existing `create<InvestigationState>` — keep `rootId`/`openSeq`/`searchAround`/`setRoot`/`clear` exactly as they are)
- Create: `apps/web/src/graph/GraphHistory.tsx`
- Modify: `apps/web/src/graph/InvestigationCanvas.tsx` (record calls at mutation sites; filter render set when scrubbed; mount `<GraphHistory />`)
- Test: `apps/web/src/graph/investigationStore.test.ts`

**Interfaces:**
- Produces (store additions, exact):
```ts
export interface GraphRevision {
  ts: number;            // epoch ms
  author: string;        // 'operator' for now (single-operator console)
  kind: 'root' | 'expand' | 'remove' | 'clear' | 'path';
  label: string;         // human line, e.g. 'expanded vessel:123 (+6 nodes)'
  nodeIds: string[];     // node-id set AFTER the change
}
// added to InvestigationState:
//   revisions: GraphRevision[];
//   viewRev: number | null;                       // null = live
//   record: (r: Omit<GraphRevision, 'ts' | 'author'>) => void;
//   setViewRev: (i: number | null) => void;
```
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing store test**

Create `apps/web/src/graph/investigationStore.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useInvestigation } from './investigationStore.js';

describe('graph history revisions', () => {
  beforeEach(() => {
    useInvestigation.getState().clear();
  });

  it('records revisions with author + timestamp', () => {
    useInvestigation.getState().record({ kind: 'root', label: 'seed a', nodeIds: ['a'] });
    useInvestigation.getState().record({ kind: 'expand', label: 'expand a (+2)', nodeIds: ['a', 'b', 'c'] });
    const revs = useInvestigation.getState().revisions;
    expect(revs).toHaveLength(2);
    expect(revs[1]!.nodeIds).toEqual(['a', 'b', 'c']);
    expect(revs[0]!.author).toBe('operator');
    expect(revs[0]!.ts).toBeGreaterThan(0);
  });

  it('scrub pointer set + cleared, and clear() wipes history', () => {
    useInvestigation.getState().record({ kind: 'root', label: 'seed', nodeIds: ['a'] });
    useInvestigation.getState().setViewRev(0);
    expect(useInvestigation.getState().viewRev).toBe(0);
    useInvestigation.getState().setViewRev(null);
    expect(useInvestigation.getState().viewRev).toBeNull();
    useInvestigation.getState().clear();
    expect(useInvestigation.getState().revisions).toHaveLength(0);
  });

  it('caps revisions at 200 (drop oldest)', () => {
    for (let i = 0; i < 210; i++) {
      useInvestigation.getState().record({ kind: 'expand', label: `r${i}`, nodeIds: ['a'] });
    }
    const revs = useInvestigation.getState().revisions;
    expect(revs).toHaveLength(200);
    expect(revs[0]!.label).toBe('r10');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @osint/web exec vitest run src/graph/investigationStore.test.ts`
Expected: FAIL — `record is not a function` (property missing from state).

- [ ] **Step 3: Extend the store**

In `apps/web/src/graph/investigationStore.ts`, add the `GraphRevision` interface (exact shape from Interfaces above), then extend the state interface and the `create` body. New/changed lines only — keep every existing field and action:

```ts
const MAX_REVISIONS = 200;

// inside interface InvestigationState:
  revisions: GraphRevision[];
  viewRev: number | null;
  record: (r: Omit<GraphRevision, 'ts' | 'author'>) => void;
  setViewRev: (i: number | null) => void;

// inside create<InvestigationState>((set) => ({ ... })):
  revisions: [],
  viewRev: null,
  record: (r) =>
    set((s) => ({
      revisions: [...s.revisions, { ...r, ts: Date.now(), author: 'operator' }].slice(-MAX_REVISIONS),
      viewRev: null, // any live mutation returns the view to live
    })),
  setViewRev: (i) => set({ viewRev: i }),
```
And change the existing `clear` to also wipe history:
```ts
  clear: () => set({ rootId: null, revisions: [], viewRev: null }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @osint/web exec vitest run src/graph/investigationStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `GraphHistory.tsx`**

```tsx
// History helper for the investigation canvas — Gotham-style "graph change over
// time + who changed it". Read-only: scrubbing filters the rendered node set to
// the chosen revision; any live mutation snaps back to live.
import { useInvestigation } from './investigationStore.js';

export function GraphHistory() {
  const revisions = useInvestigation((s) => s.revisions);
  const viewRev = useInvestigation((s) => s.viewRev);
  const setViewRev = useInvestigation((s) => s.setViewRev);
  if (revisions.length === 0) return null;
  const at = viewRev ?? revisions.length - 1;
  return (
    <div className="border-t border-line-1 px-2 py-1.5 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-txt-3">History</span>
        <input
          type="range"
          min={0}
          max={revisions.length - 1}
          value={at}
          onChange={(e) => {
            const i = Number(e.currentTarget.value);
            setViewRev(i === revisions.length - 1 ? null : i);
          }}
          className="flex-1"
          aria-label="Graph history scrubber"
        />
        {viewRev !== null && (
          <button type="button" className="text-acc-1" onClick={() => setViewRev(null)}>
            live
          </button>
        )}
      </div>
      <ol className="mt-1 max-h-24 overflow-y-auto">
        {revisions.map((r, i) => (
          <li key={r.ts + ':' + i} className={i === at ? 'text-txt-1' : 'text-txt-3'}>
            <button type="button" onClick={() => setViewRev(i === revisions.length - 1 ? null : i)}>
              {new Date(r.ts).toLocaleTimeString()} · {r.author} · {r.label} · {r.nodeIds.length} nodes
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
```
(Match the exact utility-class vocabulary used inside `InvestigationCanvas.tsx` — read its className strings and reuse the same text/border tokens; the ones above follow the repo's `text-txt-*`/`border-line-*` convention.)

- [ ] **Step 6: Wire recording + scrub filtering into `InvestigationCanvas.tsx`**

Three edits (find each site by the anchors given):

1. **Record on load/expand.** Wherever the canvas commits fetched graph data (`setObjects(...)` + `setEdges(...)` after the ontology fetch — one site for the root seed, one for node expansion `expanding`), add immediately after the state commit:
```ts
useInvestigation.getState().record({
  kind: isRootSeed ? 'root' : 'expand',
  label: isRootSeed ? `seed ${rootId}` : `expanded ${expandedId} (+${added} nodes)`,
  nodeIds: [...nextObjects.keys()],
});
```
where `nextObjects` is the Map just committed and `added` = size delta. Use the local variables actually present at each site; the required data is the post-commit id set.

2. **Record on remove.** In `removeNode` (`InvestigationCanvas.tsx:289`), after computing the pruned map:
```ts
useInvestigation.getState().record({ kind: 'remove', label: `removed ${id}`, nodeIds: [...pruned.keys()] });
```

3. **Filter when scrubbed.** In the memo that produces the rendered node/edge arrays, read `const viewRev = useInvestigation((s) => s.viewRev);` and `revisions`, and when `viewRev !== null`:
```ts
const visible = new Set(revisions[viewRev]!.nodeIds);
// render only objects whose id is in `visible`; drop edges touching hidden ids
```
Also render a banner when scrubbed: `viewing revision {viewRev + 1}/{revisions.length} — click "live" to return`, and mount `<GraphHistory />` at the bottom of the canvas panel layout.

- [ ] **Step 7: Typecheck + full web test run**

Run: `pnpm -r typecheck && pnpm --filter @osint/web exec vitest run`
Expected: both green; pre-existing test count not reduced.

- [ ] **Step 8: Live check (per CLAUDE.md verification rules)**

With `:8000` + `:5173` up: open the Graph app, seed a root (click an entity → search-around), expand a node, remove a node. Expected: History strip lists 3 revisions with timestamps + "operator"; dragging the scrubber back hides the removed/expanded nodes; "live" returns. If the Playwright profile lock bites: `rm ~/.cache/ms-playwright-mcp/*/Singleton{Lock,Cookie,Socket}`.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/graph/
git commit -m "Graph history helper: revision log with author and scrubber"
```

---

### Task 3: Human-in-the-loop action checkpoints (P1, cap #20 + AIP confidence gating)

Today the intel agent (server-side, `intel/agent.py`, streamed by `routes/intel.py:403+`) executes write-back actions (flag_entity, promote_incident, …) directly. Gate them: when approval mode is ON (default), the agent's action tool-call becomes a **proposal**; the operator approves/rejects in AgentConsole; approval executes through the existing audited `dispatch`. Confidence gating: an action whose model-reported confidence ≥ `action_auto_threshold` auto-executes (default threshold 1.01 = never auto — safe default, AIP-style knob).

**Files:**
- Modify: `apps/api/app/config.py` (2 settings)
- Modify: `apps/api/app/routes/actions.py` (proposal store + 3 routes)
- Modify: `apps/api/app/intel/agent.py` (gate at the action-tool dispatch branch)
- Modify: `apps/web/src/command-bar/AgentConsole.tsx` (render proposal rows + approve/reject)
- Test: `apps/api/tests/test_action_proposals.py`

**Interfaces:**
- Produces (backend, exact):
  - `config.Settings.action_approval: bool = True` (env `ACTION_APPROVAL`), `config.Settings.action_auto_threshold: float = 1.01` (env `ACTION_AUTO_THRESHOLD`).
  - `actions.propose(name: str, params: dict, ctx) -> str` (returns `proposal_id`).
  - `GET /api/actions/proposals` → `[{id, name, params, created, confidence}]`
  - `POST /api/actions/proposals/{pid}/approve` → `ActionResult` (executes via `dispatch`)
  - `POST /api/actions/proposals/{pid}/reject` → `{ok: true, id}`
  - New SSE frame from the agent: `{"type": "action_proposal", "proposal_id": str, "action": str, "params": dict, "confidence": float}`
- Consumes: existing `dispatch(name, params, ctx)` and `list_actions()` from the actions layer; existing `current_user` dep.

- [ ] **Step 1: Write the failing backend test**

Create `apps/api/tests/test_action_proposals.py`:
```python
import time

import pytest

from app.routes import actions as actions_mod


@pytest.fixture(autouse=True)
def _clean_proposals():
    actions_mod._PROPOSALS.clear()
    yield
    actions_mod._PROPOSALS.clear()


def test_propose_stores_and_lists():
    pid = actions_mod.propose("flag_entity", {"entity_id": "vessel:1"}, ctx=None, confidence=0.4)
    assert pid in actions_mod._PROPOSALS
    row = actions_mod._PROPOSALS[pid]
    assert row["name"] == "flag_entity"
    assert row["params"] == {"entity_id": "vessel:1"}
    assert row["confidence"] == 0.4


def test_expired_proposal_pruned():
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    actions_mod._PROPOSALS[pid]["created"] = time.time() - actions_mod.PROPOSAL_TTL_S - 1
    actions_mod._prune_proposals()
    assert pid not in actions_mod._PROPOSALS


@pytest.mark.anyio
async def test_approve_executes_and_removes(monkeypatch):
    calls: list[tuple] = []

    async def fake_dispatch(name, params, ctx):
        calls.append((name, params))
        return {"ok": True, "action": name}

    monkeypatch.setattr(actions_mod, "dispatch", fake_dispatch)
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    result = await actions_mod.approve_proposal(pid, ctx=None)
    assert calls == [("flag_entity", {"entity_id": "v"})]
    assert pid not in actions_mod._PROPOSALS
    assert result["ok"] is True


@pytest.mark.anyio
async def test_reject_removes_without_execute(monkeypatch):
    async def boom(name, params, ctx):  # must never run
        raise AssertionError("dispatch called on reject")

    monkeypatch.setattr(actions_mod, "dispatch", boom)
    pid = actions_mod.propose("flag_entity", {"entity_id": "v"}, ctx=None, confidence=0.0)
    out = await actions_mod.reject_proposal(pid, ctx=None)
    assert out == {"ok": True, "id": pid}
    assert pid not in actions_mod._PROPOSALS
```
Note: match the repo's existing async-test convention — check a neighbouring test file (`ls apps/api/tests | head`) for `pytest.mark.anyio` vs `pytest.mark.asyncio` and use whichever the suite already uses. If `approve_proposal`/`reject_proposal` take the FastAPI `ctx: UserCtx = Depends(current_user)` signature, call them in tests with `ctx=None` (keyless path) exactly as other route tests in this suite do.

- [ ] **Step 2: Run test to verify it fails**

Run: `apps/api/.venv/bin/pytest apps/api/tests/test_action_proposals.py -q` (from repo root)
Expected: FAIL — `AttributeError: module 'app.routes.actions' has no attribute '_PROPOSALS'`.

- [ ] **Step 3: Add settings**

In `apps/api/app/config.py`, beside the other feature flags (follow the file's existing `Field`/env pattern exactly):
```python
    action_approval: bool = True   # HITL gate: agent write-back actions need operator approval
    action_auto_threshold: float = 1.01  # auto-execute when model confidence >= this (1.01 = never)
```

- [ ] **Step 4: Implement the proposal layer in `routes/actions.py`**

Add below the existing imports/routes (reusing the module's `dispatch`, `ActionResult`, `current_user`, `UserCtx` names as they already appear in the file):
```python
import time
import uuid

# In-memory HITL proposal queue. Single-process console; restart drops pending
# proposals, which is acceptable — the agent re-proposes on the next run.
_PROPOSALS: dict[str, dict] = {}
PROPOSAL_TTL_S = 900


def _prune_proposals() -> None:
    cutoff = time.time() - PROPOSAL_TTL_S
    for pid in [p for p, row in _PROPOSALS.items() if row["created"] < cutoff]:
        _PROPOSALS.pop(pid, None)


def propose(name: str, params: dict, ctx, confidence: float = 0.0) -> str:
    _prune_proposals()
    pid = uuid.uuid4().hex[:12]
    _PROPOSALS[pid] = {
        "id": pid, "name": name, "params": params,
        "created": time.time(), "confidence": confidence,
    }
    return pid


@router.get("/api/actions/proposals")
async def list_proposals(ctx: UserCtx = Depends(current_user)) -> list[dict]:
    _prune_proposals()
    return sorted(_PROPOSALS.values(), key=lambda r: r["created"])


@router.post("/api/actions/proposals/{pid}/approve")
async def approve_proposal(pid: str, ctx: UserCtx = Depends(current_user)):
    _prune_proposals()
    row = _PROPOSALS.pop(pid, None)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return await dispatch(row["name"], row["params"], ctx)


@router.post("/api/actions/proposals/{pid}/reject")
async def reject_proposal(pid: str, ctx: UserCtx = Depends(current_user)) -> dict:
    row = _PROPOSALS.pop(pid, None)
    if row is None:
        raise HTTPException(status_code=404, detail="unknown or expired proposal")
    return {"ok": True, "id": pid}
```
The audit trail: `dispatch` already writes the audit row on approve-execute; add `"approved_by": getattr(ctx, "user_id", "keyless")` into the params it audits only if `dispatch`'s audit call site accepts extras — otherwise skip (the audit row's actor is already the approving ctx, which is the fact that matters).

- [ ] **Step 5: Run backend test to verify it passes**

Run: `apps/api/.venv/bin/pytest apps/api/tests/test_action_proposals.py -q` (repo root)
Expected: 4 passed.

- [ ] **Step 6: Gate the agent's action dispatch**

In `apps/api/app/intel/agent.py`, locate the tool-dispatch branch that executes write-back actions: `grep -n "flag_entity\|promote_incident\|dispatch\|run_action" apps/api/app/intel/agent.py`. At the point where an action tool is about to execute, insert the gate (adapting variable names to the loop's own — the tool name, its parsed args, and the per-step event `yield`):
```python
from ..config import get_settings  # match the module's existing settings import style
from ..routes.actions import propose

settings = get_settings()
confidence = float(args.pop("confidence", 0.0) or 0.0)
if settings.action_approval and confidence < settings.action_auto_threshold:
    pid = propose(tool_name, args, ctx, confidence=confidence)
    yield {
        "type": "action_proposal",
        "proposal_id": pid,
        "action": tool_name,
        "params": args,
        "confidence": confidence,
    }
    tool_result = {"queued": True, "proposal_id": pid,
                   "note": "action queued for operator approval; do not retry"}
    # feed tool_result back to the LLM conversation as the tool's result, then continue the loop
else:
    ...  # existing execute path unchanged
```
Also add `confidence` (number, 0–1, "model's confidence this action is correct") to the action tools' JSON-schema parameter blocks where those tool specs are defined in the same file, so the model can supply it. If the SSE relay in `routes/intel.py` whitelists frame types, add `action_proposal` to that whitelist (the comment at `routes/intel.py:435` says new frame types must reach the browser — follow whatever mechanism that comment describes).

- [ ] **Step 7: Frontend — proposal rows in AgentConsole**

In `apps/web/src/command-bar/AgentConsole.tsx`:
1. Extend `TraceRow` (line ~58) with `proposal?: { id: string; action: string; params: Record<string, unknown>; confidence: number; state: 'pending' | 'approved' | 'rejected' | 'error' }`.
2. In the SSE `switch` (near the existing `case 'action':` at ~202) add:
```ts
case 'action_proposal': {
  const row: TraceRow = {
    id: Number(ev['step'] ?? t.length),
    proposal: {
      id: String(ev['proposal_id'] ?? ''),
      action: String(ev['action'] ?? ''),
      params: (ev['params'] ?? {}) as Record<string, unknown>,
      confidence: Number(ev['confidence'] ?? 0),
      state: 'pending',
    },
    status: 'done',
  };
  setTrace((prev) => [...prev, row]);
  break;
}
```
3. Render pending proposals with two buttons; on click:
```ts
const decide = async (pid: string, verb: 'approve' | 'reject') => {
  try {
    await apiFetch(`/api/actions/proposals/${pid}/${verb}`, { method: 'POST' });
    setTrace((prev) => prev.map((r) =>
      r.proposal?.id === pid ? { ...r, proposal: { ...r.proposal, state: verb === 'approve' ? 'approved' : 'rejected' } } : r
    ));
  } catch {
    setTrace((prev) => prev.map((r) =>
      r.proposal?.id === pid ? { ...r, proposal: { ...r.proposal, state: 'error' } } : r
    ));
  }
};
```
Row copy: `PROPOSED: {action} {JSON.stringify(params)} · conf {confidence.toFixed(2)}` + `[Approve] [Reject]`, state chip after decision. Reuse the exact row styling of the existing `action` rows.

- [ ] **Step 8: Full verification**

Run (repo root): `apps/api/.venv/bin/pytest -q apps/api/tests` → ≥ prior pass count. Then `pnpm -r typecheck` → green.
Live: open AgentConsole, run a prompt that triggers a write-back ("flag vessel X as suspicious"). Expected: a PROPOSED row with Approve/Reject, no action executes until Approve; after Approve the action receipt appears. Set `ACTION_APPROVAL=false` env → old direct behaviour returns.

- [ ] **Step 9: Commit**

```bash
git add apps/api/app/config.py apps/api/app/routes/actions.py apps/api/app/intel/agent.py apps/api/tests/test_action_proposals.py apps/web/src/command-bar/AgentConsole.tsx
git commit -m "Gate agent write-back actions behind operator approval with confidence threshold"
```

---

### Task 4: Need-to-know redaction on the intel agent (P1, cap #28)

The full spec already exists: **`docs/velocity-agent-need-to-know-plan.md`** — execute it as written. Summary of its phases (the doc is authoritative on details; its Files section lists exact paths):

**Files (from the spec):**
- Modify: `apps/api/app/intel/classification.py` — add `redact_features(clearance, comps, fc)` (features filtered by `properties.classification` / `properties.compartments`), extend its `__main__` self-check.
- Modify: `apps/api/app/intel/agent.py` — `run_agent(... , clearance: int = 0, compartments: tuple[str, ...] = ())`; redact every read-tool result through `redact_for`/`redact_features` **before** it reaches the LLM conversation and the SSE `tool_result` frame; emit `operated_at_clearance: marking(clearance, compartments)` on the final frame.
- Modify: `apps/api/app/routes/intel.py` — `principal = await current_principal(request)` (best-effort, failure ⇒ clearance 0), pass clearance/compartments into `run_agent`. Keyless stays allowed, pinned at clearance 0.
- Create: `apps/api/tests/test_agent_need_to_know.py` — pure-logic tests (keyless drops SECRET rows; SECRET clearance passes SECRET, drops TOP_SECRET; compartment FVEY held/not-held; `redact_features` on tagged features).

**Interfaces:**
- Consumes: Task 3's changes to `intel/agent.py` are already committed (serialise: Task 3 first — both tasks edit `agent.py`/`intel.py`).
- Produces: `redact_features` in `classification.py`; `run_agent` clearance params (defaults = least-privilege, so all existing callers unchanged).

- [ ] **Step 1: Phase 0 investigation** — confirm whether ontology read tools hit Supabase with the user token (RLS filters → this is defense-in-depth) or a service/anon token (this fix is the only guard). Record the answer in the commit body.
- [ ] **Step 2: Write `test_agent_need_to_know.py` exactly per the spec's Phase 2 list** (five cases, pure-logic, no network). Run: `apps/api/.venv/bin/pytest apps/api/tests/test_agent_need_to_know.py -q` (repo root) → Expected: FAIL (`redact_features` undefined).
- [ ] **Step 3: Implement Phase 1 items 1–4 from the spec** (route principal → `run_agent` params → dispatch-loop redaction → `operated_at_clearance` surfacing). Honest-scope comment required in code: live OSINT feeds carry no `classification` → redaction is a no-op on them; the teeth are on ontology-backed rows.
- [ ] **Step 4: Run the new test** → PASS; then the full suite (repo root) → ≥ prior count.
- [ ] **Step 5: Commit**

```bash
git add apps/api/app/intel/classification.py apps/api/app/intel/agent.py apps/api/app/routes/intel.py apps/api/tests/test_agent_need_to_know.py
git commit -m "Redact intel-agent tool results by reader clearance before LLM and SSE"
```
(Phase 3 frontend banner: skip — spec marks it optional.)

---

### Task 5: Metrics-over-time / strategic effects (P2, cap #17 — White-Paper Fig 5)

Record operational events (F2T2EA stage transitions, action executions) into the existing `history.db`, roll them up server-side, render an "Operational effects" section in MetricsPanel: counts by kind/outcome, hourly cadence, median time-to-approval (confirm→execute stage duration).

**Files:**
- Modify: `apps/api/app/history.py` (new `ops_events` table + `record_op` + `ops_rollup`)
- Modify: `apps/api/app/routes/history.py` (new `GET /api/history/ops`)
- Modify: `apps/api/app/routes/targets.py` (record stage transitions)
- Modify: `apps/api/app/routes/actions.py` (record action executions — single line in `run_action`/approve path)
- Modify: `apps/web/src/metrics/MetricsPanel.tsx` (new section)
- Test: `apps/api/tests/test_history_ops.py`

**Interfaces:**
- Produces (exact):
  - `history.record_op(kind: str, subject: str, detail: str) -> None` — fire-and-forget insert (`kind` ∈ `'stage' | 'action' | 'alert'`).
  - `history.ops_rollup(window_sec: int) -> dict` → `{"counts": {kind: n}, "per_hour": [{"t": epoch, "n": int}], "stage_flow": {"confirm->fix": n, ...}, "median_confirm_to_execute_s": float | None, "window_sec": int}`
  - `GET /api/history/ops?window_sec=86400` → that dict.
- Consumes: `history.override_db_path` (exists, `history.py:53`) for test isolation; `_connect()` (`history.py:92`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/test_history_ops.py`:
```python
import time

from app import history


def test_ops_record_and_rollup(tmp_path):
    history.override_db_path(str(tmp_path / "ops.db"))
    try:
        now = time.time()
        history.record_op("stage", "vessel:1", "confirm->fix")
        history.record_op("stage", "vessel:1", "fix->track")
        history.record_op("action", "flag_entity", "ok")
        out = history.ops_rollup(window_sec=3600)
        assert out["counts"] == {"stage": 2, "action": 1}
        assert out["stage_flow"]["confirm->fix"] == 1
        assert sum(b["n"] for b in out["per_hour"]) == 3
        assert out["window_sec"] == 3600
    finally:
        history.override_db_path(None)


def test_time_to_execute_median(tmp_path):
    history.override_db_path(str(tmp_path / "ops2.db"))
    try:
        history._record_op_at("stage", "t:a", "confirm->fix", ts=1000.0)
        history._record_op_at("stage", "t:a", "assess->execute", ts=1600.0)
        history._record_op_at("stage", "t:b", "confirm->fix", ts=2000.0)
        history._record_op_at("stage", "t:b", "assess->execute", ts=2400.0)
        out = history.ops_rollup(window_sec=10_000_000_000)
        assert out["median_confirm_to_execute_s"] == 500.0  # median of 600, 400
    finally:
        history.override_db_path(None)


def test_rollup_empty_window(tmp_path):
    history.override_db_path(str(tmp_path / "ops3.db"))
    try:
        out = history.ops_rollup(window_sec=60)
        assert out["counts"] == {}
        assert out["median_confirm_to_execute_s"] is None
    finally:
        history.override_db_path(None)
```

- [ ] **Step 2: Run to verify it fails**

Run: `apps/api/.venv/bin/pytest apps/api/tests/test_history_ops.py -q` (repo root)
Expected: FAIL — `AttributeError: module 'app.history' has no attribute 'record_op'`.

- [ ] **Step 3: Implement in `history.py`**

```python
_OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS ops_events (
  ts REAL NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_ts ON ops_events (ts);
"""


def _ensure_ops(conn: sqlite3.Connection) -> None:
    conn.executescript(_OPS_SCHEMA)


def _record_op_at(kind: str, subject: str, detail: str, ts: float) -> None:
    with _connect() as conn:
        _ensure_ops(conn)
        conn.execute(
            "INSERT INTO ops_events (ts, kind, subject, detail) VALUES (?, ?, ?, ?)",
            (ts, kind, subject, detail),
        )


def record_op(kind: str, subject: str, detail: str) -> None:
    """Fire-and-forget op event; never raises into the caller's request path."""
    try:
        _record_op_at(kind, subject, detail, ts=time.time())
    except Exception:  # noqa: BLE001 — telemetry must not break the op itself
        pass


def ops_rollup(window_sec: int) -> dict[str, Any]:
    t_from = time.time() - max(60, int(window_sec))
    counts: dict[str, int] = {}
    per_hour: dict[int, int] = {}
    stage_flow: dict[str, int] = {}
    starts: dict[str, float] = {}
    durations: list[float] = []
    with _connect() as conn:
        _ensure_ops(conn)
        rows = conn.execute(
            "SELECT ts, kind, subject, detail FROM ops_events WHERE ts >= ? ORDER BY ts",
            (t_from,),
        ).fetchall()
    for ts, kind, subject, detail in rows:
        counts[kind] = counts.get(kind, 0) + 1
        bucket = int(ts // 3600) * 3600
        per_hour[bucket] = per_hour.get(bucket, 0) + 1
        if kind == "stage":
            stage_flow[detail] = stage_flow.get(detail, 0) + 1
            if detail.startswith("confirm->"):
                starts.setdefault(subject, ts)
            if detail.endswith("->execute") and subject in starts:
                durations.append(ts - starts.pop(subject))
    durations.sort()
    n = len(durations)
    median = None if n == 0 else (durations[n // 2] if n % 2 else (durations[n // 2 - 1] + durations[n // 2]) / 2)
    return {
        "counts": counts,
        "per_hour": [{"t": t, "n": c} for t, c in sorted(per_hour.items())],
        "stage_flow": stage_flow,
        "median_confirm_to_execute_s": median,
        "window_sec": int(window_sec),
    }
```
Match the module's actual import names (`sqlite3`, `time`, `Any` are already imported there — verify, add if missing). `override_db_path(None)` restore in tests keeps the shared suite db untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `apps/api/.venv/bin/pytest apps/api/tests/test_history_ops.py -q` (repo root) → Expected: 3 passed.

- [ ] **Step 5: Route + hooks**

`routes/history.py` (follow the existing endpoints' shape at lines 20/53/64):
```python
@router.get("/api/history/ops")
async def get_ops(window_sec: int = Query(86400, ge=60, le=7 * 86400)) -> dict:
    return await asyncio.to_thread(history.ops_rollup, window_sec)
```
`routes/targets.py`: in the PATCH/stage-transition handler, right where the stage change commits (old + new stage in scope):
```python
from .. import history
history.record_op("stage", entity_id, f"{old_stage}->{new_stage}")
```
`routes/actions.py`: at the end of the execute path (both `run_action` and `approve_proposal` funnel through `dispatch`; add it once immediately after a successful `dispatch` return in each route, or once inside the actions layer next to the audit write if that is a single choke point — prefer the single choke point):
```python
history.record_op("action", name, "ok")
```

- [ ] **Step 6: MetricsPanel section**

In `apps/web/src/metrics/MetricsPanel.tsx`, add a second fetch beside the existing `/api/history/timeseries` poll (line ~70), same cadence and `apiFetch` pattern:
```ts
const ops = await apiFetch('/api/history/ops?window_sec=86400', { cache: 'no-store' });
```
Render an "OPERATIONAL EFFECTS (24H)" block using the panel's existing tile/chart primitives (reuse whatever the panel already renders KPI tiles and the timeseries chart with — same components, same classNames):
- KPI tiles: total stage moves, total actions, `median_confirm_to_execute_s` formatted `mm:ss` (or "—" when null).
- Bar list: `stage_flow` entries sorted desc.
- Area/bar strip: `per_hour` buckets (reuse the exact chart element used for the existing timeseries).

- [ ] **Step 7: Verify**

Repo-root: `apps/api/.venv/bin/pytest -q apps/api/tests` ≥ prior; `pnpm -r typecheck` green.
Live: move a target one stage on the Targeting board, run one action, open Reports → Metrics. Expected: counts appear within one poll cycle.

- [ ] **Step 8: Commit**

```bash
git add apps/api/app/history.py apps/api/app/routes/history.py apps/api/app/routes/targets.py apps/api/app/routes/actions.py apps/api/tests/test_history_ops.py apps/web/src/metrics/MetricsPanel.tsx
git commit -m "Ops-events rollup: stage and action telemetry with 24h effects dashboard"
```

---

### Task 6: Stencil — templated mission planning + AAR history (P2, cap #15)

Frontend-only slide/section builder in ReportsApp: pick a doctrinal template, edit seeded sections, export HTML (same export mechanism BriefPanel uses), keep per-op drafts + exported-ops history in localStorage for After-Action Review.

**Files:**
- Create: `apps/web/src/reports/stencil.ts` (templates + store logic, pure — testable)
- Create: `apps/web/src/reports/StencilPanel.tsx`
- Modify: `apps/web/src/reports/ReportsApp.tsx` (add "Stencil" tab beside Case files / Brief / Intel brief / Metrics / News / Collab)
- Test: `apps/web/src/reports/stencil.test.ts`

**Interfaces:**
- Produces (exact, in `stencil.ts`):
```ts
export interface StencilSection { title: string; body: string }
export interface StencilDoc {
  id: string; template: TemplateId; title: string;
  sections: StencilSection[]; createdAt: number; exportedAt: number | null;
}
export type TemplateId = 'opord' | 'conop' | 'aar';
export const TEMPLATES: Record<TemplateId, { name: string; sections: string[] }> = {
  opord: { name: 'OPORD (5-paragraph)', sections: ['Situation', 'Mission', 'Execution', 'Sustainment', 'Command & Signal'] },
  conop: { name: 'CONOP brief', sections: ['Purpose', 'End state', 'Scheme of maneuver', 'Assets & timing', 'Risks & mitigations'] },
  aar: { name: 'After-Action Review', sections: ['What was planned', 'What happened', 'Why it happened', 'What to fix'] },
};
export function newDoc(template: TemplateId, title: string): StencilDoc;
export function saveDoc(doc: StencilDoc): void;            // localStorage 'stencil:<id>' + index 'stencil:index'
export function listDocs(): StencilDoc[];                  // newest first
export function deleteDoc(id: string): void;
export function renderHtml(doc: StencilDoc): string;       // standalone exportable HTML string
```
- Consumes: nothing from other tasks. Export/download: replicate BriefPanel's blob-download (read `reports/BriefPanel.tsx` first and reuse its exact download helper if it exports one; otherwise the standard `URL.createObjectURL(new Blob([html], {type:'text/html'}))` + anchor click).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/reports/stencil.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TEMPLATES, newDoc, saveDoc, listDocs, deleteDoc, renderHtml } from './stencil.js';

describe('stencil docs', () => {
  beforeEach(() => localStorage.clear());

  it('newDoc seeds sections from the template', () => {
    const d = newDoc('opord', 'Op NORTHERN WATCH');
    expect(d.sections.map((s) => s.title)).toEqual(TEMPLATES.opord.sections);
    expect(d.exportedAt).toBeNull();
  });

  it('save/list/delete round-trip via localStorage', () => {
    const d = newDoc('aar', 'AAR 1');
    saveDoc(d);
    expect(listDocs().map((x) => x.id)).toEqual([d.id]);
    deleteDoc(d.id);
    expect(listDocs()).toEqual([]);
  });

  it('renderHtml contains title and every section', () => {
    const d = newDoc('conop', 'CONOP X');
    d.sections[0]!.body = 'Strait of Hormuz overwatch';
    const html = renderHtml(d);
    expect(html).toContain('CONOP X');
    for (const s of TEMPLATES.conop.sections) expect(html).toContain(s);
    expect(html).toContain('Strait of Hormuz overwatch');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @osint/web exec vitest run src/reports/stencil.test.ts`
Expected: FAIL — cannot resolve `./stencil.js`.

- [ ] **Step 3: Implement `stencil.ts`**

```ts
// Stencil: doctrinal-template planning docs (Gotham "Palantir Stencil" analogue).
// localStorage-backed; export = standalone HTML via renderHtml.
export interface StencilSection { title: string; body: string }
export type TemplateId = 'opord' | 'conop' | 'aar';
export interface StencilDoc {
  id: string; template: TemplateId; title: string;
  sections: StencilSection[]; createdAt: number; exportedAt: number | null;
}

export const TEMPLATES: Record<TemplateId, { name: string; sections: string[] }> = {
  opord: { name: 'OPORD (5-paragraph)', sections: ['Situation', 'Mission', 'Execution', 'Sustainment', 'Command & Signal'] },
  conop: { name: 'CONOP brief', sections: ['Purpose', 'End state', 'Scheme of maneuver', 'Assets & timing', 'Risks & mitigations'] },
  aar: { name: 'After-Action Review', sections: ['What was planned', 'What happened', 'Why it happened', 'What to fix'] },
};

const INDEX_KEY = 'stencil:index';

export function newDoc(template: TemplateId, title: string): StencilDoc {
  return {
    id: Math.random().toString(36).slice(2, 10),
    template,
    title,
    sections: TEMPLATES[template].sections.map((t) => ({ title: t, body: '' })),
    createdAt: Date.now(),
    exportedAt: null,
  };
}

function readIndex(): string[] {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as string[]; } catch { return []; }
}

export function saveDoc(doc: StencilDoc): void {
  localStorage.setItem(`stencil:${doc.id}`, JSON.stringify(doc));
  const idx = readIndex();
  if (!idx.includes(doc.id)) localStorage.setItem(INDEX_KEY, JSON.stringify([doc.id, ...idx]));
}

export function listDocs(): StencilDoc[] {
  return readIndex()
    .map((id) => { try { return JSON.parse(localStorage.getItem(`stencil:${id}`) ?? 'null') as StencilDoc | null; } catch { return null; } })
    .filter((d): d is StencilDoc => d !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteDoc(id: string): void {
  localStorage.removeItem(`stencil:${id}`);
  localStorage.setItem(INDEX_KEY, JSON.stringify(readIndex().filter((x) => x !== id)));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderHtml(doc: StencilDoc): string {
  const sections = doc.sections
    .map((s) => `<section><h2>${esc(s.title)}</h2><p>${esc(s.body).replace(/\n/g, '<br/>')}</p></section>`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>body{font-family:ui-monospace,monospace;max-width:820px;margin:2rem auto;padding:0 1rem;background:#0b0e14;color:#d6dbe4}h1{border-bottom:1px solid #2a3040;padding-bottom:.4rem}h2{color:#8fa3c0;text-transform:uppercase;font-size:.85rem;letter-spacing:.08em}</style>
</head><body><h1>${esc(doc.title)}</h1><p>${esc(TEMPLATES[doc.template].name)} · ${new Date(doc.createdAt).toISOString()}</p>
${sections}</body></html>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @osint/web exec vitest run src/reports/stencil.test.ts` → Expected: 3 passed.

- [ ] **Step 5: Build `StencilPanel.tsx` + tab**

`StencilPanel.tsx`: three zones, styled with the same tokens ReportsApp's other panels use (read `BriefPanel.tsx` for the exact classNames):
1. Doc list (from `listDocs()`): title + template + created + exported badge; New-doc row = template `<select>` (options from `TEMPLATES`) + title input + Create button (`newDoc` → `saveDoc` → select).
2. Editor for the selected doc: one `<textarea>` per section under its `<h3>{section.title}</h3>`, `onChange` → update local state → `saveDoc` (debounce 500 ms with a `setTimeout` ref).
3. Toolbar: **Export HTML** → `renderHtml(doc)` → blob download named `${doc.title.replace(/\W+/g, '-')}.html`, then `saveDoc({...doc, exportedAt: Date.now()})` — the exported list IS the AAR history; **New AAR from this op** → `newDoc('aar', 'AAR — ' + doc.title)` seeded with section 1 body = the op's Situation/Purpose text (copy `doc.sections[0].body`).

In `ReportsApp.tsx`, add `'stencil'` to the tab union + tab strip (label "Stencil") + `{tab === 'stencil' && <StencilPanel />}` following the exact pattern of the existing tabs.

- [ ] **Step 6: Verify**

`pnpm -r typecheck && pnpm --filter @osint/web exec vitest run` → green.
Live: Reports → Stencil → create OPORD doc → type into Situation → Export HTML downloads a file containing the text → doc shows "exported" badge → New AAR seeds from it.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/reports/stencil.ts apps/web/src/reports/stencil.test.ts apps/web/src/reports/StencilPanel.tsx apps/web/src/reports/ReportsApp.tsx
git commit -m "Stencil planning docs: doctrinal templates with HTML export and AAR history"
```

---

### Task 7: FMV live-detection fusion — desktop only (P3, cap #14)

`fmv/FmvPanel.tsx` today draws a synthetic frame + notional detections from `detections.ts`. The desktop (Tauri) build has a real YOLO sidecar via the `detect_image`/`detect_status` commands (`src-tauri/src/infer.rs`). Fusion: in the desktop shell only, add a **LIVE** source mode — grab a still from a selected public camera (the same source `cams/CamerasPanel.tsx` uses), run it through `detect_image`, and feed real boxes into the existing detection-triage pipeline. Web build stays exactly as-is (notional, labeled).

**Files:**
- Modify: `apps/web/src/fmv/detections.ts` (add `fromYolo` mapper)
- Modify: `apps/web/src/fmv/FmvPanel.tsx` (source toggle + live loop, Tauri-gated)
- Test: `apps/web/src/fmv/detections.test.ts` (mapper only — the Tauri path is desktop-verified, not unit-testable in jsdom)

**Interfaces:**
- Produces (exact, in `detections.ts`):
```ts
export interface YoloBox { cls: string; conf: number; x1: number; y1: number; x2: number; y2: number } // pixel coords
export function fromYolo(boxes: YoloBox[], frameW: number, frameH: number): DetectionCandidate[];
// maps each box to the panel's existing DetectionCandidate shape (normalized 0..1 coords,
// class mapped through the existing DetectionClass vocabulary; unknown YOLO classes -> 'unknown')
```
- Consumes: `DetectionCandidate`, `DetectionClass` (already exported from `detections.ts` — read the exact field names there before writing the mapper; the test below must construct expectations against the REAL shape). Tauri: `detect_image` command signature from `apps/desktop/src-tauri/src/infer.rs` (read it for the exact param/return JSON — it returns YOLO boxes + class names from `yolo_sidecar.py`).

- [ ] **Step 1: Read the two contracts** — `apps/web/src/fmv/detections.ts` (`DetectionCandidate` fields, `DetectionClass` values) and `apps/desktop/src-tauri/src/infer.rs` (`detect_image` args/return). Write them into the test as constants.

- [ ] **Step 2: Write the failing mapper test**

Create `apps/web/src/fmv/detections.test.ts` — adjust field names to the real `DetectionCandidate` after Step 1; structure:
```ts
import { describe, it, expect } from 'vitest';
import { fromYolo } from './detections.js';

describe('fromYolo', () => {
  it('normalizes pixel boxes to 0..1 and maps classes', () => {
    const out = fromYolo(
      [{ cls: 'truck', conf: 0.81, x1: 64, y1: 36, x2: 128, y2: 72 }],
      640, 360,
    );
    expect(out).toHaveLength(1);
    // real assertions written against the actual DetectionCandidate fields read in Step 1:
    // center/size normalized (0.15, 0.15) size (0.1, 0.1) — or x/y/w/h if that is the shape
  });

  it('drops boxes below confidence 0.25 and maps unknown classes to the fallback class', () => {
    const out = fromYolo(
      [
        { cls: 'zebra', conf: 0.9, x1: 0, y1: 0, x2: 10, y2: 10 },
        { cls: 'car', conf: 0.1, x1: 0, y1: 0, x2: 10, y2: 10 },
      ],
      100, 100,
    );
    expect(out).toHaveLength(1); // low-conf dropped; zebra kept under fallback class
  });
});
```

- [ ] **Step 3: Run to verify it fails** — `pnpm --filter @osint/web exec vitest run src/fmv/detections.test.ts` → FAIL (`fromYolo` not exported).

- [ ] **Step 4: Implement `fromYolo`** in `detections.ts`, following the class vocabulary already defined there (map YOLO's vehicle/person/boat/airplane class names onto the panel's `DetectionClass` values; anything unmapped → the panel's existing catch-all class; drop `conf < 0.25`). Run the test → PASS.

- [ ] **Step 5: LIVE mode in `FmvPanel.tsx`**

Gated on the desktop shell:
```ts
const isDesktop = typeof window !== 'undefined' && '__TAURI__' in window;
```
When `isDesktop`, render a `NOTIONAL / LIVE` source toggle (default NOTIONAL — web behaviour byte-identical) plus a camera `<select>` populated from the same endpoint `cams/CamerasPanel.tsx` fetches (read that file and reuse its fetch + typing). LIVE loop (every 5 s, `setInterval` cleaned up on unmount/toggle-off):
```ts
const { invoke } = await import('@tauri-apps/api/core'); // dynamic import — web bundle must not require it
const img = await apiFetch(camStillUrl);                  // still-frame bytes via the existing proxy the cams panel uses
const b64 = /* arrayBuffer -> base64 */;
const res = await invoke('detect_image', { imageB64: b64 }); // exact arg name from infer.rs (Step 1)
const cands = fromYolo(res.boxes, res.width, res.height);
// feed cands into the SAME state the notional generator feeds (the triage pipeline,
// bounding-box canvas draw, and class counters all work unchanged)
```
If `@tauri-apps/api` is not already a web dependency, do NOT add it — use `(window as any).__TAURI__.core.invoke` (the global Tauri injects), keeping the web bundle dependency-free. Overlay caption when LIVE: `LIVE · {cameraName} · YOLO {res.boxes.length} det` replacing the notional caption. Detection provenance honesty: LIVE mode label must say "camera still + local YOLO", never "FMV" — there is no real full-motion feed.

- [ ] **Step 6: Verify**

`pnpm -r typecheck && pnpm --filter @osint/web exec vitest run src/fmv` → green (web).
Desktop: `pnpm --filter @osint/web build` then run the Tauri app with `VELOCITY_YOLO_PYTHON=~/.venv/bin/python`; open FMV panel → LIVE → pick a camera. Expected evidence: app log shows `detect_image` round-trips (`yolo sidecar ready on cuda:0` + per-call detections); boxes render on the frame canvas. Wayland has no screenshot backend — verify via logs + in-app counters, per repo memory. Web build check: toggle absent in the browser at `:5173`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/fmv/
git commit -m "FMV live mode on desktop: camera stills through the YOLO sidecar"
```

---

## Deferred capabilities — implementation sketches (not tasks; build only on request)

Per the source plan these are out of scope (high effort, low marginal value for a single-operator console). One-paragraph path each so nothing is silently dropped:

- **#4 Provenance lineage graph:** ObjectInspector Properties already shows per-record provenance. Full lineage = a `lineage(entity_id) -> [{source, ts, transform}]` walk over the ingest tiers (feed slice → union dedup → enrichment) recorded as breadcrumbs at each merge point in `routes/adsb.py`/`resolve.py`, rendered as a small DAG in the Properties tab. Blocked on wanting it: adds a dict per contact per cycle on the hot path — measure before shipping.
- **#13 Proactive AI insights on the COP:** a periodic (60 s) backend job that runs the existing standing-detection sweep output through the `fast` LLM tier with a "what changed that matters" prompt, emitting at most one Inbox item per sweep. Reuse `watch.py` candidates + `inbox` subscription plumbing. Cost-gated behind a settings toggle, default OFF.
- **#18 Multi-LLM router:** extend `llm.py`'s ladder into a per-request router keyed on tier + task tags (json/tools/vision) once a second capable local model earns a distinct role. Today's ladder + `prefer_local` already covers the single-operator case.
- **#19 NL→ontology tool framework:** generalize the agent's hand-written tool list into tools generated from `ontology.py` object types (one `query_<type>` per type, schema from the type's properties). Mechanical, ~1 day, valuable only when the ontology grows past the current hand-picked set.
- **#21 Operator feedback → model refinement:** log Approve/Reject decisions from Task 3's proposals (they already land in the audit trail) and inject the last N decisions into the agent's system prompt as few-shot guidance ("operator rejected flag_entity on fishing vessels without AIS gaps"). Cheap once Task 3 ships; needs a few weeks of decisions to be non-noise.
- **#24 Workshop app-builder:** out of scope entirely — a form/layout builder is a product, not a feature.
- **#26 Marking propagation:** extend Task 4's `redact_features` so derived products (briefs, exports, incident fusions) compute their marking as the max of their inputs' classifications and stamp it into the export header. Natural follow-on after Task 4 lands.

## Execution order + suite gates

1 → 2 (frontend-only, independent) → 3 → 4 (serialized: both touch `intel/agent.py` + `routes/intel.py`) → 5 → 6 (independent of each other; 5 touches `routes/actions.py`, so after 3) → 7 (desktop, independent).

After every task: `pnpm -r typecheck` green + repo-root `apps/api/.venv/bin/pytest -q apps/api/tests` at ≥ the prior pass count. Final CLAUDE.md live check once all land: Europe camera drag (icons not dots), aircraft click → panel + magenta track ≤ 4 s, empty-click clears, 30 s no blink.
