# Bitter Lesson audit of the Claude Code harness

Date: 2026-07-05. Scope: everything the model sees or is constrained by before it
reads the user's first word — `~/.claude/` (settings, hooks, skills, plugins,
memory), the project `CLAUDE.md`, the osint-platform-dev skill, and the plugin
stack. All counts below were measured this session.

---

## 1. What the Bitter Lesson actually says

Sutton (2019), re-read from source this session. Four claims that matter here:

1. **General methods that leverage computation beat human-knowledge encoding,
   by a large margin, every time the clock runs long enough.** Chess, Go,
   speech, vision — same arc each time.
2. **The human-knowledge approach wins in the short term and plateaus.**
   That's why it keeps getting rebuilt: it demonstrably helps *today*.
3. **The two general methods are search and learning** — both are ways of
   turning more compute into more capability.
4. The subtle one, and the most relevant to harnesses: built-in human knowledge
   doesn't just become obsolete — it **"complicates methods in ways that make
   them less suited to taking advantage of general methods leveraging
   computation."** The scaffold isn't neutral. It becomes the ceiling.

### The harness corollary

A coding harness is the "features" layer around a model the way hand-crafted
evaluation functions were the layer around minimax. Every element in a harness
is one of two things:

- **Capability expander** — gives the model reach it cannot have alone: tools,
  execution, verification loops, facts about the environment, safety
  boundaries. These get *more* valuable as the model improves (a better model
  exploits a test suite harder).
- **Weakness compensator** — encodes a workaround for how the *current* model
  fails: process rituals, style enforcement, output policing, context
  rationing, prescriptive workflows, model routing tables. These decay into
  pure tax as the model improves, and — Sutton's point 4 — they actively
  block the better model from doing the thing its extra capability enables.

**The test for any harness element:** *if the model were 2× better tomorrow,
does this element help more, or get in the way more?* Expanders pass. Compensators fail.

One more mapping worth making explicit: in agentic coding, the analog of
Sutton's "search" is the **verify-and-retry loop** (run tests, read output,
fix, repeat), and the analog of "learning" is **the next model checkpoint**.
A harness aligned with the Bitter Lesson spends its complexity budget making
verification cheap, fast, and total — and spends almost nothing telling the
model how to think.

### What the Bitter Lesson does NOT say (anti-strawman)

It does not say "delete all human knowledge." Three categories are exempt:

- **Facts about the environment** are data, not scaffolding. "airplanes.live
  rate-limits with HTTP 200 + text/plain", "adsb.lol 451s a non-browser UA",
  "the operator rejected synthesized motion twice" — no amount of model
  improvement rediscovers these without re-paying the cost that learned them.
  Sutton's complaint is about encoding *how to think*, not *what is true*.
