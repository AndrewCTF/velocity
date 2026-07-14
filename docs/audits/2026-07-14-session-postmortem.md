# Session post-mortem — 2026-06-15 → 2026-07-14

Synthesized 2026-07-14 from the recorded session memories
(`~/.claude/projects/-home-andrew-Projects-OSINT/memory/`), the post-mortems
section of `docs/decisions.md`, and `docs/audits/2026-07-12-state-of-project.md`.
Provenance: every defect below was recorded at the time it happened; the only
live measurements THIS turn are the git counts in the next paragraph.

Scope: ~30 working sessions. 132 commits since 2026-06-15, 18 of them
fix-themed, **zero reverts** (measured live: `git log --oneline
--since=2026-06-15`). Test baseline ratcheted 1294 → 1675 over the same window
(`docs/decisions.md#backend-test-baseline-history`).

## Failure classes, ranked by recurrence

### 1. Silent degradation — the platform's dominant failure mode

The same shape at least nine times: a component keeps producing
success-shaped output after it has stopped doing its job.

- `verify.sh --live` vessel probe GET a route that never existed; a bare
  `except` printed "skipped" on every run since birth (rot-fix wave,
  2026-07-12).
- `email` alert channel accepted at rule creation; nothing ever sent
  (2026-07-11 → fixed 2026-07-12 by rejecting at creation).
- Drone-swarm sim silently clamped 1000 → 200 with a slider max of 2000
  ("impossible & SILENT", warsim stress test 2026-06-20).
- ADS-B sidecar dropped `nac_p`/`nic` → `/api/jamming` served ZERO cells for
  days (2026-07-05).
- Investigation-save had NEVER worked — auth-first 401 masked the 422 schema
  mismatch until the auth gate was removed (2026-07-07).
- `opensky_authed: true` with expired creds — every call 401'd
  ("configured ≠ working").
- The firehose tier's never-expiring cache reported `seen_pos_s` fresh
  forever → 9.2% of airborne moves rendered BACKWARDS until the
  freshest-observation merge (2026-07-14).
- `aircraftDeadReckon` toggle froze contacts instead of extrapolating — the
  code path held position while claiming motion (2026-07-04).
- Playwright template-string "reader" silently returned the function object →
  sidecar served 0 aircraft.

**Root-cause pattern:** bare excepts, caps without warnings, auth gates
masking downstream errors, caches without honest age stamps, and probes that
can only skip. **The fix that stuck:** make every check ABLE to fail
("a probe that can only skip is not a probe"), reject-at-creation instead of
accept-and-drop, level-triggered state instead of edge-triggered events.

### 2. The confident fix that made it worse

- `mallopt(M_ARENA_MAX=2)` + `malloc_trim` for the 17 GB memory problem →
  54 GB and 201% CPU under sustained load. The real fix was jemalloc preload
  (2026-07-04).
- Easing the aircraft icon toward the next fix to "smooth the jump" → apparent
  speed became `dist/gap` (arbitrary; p05 = −68% of true speed) and icons
  glided backwards for up to 30 s (2026-07-14).
- Fitting velocity from consecutive fixes → only 13.5% of pairs land within
  ±10% of the reported `velocity_ms` (killed two designs).
- Repeated frontend work on "stale/slow" reports whose cause was a frozen
  backend blob (canonized as operating rule 5).

**Pattern:** the fix was chosen by plausibility, not by a before/after
measurement at the right layer. Every one of these was caught only when
someone finally measured. The counter-habit is now doctrine: probe the layer
boundary first, measure before and after, and distrust a fix you can't
number.

### 3. Inverted assumptions in code you didn't read

- `_merge_raw_into`'s docstring: "caller orders sources so the freshest is
  merged last" — inverted in production by a tier that never expires
  (2026-07-14, the backwards-aircraft bug).
- `.env` resolution by CWD bit at least three separate times: tests run from
  `apps/api` hit a wall of 401s; dev boots keyless by accident from repo
  root; a shadowed config froze refresh at 1 minute.
- `detect._SIDECAR` used `parents[3]` + re-appended "apps" → every detection
  call said "sidecar offline" regardless of config (2026-07-05).
- The proposal queue's approve → `dispatch()` EXECUTES an action — wrong
  semantics for an informational brief; caught only by reading `actions.py`
  before reusing it (watch-officer build).

