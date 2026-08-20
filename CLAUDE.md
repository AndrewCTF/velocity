# CLAUDE.md — invariants for any agent editing this repo

Method + architecture map: `.claude/skills/osint-platform-dev/`. Full decision
history, dates, and post-mortems: `docs/decisions.md` — read the entry before
changing any guarded behavior. When files disagree, this one wins.

Most invariants are enforced by executable guards; `bash scripts/verify.sh`
runs all of them (`--live` adds feed probes against :8000). A guard failure
means an operator decision regressed — fix the code, or revoke the decision
deliberately by changing BOTH the guard and the file that states it.

## Operating rules

1. **Evidence over assertion.** Never write done/works/fixed without the
   command + output, screenshot, or file:line THIS turn. Tag claims
   proven-live / plumbed-unverified / not-built. The words global / complete /
   full / parity are banned without a live count this turn.
2. **Query the knowledge graph first.** `graphify-out/graph.json` (~10k nodes,
   auto-rebuilt by a global post-commit hook) answers "what calls X / where
   does Y live / how do these relate" — `graphify query "<question>"`. Then
   **read the real signatures** of the 3-4 files you'll depend on before
   writing code against them; the graph orients, source is ground truth.
3. **Find the reuse first.** ~80% of any new feature already exists as a
   substrate (stores, bus, adapters, brief fusion). Extending beats rebuilding.
4. **Change the minimum, name what you skipped.** Every regression here came
   from a confident "cleanup" of code whose history the editor didn't know.
5. **"Stale/slow/empty" → probe the BACKEND first** (diff two
   `/api/adsb/global` pulls on `seen_pos_s`; sidecar `:8090`/`:8093` health —
   `scripts/verify.sh --live` does both). The frontend faithfully mirrors a
   frozen blob; no frontend change fixes a backend problem.

## Where the invariants live

Each directory states the rules that govern it, and they load when you work
there. Read the one for the code you are about to touch — the guards fail loud
regardless, but the file tells you which operator decision you are about to
undo and why it was made.

| Directory | Covers |
| --- | --- |
| `apps/web/CLAUDE.md` | icons and labels, refresh and motion, the no-synthesis rule, auth wrappers, dashboard copy and voice |
| `apps/api/CLAUDE.md` | snapshot cadence and union, AIS, sidecar supervision, egress tiers, ontology, model prose |
| `apps/ml/CLAUDE.md` | which of the three venvs each module needs |
| `apps/desktop/CLAUDE.md` | Tauri watcher excludes, YOLO sidecar env |
| `packages/shared/CLAUDE.md` | the web↔api contract, `Observation.t` semantics |
| `tools/CLAUDE.md` | feeder processes, the real-Chrome tier, perf harnesses |
| `scripts/CLAUDE.md` | boot, verify, kill-port, deploy |
| `infra/CLAUDE.md` | the two SQL trees and which one you actually want |

## Environment facts / traps

- Backend tests from the **repo ROOT** (from `apps/api` the `.env` auth
  resolves → wall of 401s):
  `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q`
  Baseline: **2400 passed + 2 skipped in ~143 s** (skip = opt-in live probes;
  measured 2026-08-20, branch feed-honesty-2026-08, measured source health).
  Runs SERIAL by default: `-n auto --dist
  loadfile` groups different files per worker on different core counts, so a
  suite with module-state leaks answers differently per machine and CI (4 cores)
  failed a branch that was green locally (16). Opt in per-machine, never commit
  it as the default. Never commit below the baseline you inherited. When you raise it, update the number/date/wave here and move the
  displaced line to `docs/decisions.md#backend-test-baseline-history` — this
  bullet stays a three-line fact, not a changelog.
- `pnpm -r typecheck` green at every commit boundary. `bash scripts/verify.sh`
  = typecheck + lint + web unit + api tests in one command.
- Boot: `bash scripts/run-api.sh` from repo ROOT (:8000), Vite :5173. Restart
  the backend ONCE and wait — repeated restarts get the egress rate-limited.
  Kill servers by port: `scripts/kill-port.sh <port>`. Details and the jemalloc
  trap: `scripts/CLAUDE.md`.
- Keyless is a product requirement, not a dev convenience: ADS-B grid, Baltic
  AIS, MyShipTracking, ShipXplorer, USGS quakes, Carto basemap, and CelesTrak
  all keep working with no API key. FIRMS degrades gracefully without MAP_KEY.

## Subagents

One file, one owner — serialize edits to shared files. A subagent editing under
a directory must be given that directory's `CLAUDE.md` rules, or it will not see
them.

Match model to judgment density, not prestige (operator directive 2026-07-14;
sunset when default routing catches up): breadth exploration and signature
extraction go to Explore/Plan agents on the inherited/default model — haiku
handles "return the exact def lines, file:line, NOT FOUND if absent" fine.
Pin a heavy model (opus/fable) only for judgment-dense stages — adversarial
review, invariant-adjacent design, debugging that resists you — and say why.
Never default every subagent to the biggest model.

## Verification before claiming done

`bash scripts/verify.sh` green. UI claims have a specific walkthrough and
performance claims have existing harnesses — do not invent a number. See
`apps/web/CLAUDE.md` and `tools/CLAUDE.md` respectively.
