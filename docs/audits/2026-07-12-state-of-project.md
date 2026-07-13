# State of project — 2026-07-12

Read-only audit. Working tree `evidence-locker-hardening-pr` @ `caa5eae`,
content-identical to `origin/master` (`git diff HEAD origin/master` empty;
HEAD is 0 ahead / 2 merge-commits behind). All evidence in this file was
produced live this session unless a citation says otherwise.

## Phase 0 — Ground truth

**verify.sh: ALL GREEN, baseline matches exactly.** typecheck + lint pass,
web unit 320/320 (52 files), ruff clean, **pytest 1539 passed + 1 skipped**
— exactly the CLAUDE.md baseline (1539+1). No drift.

**Live probes** (backend already up on :8000, so the `--live` additions were
run standalone): `/api/adsb/global` returned 20 000 features (limit-capped;
floor is 8 000) with **80% of 19 942 common ids refreshing `seen_pos_s` over
8 s** — feeds healthy, blob not frozen. Sidecar :8093 serving vessels JSON;
:8090 and :8000 listening. Finding: **verify.sh's `--live` vessel probe is
dead** — it GETs `/api/ais/global` (`scripts/verify.sh:84`), which does not
exist (AIS is WebSocket-push only, `routes/ais.py:204`); the probe has
"skipped" on every run since it was written and will forever.

**Branches: nothing is stranded.** All 40 PRs are merged; zero open
(`gh pr list`). Every local branch is content-merged (squash-superseded;
`git log --cherry-pick` right-only shows only patch-equivalent or
squash-duplicated commits):