**Pattern:** building against an imagined signature or a stale docstring.
The skill's "verify the leads yourself — open the 3-4 files you'll depend
on" exists because of this class.

### 4. Hostile upstreams are the norm

Every new feed cost a discovery session: adsb.lol 451s non-browser UAs;
airplanes.live throttles with HTTP 200 + text/plain; Cloudflare blocks
datacenter egress (airplanes.live/adsb.fi/adsb.one, LiveATC search); NGA
needs full browser headers; FAA NASR 503s HEAD but serves GET; WDQS 504s on
two specific query shapes and 429s bursts; World Bank silently STALLS on 16
concurrent fetches; CelesTrak 403-rate-limits bursts; GitHub REST 429s from
shared egress; Overpass 504s planet queries. The fix is always some mix of
headers, cadence, caching, and serialization — and it only stays fixed
because it's recorded next to the client code and often guarded
(`_parse_ac` rejects non-JSON; `load_cell` raises on all-host failure).

### 5. Claims without measurement (the founding sin)

"Global" AIS that was Norway-only; "the full picture" that was ~60% of
FlightAware; "keyless caps at ~12.7k" as a ceiling that try-harder broke.
These predate the evidence contract and directly caused it: banned words
without a live count, proven-live / plumbed-unverified / not-built tagging,
and enforcement moved from prose into guards.

### 6. Test-and-tooling traps (cost hours, not correctness)

jsdom synthetic pointer events don't drive React (`isTrusted` gate); headless
Playwright can't measure GPU fps; Wayland has no working screenshot backend
here; the Tauri watcher rebuild-looped on the app's own SQLite writes until
`.taurignore`; inherited `LD_PRELOAD` jemalloc killed the sidecar Chrome
zygote → 0 aircraft; zustand filter-in-selector infinite-loops
`useSyncExternalStore`. All recorded; none recurred after recording.

## What worked — keep doing it

1. **Guards over prose.** Zero reverts in 132 commits while the baseline
   ratcheted 1294 → 1675. Regressions die in `verify.sh`, not in production.
   The 2026-07-05 Bitter-Lesson cleanup (delete compensators, keep
   environment facts, enforce invariants in executable checks) is validated
   by this number.
2. **Adversarial review waves find what the builder can't.** Foundry
   hardening: 18 defects. UI bug scan: 24. Evidence-locker external review:
   7, including a HIGH SSRF. These were separate review passes, not the
   building session's self-check.
3. **Dogfood/stress sessions are the densest bug source.** The two June
   war-game sessions and the US-Iran dogfood each produced ~15-20 real
   defects (silent clamps, missing geo-scoping, WS outages, unclamped
   dossier physics) precisely because the product was USED as an analyst,
   not built. Nothing else found these.
4. **Honest tiering carries real information.** The 2026-07-12 audit's #1
   launch risk (a stranger's `docker compose up`) was exactly the largest
   surface still tagged plumbed-unverified. The tags predicted where the
   risk was.

## Residual risks / recommendations

1. **Browser-verification debt compounds.** Most waves ship backend
   proven-live + frontend "NOT browser-verified", and the defects that
   survive to dogfooding live almost entirely in that gap (boot auth race,
   AlertsPanel crash, stuck counters, dead WS). Pay it per-wave — one
   scripted trusted-event Playwright flow or a 5-minute manual drive —
   instead of letting the next stress test find it.
2. **Schedule dogfooding.** It is the highest-yield QA activity on record
   here and it happens only ad hoc. After any user-facing wave, one
   scenario-driven session (the US-Iran template) pays for itself.
3. **The stranger-boot path is still the top untested surface** (per the
   2026-07-12 audit; unchanged since). It gates the launch plan and fails in
   a known shape (egress-blocked feeds → empty globe → "it's fake").
4. **Guard-count updates are a known wave tax** (`test_mcp_http_mount`
   22→34, layer-catalog counts): when a wave adds surface, grep for
   count-asserting guards before running the suite blind.
5. **Wave work sits dirty for days** (this branch included). The 2026-07-12
   audit proved everything eventually merged, but "eventually" is the risk
   window — branch, commit, PR at wave end.

## One-line summary

The platform's bugs are overwhelmingly *silence* — components that keep
smiling after they stop working — and its wins are overwhelmingly *loudness*:
guards that fail, probes that can fail, words that are banned without a
count. Keep converting the first into the second.