- **Safety and authority boundaries** (permissions, commit hooks, "don't touch
  the sacred paths without certainty") are about trust, not capability.
- **Verification infrastructure** is the general method itself.

The failure mode this audit hunts is specifically: *procedural knowledge about
how the model should reason, explore, communicate, and structure its work* —
that's the hand-crafted evaluation function.

---

## 2. Measured inventory (what the harness actually is)

| Element | Measured size / mechanism |
|---|---|
| Skills on disk | **513 SKILL.md files**, 78 top-level dirs, gstack alone **1.5 GB** |
| Skills advertised per session | ~130 entries in the system-prompt skill list, each with a multi-line description |
| Plugins enabled | 14 (superpowers, caveman, ponytail, context-mode, context7 ×2 — plugin **and** claude.ai server, playwright, feature-dev, code-review, supabase, ui-ux-pro-max, frontend-design, skill-creator, security-guidance, claude-md-management) |
| Persona layers | 3 overlapping: caveman (SessionStart + UserPromptSubmit re-injection + statusline), ponytail (SessionStart, full ruleset), project CLAUDE.md "terse symbolic" style section |
| Anti-hallucination | Static contract injected **every user turn** (UserPromptSubmit) + Stop hook grepping the final message for `tests? passed\|parity\|production-ready\|…` and blocking once to force a self-audit |
| Superpowers | Full `using-superpowers` skill text injected at SessionStart; doctrine: *"invoke a skill before ANY response, including clarifying questions"*, plus a 12-row table of forbidden thoughts |
| context-mode | MCP sandbox + FTS5 knowledge base + PreToolUse rerouting + a standing instruction block telling the model not to Read/Bash for observation |
| Project CLAUDE.md | 464 lines: invariants + war stories + response style + exploration procedure + subagent choreography |
| Memory | 71 files / 3,022 lines, 78-line index loaded every session, plus a hand-written retention/decay/promotion policy |
| Global CLAUDE.md | 50 lines (commit hygiene, shell discipline) |
| Hooks (custom) | playwright lock cleaner, context-mode cache heal, anti-hallucination ×2, caveman statusline |

Fixed per-session overhead before the user types a word: the skill list,
plugin instructions, superpowers text, context-mode doctrine, persona rules,
MEMORY.md, and both CLAUDE.md files — on the order of tens of thousands of
tokens of *standing instruction*, most of it procedural.

---

## 3. The audit — element by element

Verdicts: **KEEP** (expander), **SHRINK** (mixed — extract the facts, delete
the procedure), **DELETE** (compensator).

### 3.1 Superpowers mandatory-invocation doctrine — DELETE (the doctrine, not the skills)

The single clearest Bitter Lesson violation in the harness. "If there is a 1%
chance a skill applies you MUST invoke it, before any response, including
clarifying questions" plus a table that pre-labels the model's own judgment
("this is just a simple question") as *rationalization*. This is a 2024-era
patch for models that skipped planning. Applied to a stronger model it is pure
ceiling: it forbids exactly the judgment the capability gain bought, adds a
skill-lookup round trip to trivial questions, and routes work through
prescriptive workflows (brainstorming → writing-plans → …) whether or not the
task needs them. This is Sutton's chess researchers insisting the program play
*the way humans play*.

Keep individual superpowers skills that encode real technique if any earn
their place (see 3.4's usage test); delete the meta-doctrine that makes
invocation compulsory.

### 3.2 Persona stack (caveman + ponytail + CLAUDE.md style section) — DELETE two, SHRINK one

Three separately-maintained systems all trying to control output shape:

- **caveman**: drop articles, fragments, "~75% token cut" — a cost hack from
  when output tokens were the expensive part. Today the standing-instruction
  overhead of running caveman (hook double-fire already bit once —
  see memory `claude-usage-hygiene-2026-07-05`: cost driver = context size,
  **not output**) is comparable to what it saves, and it fights the model's
  own communication calibration.
- **ponytail**: the *values* (YAGNI, stdlib-first, shortest diff) are things a
  strong model already weighs; the *enforcement apparatus* (ladder, levels,
  persistence rules, output format) is scaffold. Notably, the project
  CLAUDE.md already carries the one sentence that matters: "the best code is
  the code you didn't write, because there's less of it to break an invariant."
- **CLAUDE.md response-style section**: symbol grammar (`->`, `✓`, `?`),
  BAD/GOOD examples, exception list.

They also conflict (ponytail full-prose exception vs caveman fragments vs
CLAUDE.md symbols), so some model capacity every turn goes to arbitrating
personas. Replace all three with ~3 lines in CLAUDE.md: *"Terse by default.
Numbers over adjectives. Full prose for commits, docs, security, and anything
where fragment order risks misreading."* A better model does the rest; a
worse model was never saved by the symbol table anyway.

### 3.3 Anti-hallucination apparatus — SHRINK to one standing paragraph; delete the regex police

The *value* is real and operator-chosen (evidence tiers, no assume-then-assert)
— that's an authority boundary, category KEEP. The *mechanism* is the problem:

- The same static contract is injected every user turn. It's already in
  CLAUDE.md, the osint skill, and multiple memories. One canonical copy in
  CLAUDE.md carries the same weight without the N-fold repetition.
- The Stop hook greps the final message for success-phrases and blocks. This
  is lexical policing of a language model — a hand-coded feature detector.
  Its own comments document the decay spiral: bare "verified"/"proven" had to
  be excluded after false blocks. That maintenance treadmill (pattern → false
  positive → carve-out → weaker pattern) is exactly the hand-tuned-features
  arc, and a stronger model triggers it *more* (writes more nuanced success
  claims) while needing it less. Meanwhile a model that wants to bluff just
  avoids the trigger phrases — the hook selects for phrasing, not honesty.

The general-method version of anti-hallucination is **making verification so
cheap the model always runs it**: fast tests, one-command live probes,
screenshot capture. Spend the effort there (§4 Phase 2).

### 3.4 The 513-skill library — SHRINK hard, by a usage test

The skill list advertised each session is ~130 entries; memory + git history
show a handful in actual use (osint-platform-dev, code-review, caveman/ponytail
by hook, context-mode by hook, occasionally playwright, brainstorming/
writing-plans). The rest — a 78-skill gstack suite (ship/qa/canary/cso/
office-hours/…), duplicated reviewers (review vs code-review vs codex vs
cavecrew-reviewer), three QA variants, two design-review variants, **context7
enabled twice** (plugin + claude.ai connector), 1.5 GB on disk — is a library
of *other people's prescriptive workflows*, each one an encoding of how a
human thinks the work should be structured.

Bitter Lesson sorting rule for skills: a skill earns its slot if it encodes
**environment facts or credentials the model cannot infer** (osint-platform-dev,
supabase project specifics, claude-api reference) or **wires a real tool**
(playwright). It does not earn a slot for encoding a reasoning procedure the
model performs natively when asked ("brainstorm", "debug systematically",
"verify before claiming done" — that last one is also duplicated by the hook,
the CLAUDE.md, and the contract).

### 3.5 context-mode — SHRINK to opt-in

An elaborate, well-built workaround for small context windows: sandbox
execution, FTS5 indexing, mandatory rerouting doctrine, PreToolUse hooks. Two
Bitter Lesson problems: (a) it bets against the scaling trend the harness
should be riding — context length and native context management (the harness
already summarizes and continues) are improving on the platform side, faster
and better than a bolt-on; (b) as a *mandatory* doctrine it adds an MCP round
trip + FTS recall risk to interactions where a direct Read was strictly
better, and its standing instruction block is itself a permanent context tax.
Keep the tool for genuinely huge outputs (multi-MB logs, big fetches); delete
the "don't use Read/Bash for observation" doctrine and the auto-rerouting.

### 3.6 Project CLAUDE.md (464 lines) — SPLIT: facts stay, procedure goes, invariants become tests

The most interesting file because it's half treasure, half tax:

- **Treasure (KEEP, ~40%)**: operator decisions with history (teleport-not-
  glide, sanctioned exceptions with dates), upstream API pathologies
  (200+text rate limit, 451-on-UA, FORMAT=tle), boot/env traps (jemalloc
  scrub, .env resolution, run-from-root). Pure environment facts. A 10×
  model cannot rediscover "the operator rejected this twice" — that's not in
  any distribution.
- **Tax (DELETE, ~30%)**: response-style section (see 3.2), "how to explore"
  choreography ("up to 3 haiku explorers in ONE message, disjoint scopes"),
  model-routing prescriptions. These encode June-2026 model economics in
  prose; every model upgrade silently invalidates them, and nobody goes back
  to re-derive them. Prescribing *which model* a subagent uses is a routing
  table that should live in defaults, not doctrine.
- **Upgrade (CONVERT, ~30%)**: the sacred behaviors. Several already have the
  right form — `test_adsb_viewport_stable.py`, `test_adsb_hot_blob.py` guard
  their invariants *executably*. That's the pattern: an invariant enforced by
  a test scales with the model (a better model reads the failing test and
  complies); an invariant enforced by prose scales with nothing and decays
  with every summarization. Every sacred behavior that can fail a command
  should fail a command.

### 3.7 Memory system (71 files + hand-written cognitive policy) — SHRINK

The retention/decay/promotion policy is a hand-designed cognitive architecture
— Sutton names this exact move: building in "how we think we think." The
*content* is largely legitimate (session facts, measured counts, post-mortems
— environment knowledge). The fixes are mechanical: prune superseded entries
(the archive section is the model), collapse near-duplicates (≥4 ADS-B
freshness memories tell one story), stop hand-tooling the policy file, and
let recall be search (ctx / grep over the directory) rather than a curated
78-line index competing for every session's context.

### 3.8 Subagent choreography + shell micro-discipline — SHRINK

"One file one owner" = real coordination constraint, KEEP. "Kill by port not
argv", "run pytest from repo root" = environment facts, KEEP (they're
post-mortems of real breakage). "52% of past Bash calls prefixed cd" stats,
per-agent model pinning, effort prescriptions = compensators; the harness's
own defaults (inherit model, agent picks effort) are the general method.

### 3.9 Things that already pass the test — KEEP, and grow

- Permission allowlists, commit-msg hook (authority boundaries — and the
  commit hook is *enforcement in code*, the right substrate).
- `scripts/kill-port.sh`, `run-api.sh` (tools).
- The test suite + typecheck as commit gates (verification = the general
  method; the 711-passed baseline discipline is exactly right).
- Playwright/browser tooling (capability).
- File-based memory as a substrate (it's the policy layer on top that's over-built).

---

## 4. Upgrade plan

Ordering principle: delete tax first (free wins), then convert prose to
executable checks (the real Bitter Lesson investment), then set the standing
rule that stops re-accretion. Each phase is independently shippable.

### Phase 0 — Measure the baseline (half a day)
1. Count fixed per-session token overhead: dump a fresh session's system
   prompt + injected hook context; record total and per-source breakdown
   (skill list, superpowers, context-mode, personas, MEMORY.md, CLAUDE.mds).
2. Snapshot `~/.claude` (it has a `backups/` dir already) so every later phase
   is reversible.
3. Success metric for the whole plan: **fixed overhead down ≥60%, zero loss of
   environment facts, sacred-invariant coverage moved from prose to tests.**

### Phase 1 — Delete pure compensators (1 day, config-only)
1. Disable persona plugins (caveman, ponytail) + their hooks/statusline; add
   the 3-line style note to global CLAUDE.md.
2. Remove superpowers SessionStart injection / the mandatory-invocation
   doctrine. Keep the plugin's skills available for explicit `/` invocation
   only.
3. Delete the per-turn anti-hallucination UserPromptSubmit injection and the
   Stop-hook regex. Fold ONE canonical evidence-contract paragraph (tiers +
   banned-without-count words) into the project CLAUDE.md — it's an operator
   authority boundary and stays, in its cheapest form.
4. De-dupe context7 (drop one of the two). Disable plugins with no usage in
   history (candidates: ui-ux-pro-max, frontend-design, skill-creator,
   feature-dev, claude-md-management, supabase-when-idle) — re-enable on demand.
5. Uninstall or archive unused skill suites (gstack: 78 skills/1.5 GB → keep
   the ~2 with evidence of use, if any). Target: advertised skill list ≤25.
6. Make context-mode advisory: remove the PreToolUse rerouting + the
   "don't Read/Bash" doctrine; keep ctx tools for >100 KB outputs.

### Phase 2 — Convert prose invariants to executable checks (the core investment, ~1 week incremental)
For each sacred behavior in CLAUDE.md, add the cheapest check that fails loud:
1. Frontend invariants (SVG-never-dots, upsert-never-removeAll,
   requestRenderMode:true, apiFetch-wraps-all, labels via labelStyle): vitest
   asserts + eslint `no-restricted-syntax` bans (`removeAll(`, raw
   `new WebSocket(`, raw `fetch(` outside transport/) — grep-level rules, big
   payoff, model-proof.
2. Backend invariants without tests yet (≥8k snapshot floor as an opt-in live
   probe, semaphore=8, `global_snapshot()`-not-route-handler for internal
   callers): pytest additions following the existing
   `test_adsb_viewport_stable.py` pattern.
3. One `scripts/verify.sh`: typecheck + pytest + (optional flag) live smoke
   (blob diff on `seen_pos_s`, sidecar health, vessel/aircraft counts). One
   command = the model's verify-retry loop gets maximally cheap — this is the
   "search" investment.
4. Then shrink CLAUDE.md: each invariant becomes 1-2 lines of *why* + a
   pointer to its enforcing test. Target ≤150 lines. History/rationale prose
   moves to `docs/decisions.md` (grep-able, not context-resident).

### Phase 3 — Restructure what remains to be model-upgrade-proof (ongoing)
1. **No model names in prose.** Remove haiku/fable routing advice from
   CLAUDE.md + skills; subagents inherit by default. Model choice lives only
   in `settings.json`, one place to update per model generation.
2. **Skills = facts + tools only.** Adopt the sorting rule from 3.4 for every
   future skill; audit survivors annually.
3. **Memory prune**: collapse duplicates, delete superseded, keep MEMORY.md
   ≤40 lines; new-memory bar = "environment fact a fresh model cannot
   rediscover."
4. **Style/effort knobs → settings, not prose.** Anything expressible as a
   harness setting comes out of the instruction stream.

### Phase 4 — Reinvest the freed budget in general methods
Where the complexity budget *should* go, in order of leverage:
1. Verification depth: screenshot-diff harness for the sacred visual
   invariants (icons/labels/smoothness) so "drag to Europe and look" becomes
   a command; live-probe scripts with counts (the anti-hallucination
   *mechanism* that actually scales).
2. Environment capability: faster test subsets, seeded fixtures for feed
   code, a real-hardware fps probe (the one measurement headless can't do).
3. Let better models spend compute freely: with rituals gone, longer
   autonomous verify-retry loops replace instruction-following overhead.

### The standing rule (add to global CLAUDE.md, replaces pages of process)

> Before adding anything to the harness — skill, hook, memory, CLAUDE.md line —
> classify it: **environment fact** (keep, state it once), **authority/safety
> boundary** (keep, enforce in code where possible), or **compensation for a
> current-model weakness** (add only with a dated sunset note, and prefer a
> verification check over an instruction). If a better model would make it
> unnecessary, it's a compensator.

---

## 5. Execution log (2026-07-05 — plan carried out same day)

All phases executed; evidence produced in-session.

**P0 — measured + snapshotted.** Rollback tarball:
`~/.claude/backups/bitter-lesson-pre-20260705.tar.gz` (147,829 B — settings,
hooks, both CLAUDE.mds' sources, memory dir, plugin config). Measured fixed
overhead drivers: project CLAUDE.md 29,238 B (~7.3k tok), MEMORY.md 18,207 B
(~4.5k tok), superpowers injection 3,063 B, anti-hallucination contract
~1.1k B × every user turn, plus the ~130-entry advertised skill list.

**P1 — compensators deleted (global).**
- `~/.claude/settings.json`: 12 of 14 plugins disabled (kept playwright,
  code-review); anti-hallucination UserPromptSubmit + Stop hooks removed;
  caveman statusline removed; context-mode plugin disabled entirely (its
  mandatory-rerouting doctrine can't be separated from the plugin — re-enable
  on demand for multi-MB analysis). context7 de-duped (local plugin off,
  claude.ai connector remains).
- Skills: 78 dirs → 2 (graphify, local-media); 76 moved to
  `~/.claude/skills-archived/` (gstack alone was 1.5 GB; dir now 116 KB).
- Global `~/.claude/CLAUDE.md`: 3-line style note + one canonical
  evidence-contract paragraph (operator authority, kept deliberately) +
  standing rule. Persona plugins gone.

**P2 — prose invariants → executable guards (repo).**
- `apps/web/eslint.config.js`: `no-restricted-globals` bans raw `fetch`
  outside transport/ + two documented third-party ignores;
  `no-restricted-syntax` bans `removeAll()` inside PollGeoJsonAdapter.
  Lint green.
- `apps/web/src/globe/invariants.test.ts`: renderMode opts, upsert-by-id,
  SVG palette, withWsKey-on-every-WebSocket. 35 files / 194 tests passed.
- `apps/api/tests/test_invariants.py`: semaphore=8, global_snapshot()-only,
  FORMAT=tle, LD_PRELOAD scrub, ≥8k floor (opt-in `OSINT_LIVE_PROBE=1`).
  4 passed + 1 skipped.
- `scripts/verify.sh` (one-command static + `--live` feed probes) and
  `scripts/screenshot-globe.mjs` (P4 visual-invariant capture).
- CLAUDE.md 464 → ~120 lines (invariant + guard pointer); full history and
  post-mortems moved to `docs/decisions.md`.
- Full suite after changes: **715 passed, 1 skipped** (was 711; +4 new
  guards, +1 opt-in skip). `pnpm -r typecheck` exit 0 (needed a types-only
  `@types/node` devDep in apps/web for the node-fs source-scan test).

**P3 — model-upgrade-proofing.** Model pinning removed from
osint-platform-dev SKILL.md (haiku prescriptions → default inheritance);
stale ~684 baseline reference replaced with a pointer to CLAUDE.md;
superpowers skill references dropped. MEMORY.md index 78 → ~40 lines,
grouped; ~20 entries whose content now lives in `docs/decisions.md` moved to
the archive section (files kept on disk).

**P4 — reinvestment (minimal viable).** `verify.sh --live` = the
blob-freshness diff (`seen_pos_s` % changed over 8 s), aircraft-count floor,
vessel count, sidecar :8090/:8093 health — the anti-hallucination mechanism
that scales. `screenshot-globe.mjs` captures the Europe verification view
for content diffs (headless = content only, never fps). Deeper items (fps
probe on hardware, seeded feed fixtures) remain open.

**Rollback:** untar the P0 snapshot over `~/.claude/`, `git checkout` the
repo files, `mv ~/.claude/skills-archived/* ~/.claude/skills/`.

## 6. Risks and honest caveats

- **Compensators exist because they paid off once.** Caveman/superpowers/the
  Stop hook each fixed a real observed failure. The claim is not that they
  never worked — it's Sutton's claim: they plateau, then obstruct. If Phase 1
  regressions appear (e.g. verbose replies, skipped verification), the fix is
  a *check* (Phase 2 style), not re-installing the ritual.
- **The evidence contract is operator authority, not scaffold** — this plan
  keeps it deliberately. Deleting it would be misreading the Bitter Lesson as
  "trust the model about everything." Trust boundaries are orthogonal to
  capability.
- **Prose-to-test conversion can ossify too**: a test encoding a wrong
  invariant blocks a better model just like prose. Mitigation: every guard
  test's docstring cites the operator decision + date, so it can be
  deliberately revoked, exactly like the sanctioned-exception pattern already
  used in CLAUDE.md.
- Phase 0's measurement matters: if fixed overhead turns out small relative to
  session work, Phases 1's urgency drops (the ceiling argument still stands —
  doctrine conflicts cost quality, not just tokens).