| branch | merged as | status |
|---|---|---|
| evidence-locker-hardening-pr (HEAD) | PR #40 | merged 2026-07-12 |
| evidence-locker-hardening | PR #39 | merged |
| infra-country-facility-wave | PRs #37, #38 | merged |
| local-ai-engine-model-manager | PR #36 | merged |
| w5-places-airspace-enrichment | PR #35 | merged |
| w4-ontology-autopopulation | PR #34 | merged |
| roadmap-first-users | PR #33 | merged |
| keyless-city-splats | PR #32 | merged |
| workflows-city-foundry-overhaul | PRs #27, #31 | merged |
| workflows-external-control | PRs #29, #30 | merged |
| add-photo-geolocation-pipeline | PR #26 | merged |
| mcp-context-variants-plugin | PR #25 | merged |
| fix-flaky-dossier-age-assert / fix-readme-phase-status | PRs #28, #23 | merged |
| sense-making-cycle / foundry-data-layer | PRs #20–#22 | merged |
| gotham-* / feat/deepseek-* / backup/* | PRs #1–#2 era | historical snapshots |

Local `master` is stale at `540a13a` (PR #32 tip, 8 PRs behind). No stashes.
**The only uncommitted artifact in the entire repo is
`docs/launch-posts-draft.md`** (386 lines, untracked).

**Memory-index reconciliation** — every "UNCOMMITTED / NOT committed" flag
checked against git: globe-toolbar-detach-panels, ai-overview-enrichment-
fusion, evidence-locker-case-export → **ACTUALLY-MERGED** (PRs #39/#40,
today); local-llm-engine → merged #36; dashboard-workflows-overhaul → merged
#27/#29/#30/#31; mcp-plugin → #25; osint-source-expansion, foundry-layer,
ontology-local-spine, gaussian-splat, roadmap-first-users → all merged
(docs tracked: `roadmap-users-2026-07.md`, `osint-sources-plan.md`,
`gaussian-splat-free-sources.md` all in `git ls-files`). **Nothing LOST.**
MEMORY.md updated this session.

**Invariants easiest to regress with a careless cleanup** (from
`docs/decisions.md`):
1. Live-path teleport vs **sanctioned replay interpolation**
   (`decisions.md:567-580`) — twin traps: "fixing" replay to teleport breaks
   trail rendering; citing replay to justify live-path glide is banned.
2. `PollGeoJsonAdapter` upsert-by-id, never `removeAll()+add()` (eslint +
   `invariants.test.ts`).
3. `objects.props` wholesale-replace with provenance in append-only
   assertions — the evidence locker's custody chain now rides this exact
   contract (`intel/evidence.py:221-237`); a "helpful" merge-on-upsert would
   silently break chain-of-custody.
4. Hot-blob discipline: internal callers use `global_snapshot()`, semaphore
   stays 8, `_parse_ac` rejects non-JSON (`tests/test_invariants.py`).
5. `allow_unauthenticated` defaults **False** (`config.py:163`) — fail-closed
   everywhere except the dev compose stack (see Phase 2).

## Phase 1 — Built vs trusted

| subsystem | status | evidence |
|---|---|---|
| Globe feeds (ADS-B/AIS/sats) | **proven-live** | this-turn probe: 20k aircraft, 80% refresh/8 s; :8093 vessels JSON |
| Evidence locker (backend) | proven by tests | 20 tests `test_evidence.py`; SSRF guard `evidence.py:335-352` incl. `::ffff:` metadata bypass; tamper-409 re-hash `:154-163` |
| Evidence locker (frontend) | **plumbed-unverified** | mounted at `reports/ReportsApp.tsx:19`; never browser-driven |
| Case export (HTML/JSON/PPTX) | **plumbed-unverified** | 8 tests `test_case_export.py`; export button never clicked in a real browser |
| Replay/archive | **plumbed-unverified** (new parts) | `ARCHIVE_MODE` lifts clamp (`history.py:89`), coverage endpoint (`routes/history.py:69`) + "recording since · GB · fixes" chip (`Timeline.tsx:319-320`) exist; archive default OFF, compose sets 48 h retention; base replay validated 2026-06-20 warsim, the new scrubber dressing is not |
| Keyless alerts + sinks | proven-live (2026-07-11) | real POST logged, `decisions.md:629-632`; guards in `test_watch.py`/`test_alert_rules.py`. Email channel = **not-built** (validated at route, nothing sends) |
| Ontology spine + auto-mint | proven by tests | `ontology_local.py:142`; mint callers in 9 files (watch, evidence, situations, osint, extract, countries, maps, workflows, actions). 24 h "graph fills itself" live probe never run |
| Foundry | plumbed-unverified (FE) | backend tested; Workshop FE never browser-verified |
| Workflows + control blocks | proven-live (2026-07-10) | 21 block types; 49 tests; drone/device dry-run in preview (`blocks.py:90`, `EditorView.tsx:228`); control path proven live per memory |
| Watch-officer | built | briefs are an in-memory dict `watch_officer.py:45` — **documented design, not rot** (docstring `:8-12`: the loop re-derives briefs next cycle; `incident_store` diff state is also process-memory, so post-restart incidents re-file as "new"). Corrected from this audit's first draft. |
| Local-LLM brief fusion | plumbed-unverified | route + 13 tests (`ai_selection.py`); requires an active local engine to prove |
| 3DGS satToSplat | proven-live once | 268 324 Gaussians, `decisions.md:561-562`; GPU-lab-gated |
| Docker self-host | **plumbed-unverified** | compose exists; a stranger's clean-clone boot has never been demonstrated |

**Moat thesis** (`docs/roadmap-users-2026-07.md`, one sentence): *the fusion
globe is commoditized (World Monitor et al.); the moat is self-hosted +
keyless + unlimited locally-owned history/replay + a provenance-first
investigation layer.*

**Trace test** — 198 commits on origin/master in the last 30 days. The
pre-roadmap month split between moat depth (foundry, ontology, workflows,
local-LLM, replay substrate) and commoditized surface the roadmap itself
later banned (§5.5): country catalog #24, places/airspace #35, infra layers
#37, city splats #32. Since the roadmap landed (2026-07-11 06:27), the trace
is clean: #36 (self-hosted LLM = identity), #38 (launch polish), #39/#40
(evidence locker + case export = demand-rank #6 + the provenance substrate,
plus the W2 README rebuild). **But the roadmap's own top item — W1 archive
flagship + W2 "be seen" — is at 0% executed**: archive mode is default-off
even in compose, the launch posts exist only as an untracked draft, and the
launch gate (stars/engagement in 30 days) hasn't started counting. Effort is
converging on the moat; the step that converts it into users hasn't been
taken.

## Phase 2 — Rot, risk, debt

1. **Most likely to break in front of a real user this week: the stranger's
   `docker compose up`.** It is the entire launch funnel and it is
   plumbed-unverified. Known failure shape: datacenter/VPS egress is blocked
   by exactly the feeds that make the globe look alive (airplanes.live /
   adsb.fi Cloudflare-block datacenter IPs; adsb.lol 451s non-browser UAs —
   `decisions.md:730-732`), so a VPS user boots to a near-empty globe and
   posts "it's fake" — the community-calls-out-fakery failure the roadmap's
   own research flags (§2 red flags).
2. **Permissive-default gap:** `docker-compose.yml:34-36` justifies
   `ALLOW_UNAUTHENTICATED: 1` as "safe here because this stack is
   loopback-only" — but `ports: "8080:80"` (`:87-88`) publishes nginx on
   **all interfaces**. A LAN peer (or a port-forwarded box) reaches open-mode
   compute routes including Workflows external-actuation blocks
   (`control.drone`/`control.device` dispatch on a real run; SSRF-guarded and
   dispatch-capped, but open). One-line fix: `127.0.0.1:8080:80`.
3. **Silent no-ops** (siblings of the deleted-Supabase-backend precedent):
   the dead `--live` vessel probe (`verify.sh:84`, nonexistent endpoint,
   reports "skipped" forever); the `email` alert channel (accepted at rule
   creation, nothing ever sends — `decisions.md:639-641`); stale test
   comment `CoverageStrip.test.tsx:4` claiming the coverage endpoint is
   unbuilt (it's live). (Watch-officer brief volatility was listed here in
   the first draft — reclassified as documented design; see Phase 1.)
4. **Loss/collision risk: minimal.** Sole uncommitted file is the launch
   draft (386 lines — cheap to lose, trivial to save). 16 stale local
   branches + a local master 8 PRs behind are confusion risk (branching from
   stale master), not data loss.
5. **Hardening wave: finished vs open.** Shipped: SSRF guard with
   IPv6-mapped-metadata handling (`evidence.py:335-352`), tamper-409 blob
   verify (`:154-163`), custody-event uuid nonce (`:221-237`),
   `test_security_hardening.py`. Open: no retry/backoff on failed alert
   sinks (named-deferred), email channel, **MCP rate-limiting (W5's explicit
   precondition before any public listing — not started)**, and the archive
   disk-math ("GB/day, measured not guessed") never measured.

## Phase 3 — Converge

**Primary: launch-readiness sprint, then launch (roadmap W2, ~3–5 days).**
Concretely: (a) stranger-boot test — clean clone on a fresh machine/VM,
`docker compose up`, fix what breaks, bind nginx to loopback, add/verify the
empty-globe diagnostic path for egress-blocked hosts; (b) browser-verify the
two headline flows once each — replay scrubber with coverage chip, and
evidence capture → case export download; (c) measure the GB/day archive
math and decide the compose default (48 h vs archive profile) so the pitch
matches the boot; (d) commit `docs/launch-posts-draft.md` and post
r/selfhosted + Show HN.
*Leverage:* maximal — the moat thesis is only tested by contact with users,
and the roadmap's own decision gate cannot start until the posts exist.
*Risk retired:* the fake/broken first-contact failure (#1 above) and the
LAN-open default (#2). *Cost of delay:* World Monitor ships weekly against
the same audience; every depth-week widens a moat nobody can see. *Skip:*
PPTX polish, multi-domain scrub perf edge cases (aircraft-first per the W1
kill criterion), any new layer or feed.

**Secondary 1 (half a day): repo + guard hygiene.** Delete the 16
content-merged local branches, fast-forward local master, fix the dead
vessel probe (point it at a real signal — :8093 `vessels.json` count or a
new HTTP count route), fix the stale CoverageStrip test comment.

**Secondary 2 (one day): close the launch-surface silent no-ops.** Reject
`email` at rule creation until it sends. (Watch-officer persistence was
listed here in the first draft; dropped after verifying the volatility is
documented, self-healing design.)

**Rejected candidates and why:** dark-fleet productization (W6 is
demand-gated by the roadmap itself; FleetLeaks sets an explainability bar we
shouldn't rush); Ontology Home / analyst workspace (roadmap §5.1 — zero
users, hollow graph); MCP marketplace listing (W5's own ordering: rate-limit
first, and it's parity not moat); more feeds/layers (§5.5 — the last month
already overspent here); flipping archive-on-by-default blind (do the disk
measurement inside the primary instead).

## Phase 4 — First action

First command (not executed — this audit turn is read-only outside
`docs/audits/` and memory): on a `launch-w2` branch,
`git add docs/launch-posts-draft.md` + commit, then on a clean VM
`git clone … && docker compose up` and watch :8080. **Proof of success:**
the globe renders aircraft within ~60 s of a keyless boot on a machine with
no repo `.env`, and `git status` no longer lists the draft. **Invariant most
at risk while doing it:** the fail-closed `allow_unauthenticated` default —
any "fix" to the compose stack must keep `docker-compose.prod.yml` failing
closed (`config.py:163` stays False; only the dev stack opts in), and the
jemalloc/`LD_PRELOAD` sidecar scrub must survive any Dockerfile edit
(`tests/test_invariants.py` guards it).

## Addendum (same day) — rot fixes applied

Branch `rot-fixes-launch-plan` (off the fast-forwarded master):
- `--live` vessel probe now reads keyless `/api/status` `vessel_count`
  (55,080 live at fix time) instead of the nonexistent `/api/ais/global`.
- Compose nginx binds `127.0.0.1:8080:80`; the "loopback-only" safety
  comment is now true.
- `email` alert channel rejected at rule creation with an explicit message
  (+ guard test in `test_alert_rules.py`; baseline 1539 → 1540).
- `CoverageStrip.test.tsx` stale comment corrected.
- Watch-officer left untouched (documented design, above). Stale local
  branches pruned; local master fast-forwarded.
- Advertising plan for the 5k-star target: `docs/star-campaign-2026-07.md`.

## Read-only probes executed this turn

- `bash scripts/verify.sh` → ALL GREEN (1539+1s / 320 web / lint / typecheck).
- ADS-B freshness probe → 20 000 features, 80% refresh over 8 s.
- `/api/ais/global` → SPA HTML (route absent) — dead-probe finding.
- :8090/:8093 listeners confirmed; :8093 returns vessels JSON.
- Branch/PR reconciliation: `git branch --no-merged`, `--cherry-pick`
  right-only scans, `gh pr list` (40 merged, 0 open).
