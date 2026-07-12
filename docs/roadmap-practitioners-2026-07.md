# Velocity roadmap — what practitioners actually need (2026-07-12)

Successor to `docs/roadmap-users-2026-07.md` (2026-07-11). That document's
launch sequencing (W0–W3) **shipped and stands** — replay/archive mode, the
Docker one-liner, keyless webhook alerts, and ontology auto-mint slice 1 are
all on master (PR #33–#35), plus six waves it didn't anticipate (Workflows,
City 3D, local-LLM engine, facility/Country layers, the UI overhaul; PRs #27,
#30–32, #36–38). This document answers the operator's next question: **step
back — what do people practicing OSINT really need from this project?**

Method: two parallel research passes this session — (a) a repo ground-truth
audit of the practitioner-facing surface at HEAD `175df54`, with file:line
citations; (b) web research across five practitioner segments (investigative
journalists, corporate CTI, law-enforcement/Trace Labs, hobbyist trackers,
human-rights documentation), with sources cited and inference flagged. Both
reports' load-bearing claims are reproduced below with their evidence tags.

---

## 1. The headline finding — we built the *seeing*, they need the *proving*

Velocity today is an excellent instrument for **watching the world**: live
multi-domain globe, unlimited local replay, facility layers, alerts. The
demand research is unambiguous that watching is not where practitioners
bleed. Across all five segments, the worst-served stages are:

- **Analysis/enrichment** — "analysts spend about 45% of their time on data
  prep"; organizing datasets is the #1 time sink for over half of
  practitioners (shadowdragon.io survey; corroborated by
  osintimes.substack.com "Why are so many intelligence outputs still static
  PDFs?" and zinc.systems on the manual intel→case handoff).
- **Evidence preservation** — platforms delete evidence faster than anyone
  captures it: YouTube removed 6.1M videos in Q1 2020, 49.9% before a single
  view; 11% of HRW-cited content since 2007 is gone; 21% of Syrian Archive's
  YouTube corpus inaccessible (hrw.org "Video Unavailable"). Archive.today is
  rate-capped, CAPTCHA-walled, and itself under legal attack; Wayback
  archiving of major news sites reportedly dropped sharply after May 2025.
- **Case→report** — "Raw screenshots are… easy to challenge"
  (forensicosint.com); Trace Labs volunteers spend 2–5 hrs/case on report
  writing even with AI drafting.

And the repo audit found the exact mirror image inside Velocity: the
investigation loop **works until the moment you have to prove something**:

- A user can flag/promote an entity with sourced assertions
  (`routes/ontology.py:109-152`) and build a real case file (Situations,
  `routes/situations.py`, with typed evidence links) — but **no export
  operates on the case**. `/api/export` and `/api/report/pptx`
  (`routes/export.py:144,194`) only serialize the *live snapshot*; there is
  no path from a Situation's linked evidence graph to a shareable document.
- There is **no evidence-capture primitive** — no page/screenshot/media
  attachment with hash, timestamp, and provenance. Annotations are text
  notes, not evidence.
- The photo-geolocation pipeline (PR #26, `apps/ml/geolocate/`, 107 tests)
  has **zero API route and zero UI surface** — CLI-only, undiscoverable.
- Person/username OSINT is two functions (`osint/sources/social.py`:
  pullpush Reddit + libravatar), and the whole digital-OSINT panel is buried
  12th in the rail's "more" overflow (`App.tsx:192`).
- The zero-config Docker boot — our own onboarding pitch — **503s every
  LLM-backed feature**, including two of the six Reports tabs
  (`ratelimit.py:32-47`); `ALLOW_UNAUTHENTICATED` is documented nowhere a
  new user would look.

**Thesis:** the ranked universal unmet needs across segments are (1)
chain-of-custody evidence preservation, (3) a unified
collection→graph→case→report record, and (6) report generation from case
data — and a self-hosted local-first platform is *structurally advantaged*
at all three (local storage IS the custody boundary; open-source is what
courts increasingly demand over black-box tools; the Hunchly acquisition by
Maltego 5/2025 proves willingness-to-pay for exactly this). Needs (2)
tool-graveyard survivability, (4) unlimited history, (7) webhook alerting,
and (9) keyless feeds we have already shipped. So the roadmap is one
sentence:

> **Close the loop from "I see something" to "here is a document a skeptic,
> an editor, or a court can check" — with every step hashed, sourced, and
> labeled.**

The value line evolves from "the open live world, recorded and replayable,
that you actually own" to: **"…and every investigation you run on it comes
out the other end as evidence you can hand to someone."**

## 2. What each segment needs, in one line each (evidence-ranked)

| Segment | Binding pain | What Velocity should do about it |
|---|---|---|
| Journalists / conflict researchers | Tool graveyard + evidence deleted before capture + reproducible method | Evidence locker (P1), case export with method/provenance (P2), photo geolocation surfaced (P3) |
| Corporate CTI | 45-tool sprawl, manual intel→case handoff, fingerprint-then-alert | Unified record (already the ontology) + case export (P2) + CT/typosquat watch triggers (P5) |
| LE / Trace Labs | Evidence logging is manual DIY; username tooling breaks constantly; 2–5 hrs/case reporting | Evidence locker (P1), report generation (P2), WhatsMyName *consumption* not reimplementation (P4) |
| Hobbyist trackers / self-hosters | History paywalls, single-domain stacks, webhook alerts | Already served (replay, fusion, alerts) — they are the launch audience, keep them |
| Human-rights / NGO | Berkeley Protocol compliance: hash at collection, custody log, court-grade auditability | Evidence locker designed against the Protocol checklist (P1); open-source auditability is free |

Design constraints carried forward (all sourced, all unchanged from the
predecessor doc): unlabeled AI output is a liability to this audience —
accepted uses are translation/transcription/summarization/triage *labeled
and human-signed*; rejected are unlabeled inference, generative output in
evidentiary contexts, AI attribution stated as fact, and facial recognition
(14+ wrongful arrests). Local models are not just private — for LE they are
a sourced *requirement* (never paste subject data into logged cloud AI).
The local-LLM engine (PR #36) is therefore a strategic asset, not a toy:
it is the only enrichment engine this audience can legally/ethically use on
subject data.

## 3. The plan — five waves

Ordering principle: hygiene debts first (hours), then the one feature that
is universal + advantaged + proven-paid (evidence locker), then the export
that makes every existing feature legible (case→report), then wiring what's
already built, then the lanes that broaden reach. Launch (predecessor W2
packaging → r/selfhosted + Show HN) remains the gating *external* event and
can fire between any two waves; P1+P2 give the launch story a second act —
"not just watch: prove."

### P0 — Debts that undermine trust (≈1 day)
- **decisions.md backfill** for PRs #27, #30–32, #36–38 and the UI/bug-fix
  wave — the guard-doc contract is stale for six merges *again* (last entry
  2026-07-11, `decisions.md:582`). One dated paragraph each.
- **Fix the 503 wall on the pitched path**: document local mode in README +
  `.env.example` + compose comments; decide and document the compose default
  (`ALLOW_UNAUTHENTICATED=1` on the single-box compose with a visible
  warning banner in the UI, or a first-run settings prompt). A first-hour
  user hitting dead Reports tabs on the advertised quickstart is a
  launch-review wound waiting to happen.
- **Un-bury Investigate**: promote the digital-OSINT panel out of the "more"
  overflow to a top-level app slot. It is the natural entry point for the
  largest non-geo use case and currently needs archaeology to find.

### P1 — The evidence locker (chain-of-custody capture) (≈2 weeks)
The single largest sourced unserved need, universal across four of five
segments, structurally local-first, willingness-to-pay proven (Hunchly).
Berkeley Protocol as the spec checklist (OHCHR: "the collection tool should
automatically add — a hash value").

- **Capture primitive** `evidence` object in the local ontology store:
  content-addressed blob (SHA-256 at ingest), UTC timestamp, capture method,
  source URL/context, captured-by, stored under a dedicated evidence dir in
  the existing data volume. Append-only custody events ride the existing
  `assertions` table — the substrate was built for exactly this; extend,
  don't rebuild.
- **Capture paths**, in priority order: (1) URL → self-contained page
  capture (single-file HTML + screenshot + response headers; WARC/WACZ
  format as stretch, not gate); (2) file/image/video upload with hash +
  EXIF preserved-and-noted; (3) globe/app screenshot attach; (4) live-feed
  freeze ("preserve this entity's current state + track as evidence" —
  unique to us: nobody else can notarize a moment of the live world from
  your own archive).
- **Attach-to-case**: evidence links to Situations via the existing
  `POST /{id}/link`; EntityPanel and Inbox get "preserve as evidence"
  actions.
- **Custody manifest**: per-case hash-of-hashes export (JSON + human-readable),
  Berkeley-checklist fields explicit.
- Guard: capture → hash recorded → mutation attempt fails → manifest
  verifies round-trip. Live probe: capture a real URL keyless.
- Kill criterion: if headless page capture proves flaky across sites, ship
  file/screenshot/feed-freeze paths first and mark URL capture experimental
  — a capture tool that silently loses pages is worse than none.

### P2 — Case → report: the other end of the loop (≈1 week)
- **`/api/situations/{id}/export`** walking the situation's linked children,
  their sourced assertions, attached evidence + hashes, and the relevant
  replay window into: (a) HTML/PDF dossier with per-claim provenance
  footnotes ("asserted by agent:watch_officer 2026-07-12T…; evidence
  sha256:…"), (b) the existing PPTX brief generator retargeted from
  live-snapshot to case scope, (c) machine-readable JSON bundle (case +
  manifest) for interchange.
- **Labeled drafting**: optional narrative draft via the local-LLM engine,
  rendered in a visibly-AI-labeled block the user must edit/accept before it
  enters the document; every prompt/response logged. This is the accepted AI
  use (drafting under human sign-off) and kills the 2–5 hr report tax
  without touching the red line.
- Guard: exported dossier contains zero claims lacking a provenance
  footnote; AI-drafted text carries the label through to output.

### P3 — Wire what's already built (≈1 week)
Cheapest capability-per-effort in the repo:
- **Photo geolocation gets a surface**: API route + UI (drop a photo into a
  case → forensics report + candidate poses as evidence objects). 107 tests
  exist; the feature is done, it's just unreachable.
- **Local-LLM as the enrichment engine**: entity extraction, translation,
  summarization over captured evidence and feeds — labeled, logged, local.
  This is the sourced #5 need (45% data-prep time) served the only way this
  audience accepts.
- **One-click "open a case from this"**: Inbox alert / detector event /
  watch firing → pre-linked Situation. The audit found the graph stays
  hollow because case-starting requires prior knowledge of two UI gestures.

### P4 — The person/company lane: consume, don't compete (≈1 week, capped)
Username/social correlation is a real need but **structurally disadvantaged
self-hosted** — keeping 700+ site detections alive is a centralized
community problem (WhatsMyName maintains a literal "Problem-Removed Sites"
page; Sherlock's false-positive issue is structurally unsolved). So:
- Consume the WhatsMyName community JSON for username checks (attribution +
  refresh-on-boot), HIBP k-anonymity range API for email exposure — never
  host breach data (legal exposure, identity violation).
- Surface the already-deep corp stack (EDGAR, OpenSanctions, OpenCorporates,
  OpenOwnership, Aleph — `osint/sources/corp.py:38-285`) as first-class
  Investigate cards feeding the ontology.
- Results land as sourced assertions with per-source confidence labels
  (multi-signal verification is the practitioner norm; a bare
  username-match presented as identity is exactly the PRISM-style fakery
  this audience torches).
- Cap: this wave consumes datasets and wires cards; it does not build or
  maintain site-detection logic.

### P5 — Fingerprint-then-alert (demand-gated, ≈1 week when pulled)
Extend the shipped keyless alert engine (`alert_rules_local.py` + webhook
sinks) from geofence/watch-list triggers to the CTI watch patterns the
research found practitioners hand-rolling: cert-transparency watch,
typosquat/new-registration watch, graph events ("new evidence linked to
case X", "entity on watch-list gained an assertion"). Pull forward if
post-launch feedback skews CTI; otherwise it queues behind P1–P3.

## 4. Dispositions (nothing silently dropped)

| Predecessor item | Disposition |
|---|---|
| W2 launch (r/selfhosted, Show HN, README/GIF) | **Still the gating external event** — unblocked, can fire after P0 or after P1 for the stronger story. The <200-star reassessment gate stands. |
| W4 slice 2 (mint budget/prune, detector-bus hook, backfill) | Rides into P3 (the graph must not grow unboundedly once cases start landing evidence). The inverted `evidence_of` in `actions.py:191` gets fixed when P1 touches evidence links anyway. |
| W5 MCP rate-limit + listing | Unchanged, still capped parity work; queue after P2. The MCP angle improves with P1/P2: "the agent can *preserve and cite*, not just look." |
| W6 dark-fleet productization | Still demand-gated. Note P1 makes it better: a dark-fleet event that auto-preserves its evidence window clears the FleetLeaks explainability bar by construction. |
| Ontology Home / analyst agent (Phases 3/5) | Still deferred until real users; unchanged reasoning. |
| Country catalog 53/249 gap | Not a wave — add an in-UI coverage indicator (P0-adjacent polish) and grow the catalog opportunistically; do not block anything on it. |
| Targeting app ("notional") | Leave as-is; it self-labels honestly. Revisit only if a user segment asks. |

## 5. What NOT to do (all evidence-backed, several new)

1. **No facial recognition, ever surfaced as a feature** — 14+ wrongful
   arrests documented; instant credibility destruction with this audience.
2. **Never host or bundle breach data** — consume HIBP k-anonymity; hosting
   is legally fraught and identity-violating.
3. **Don't build/maintain username site-detection logic** — consume
   WhatsMyName; the maintenance treadmill is a community-scale problem.
4. **Don't ship unlabeled AI text into any evidentiary surface** — labeled
   draft + human sign-off + prompt logging is the only accepted shape
   (unchanged, now with more receipts: 35–45% hallucinated-IOC error rates).
5. **Don't lead with "multi-domain fusion" or "AI-powered"** — unchanged.
6. **No public live demo** — unchanged (feed ToS, OPSEC).
7. **Don't let the evidence locker become a general web archiver** — we
   capture what an investigation touches, not the web; ArchiveBox/Webrecorder
   exist and interop (WACZ) beats competition.

## 6. Success measures (next review)

- Loop closed, proven live: URL → evidence object with verifying hash →
  linked into a Situation → exported dossier where every claim carries a
  provenance footnote and the manifest verifies. One unbroken screen
  recording of that path is the launch asset.
- Photo → case: drop a stripped-EXIF photo into a case, get a geolocation
  forensics report attached as evidence, from the UI.
- First-hour path: fresh `docker compose up`, no dead tabs, Investigate
  reachable in ≤2 clicks, evidence capture works keyless.
- decisions.md current with master at every merge (the twice-recurred debt
  gets a PR-checklist line, not a third backfill).
- Test baseline (1507 at HEAD `175df54`) never regresses; guarded
  invariants untouched; `scripts/verify.sh` green at every boundary.

## 7. How to work this roadmap

Unchanged mechanics (one workstream = one cycle, explore → spec with
file:line integration points → vertical slice → verify → screenshots →
memory). The lens sharpens one more time. The predecessor asked: *does it
turn what we already see into something a stranger can run, trust, and
keep?* This one asks: **does it help a practitioner prove something to a
skeptic — with the hash, the source, and the label to back it?** Every wave
above either answers yes or exists to unblock one that does.
