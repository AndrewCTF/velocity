# Velocity roadmap — first users (2026-07-11)

Successor to `docs/roadmap-ontology-2026-07.md` (2026-07-07). That document's
architecture analysis stands; this one re-sequences it, because the operator's
question changed from "what should the product become" to **"what's next, what
do people want, what value does this bring to people, best path forward."**
The moment the goal includes *people*, the constraint that dominates everything
else is: **Velocity has approximately zero external users.** Every choice below
is ordered by what converts the existing depth into users, without betraying
the identity (keyless, self-hosted, no synthesis, evidence-first).

Method note: this roadmap synthesizes four research reports (repo ground-truth
audit; OSINT user-demand web research; competitive landscape; adoption/
distribution playbooks) that were then adversarially reviewed by a stronger
model, with spot-checks against primary sources. Where a claim survived only
as "directionally right," it is labeled as such. Research inputs are preserved
in the session scratchpad; load-bearing repo claims were re-verified at
file:line this session.

---

## 1. The headline finding — the globe is commoditized; the moat is not

The fused "live conflict globe" concept — aircraft + ships + satellites +
hazards + news on one dark 3D map — is **no longer whitespace**. Verified this
session:

- **World Monitor** (worldmonitor.app, AGPL repo, cloud-hosted) ships
  multi-domain keyless fusion + a 39-tool MCP server + an alert-rules engine
  delivering to Discord/Slack/Telegram/webhook + an AI analyst, Pro at
  $39.99/mo. This is the exact feature set two of our research reports
  recommended building toward. It exists today.
- A cluster of open-source lookalikes (Godseye, Shadowbroker, osiris-live
  "A Palantir Alternative", assorted Show-HN dashboards) plus 8+ thin
  commercial "AI conflict dashboard" sites all sit on the same
  GDELT/ACLED/OpenSky/AISStream spine. A launch pitched as "multi-domain
  fusion globe" reads as one-more-conflict-dashboard.

What none of them have — and what the demand research independently ranked as
the strongest unmet needs — is Velocity's actual position:

1. **Self-hosted and local-first.** Your archive, watch-lists, and queries on
   your hardware; no vendor can paywall, filter, or rug-pull it. The ADS-B
   community has already rioted over exactly this once (ADS-B Exchange/JetNet
   sale: mass feeder disconnects in protest — widely reported; exact
   percentage unverified).
2. **Unlimited local history + replay.** History depth is the single most
   universally paywalled feature in the space: FR24 gates it at 7 days free,
   RadarBox at 365 days paid, MarineTraffic *cut* its free window 72h→24h in
   2025, ADS-B Exchange killed its free API tier in Mar 2025. World Monitor
   has **no replay at all** (verified). Nobody offers unlimited history free —
   structurally, a cloud vendor can't. A self-hosted tool can.
3. **A real investigation layer** (local SQLite ontology, assertions with
   provenance, detectors, dossiers, Foundry, Workflows) — depth the clone
   cluster cannot follow quickly.

**Value statement** (the words a skeptical HN commenter would accept): a
self-hosted, keyless situation console that fuses live aircraft, ships,
satellites and hazards on one 3D globe and — unlike Flightradar24,
MarineTraffic, or World Monitor — keeps unlimited local history you can
rewind and replay, with no account, no API key, and no vendor able to
paywall, filter, or rug-pull your archive. It runs entirely on your hardware,
so your watch-lists and queries never leave your machine. The open live
world, recorded and replayable, that you actually own.

## 2. What people want (evidence-ranked)

From the demand research (r/OSINT ~242k, r/selfhosted ~798k, ADS-B Exchange
20k+ feeders, Bellingcat toolkit ecosystem, OCCRP/FleetLeaks workflows,
Maltego CE/SpiderFoot pain threads):

| Rank | Want | Evidence strength | Velocity today |
|---|---|---|---|
| 1 | Unlimited history/playback | Strongest — universally paywalled by every commercial player | `history.py` positions store + retention/byte caps + `HistoryPlayback.ts`/`Timeline.tsx` exist; "plumbed, not sold" |
| 2 | Alerts pushed to Discord/phone/webhook | Strong — competitors gate this behind paid tiers | Geofence evaluator exists but is dead on keyless boot (`watch.py:504`); Workflows has `op.http`/webhook blocks |
| 3 | One console instead of tool sprawl / API-key rot | Strong — "OSINT tool graveyard" is a running community theme | Core identity, already shipped |
| 4 | AI-agent/MCP access | Real and growing (~10k MCP servers by Apr 2026) — but now parity, not differentiation | `plugin/osint-geoint` already built |
| 5 | Dark-fleet/AIS-gap detection | Real (OCCRP does it by hand; FleetLeaks serves it free) | Detectors exist in `intel/`; not productized |
| 6 | Evidence export w/ chain-of-custody | Real, niche (journalists/legal) | Assertions table is the right substrate; no export |

Red flags the same research surfaced (treat as design constraints):
- **Unlabeled AI "insights" are a liability, not a feature** to this exact
  audience — practitioner backlash is active and documented; AI-confidence
  correlates with *less* verification (CMU/MSR). Everything automated must be
  visibly labeled automated; everything verified must show its provenance.
  Velocity's assertion schema was built for precisely this — lean into it.
- The self-hosted community **calls out fakery fast** (the PRISM dashboard
  backlash: unvalidated username hits, undisclosed AI authorship). Accuracy
  and honest labeling are adoption features.
- GDELT-derived events carry a known credibility gap — label the source.

## 3. The 90-day plan

Ordering principle: ship the differentiator, then be seen, then wire the
demand items that are mostly plumbing, then feed the graph. The ontology
remains the long-term product thesis; it is **re-sequenced, not abandoned**
(§4). Nothing below touches a guarded invariant.

### W0 — Repo hygiene (half a day, immediately)
- `docs/decisions.md` has no dated entries for PRs #24–#32 (country catalog,
  MCP plugin, photo geolocation, Workflows/City apps, external-actuation,
  city foundry overhaul, keyless splats). Backfill one dated paragraph each —
  the guard-doc contract is stale for five merges.
- Local `master` is 6 behind origin; stale branches (`sense-making-cycle`,
  `dashboard-workflows-overhaul`, `foundry-data-layer`, `keyless-city-splats`)
  are content-superseded snapshots — delete or archive them.
- Re-verify the 939-test baseline live before the next feature commit.

### W1 — "The world, recorded": unlimited replay as the headline (≈2 weeks)
The substrate exists (`apps/api/app/history.py`: positions table, WAL,
operator-tunable `history_retention_hours` with clamp + RAM-sized byte cap;
frontend `globe/HistoryPlayback.ts`, `timeline/Timeline.tsx`). The work is to
turn a bounded internal buffer into the product's flagship:
- **Disk-first archive profile:** a config preset (`VELOCITY_ARCHIVE=1` or
  similar) that lifts the time clamp (ceiling 0 already disables it —
  `history.py:75`) and sizes the byte cap to a disk budget instead of RAM.
  Document the disk math (≈ GB/day at 13k aircraft + 50k vessels, measured,
  not guessed).
- **Sell the scrubber:** the replay bar is visually an empty strip (the old
  roadmap's own words: "time is plumbed, not sold"). Dress it: date picker,
  density heat-strip of archived coverage, playback speed, and a visible
  "recording since <date> · <N> GB · <M> fixes" chip — the ownership proof.
- **Multi-domain scrub:** aircraft + vessels first (both already flow through
  history), incidents overlaid from the incident store.
- Guard: replay of a chosen window renders ≥2-point tracks for entities that
  have fixes in that window; archive-mode boot never prunes inside the
  configured window.
- Kill criterion: if multi-domain scrub can't hold acceptable perf, ship
  aircraft-only replay and still lead with it.

### W2 — Launch packaging (≈1 week, overlaps W1)
Zero users is the actual problem; the product is deep but invisible.
- **Docker Compose one-liner** that boots API + web + sidecars keyless on one
  box, with the archive profile on by default. This is the #1 stickiness
  factor in every adoption case study (Uptime Kuma, Dawarich, ArchiveBox).
- **README rebuild:** 60-second pitch — hero GIF (globe → click → dossier →
  *rewind yesterday*), three sentences, `docker compose up`, honest
  keyless-feeds caveats. The `docs/media/` 1440p set is already strong.
- **Launch posts:** r/selfhosted + Show HN (same week as W1 completion), then
  awesome-selfhosted / awesome-OSINT PRs, Sector035 Week-in-OSINT pitch,
  Bellingcat toolkit submission, Trace Labs Discord. (Per-channel star
  forecasts from the research are vibes, not commitments — the sequence is
  sound, the numbers are not.)
- **Pitch discipline:** lead with *self-hosted + keyless + unlimited replay
  you own*. Do not lead with "multi-domain fusion" or "AI-powered" (§1, §2
  red flags).
- **No public live demo instance** at launch: redistribution ToS (adsb.lol,
  airplanes.live, AIS providers), OPSEC/DDoS exposure, Strava precedent.
  Video/GIF + self-host. Revisit a delayed/limited demo later, behind
  Cloudflare, only if channel feedback demands it.
- Decision gate (not quite a kill): if launch across both channels lands
  <~200 stars and near-zero qualitative engagement in 30 days, freeze feature
  work and reassess positioning before building more.

### W3 — Keyless alert push (≈3–5 days)
Demand rank #2 and mostly wiring:
- Fix the keyless-dead path: `_list_enabled_rules` returns `[]` when
  `supabase_url` is unset (`apps/api/app/intel/watch.py:504`) and firing
  requires a live `/ws/alerts` session — alerts must evaluate server-side on
  a keyless boot with no browser open.
- Add sinks: Discord webhook + generic webhook (the Workflows `op.http` /
  webhook blocks already exist; reuse, don't rebuild). Watch-list → "this
  aircraft/vessel appeared / went dark / entered AOI" → phone via Discord.
- Guard: rule fires with no WS session and no Supabase; sink delivery logged.
- Kill criterion: if reliable keyless firing needs deep rework, defer — a
  flaky notifier is worse than none.

### W4 — Ontology Phase 2: the graph fills itself (≈3–4 days + 1 day backfill)
The only ontology work justified pre-users, pulled forward because it kills
the photographed empty-graph demo failure (`ui-graph.png`, "No investigation
open"):
- Auto-promotion on significance exactly as specced in
  `roadmap-ontology-2026-07.md` Phase 2: detector trips, incident membership,
  analyst selection, standing-watch matches → `get_registry().upsert` with
  sourced assertions + `evidence_of` reason links. Hook points all exist
  (correlate/bus, `incident_store.record()`, watch-officer, EntityPanel
  selection). Today the sole mint path is the manual promote button
  (`routes/ontology.py:126-152` ← `EntityPanel.tsx:539`).
- Watch-officer briefs stop being an in-memory dict (`watch_officer.py:34`)
  and become `incident` objects with `evidence_of` links.
- Backfill job over history.db + incident store so the GRAPH page opens onto
  real structure day one.
- Minting budget + pruning per the original spec (1–5k objects, every mint
  carries a reason; if pruning fights the minter, tighten significance).
- Guard: live probe — after 24 h, object count in band, every object ≥1
  sourced assertion + ≥1 reason link.

### W5 — MCP hardening + marketplace listing (≈3–5 days, capped)
Parity work, not differentiation (World Monitor has 39 MCP tools) — so cap
the investment:
- **Rate-limit the MCP layer first**: agent traffic must not hammer the
  rate-limited upstreams (adsb.lol UA rules, airplanes.live 200+text
  throttle, CelesTrak burst 403s). Load-test before listing; if MCP exposure
  throttles upstreams, gate/queue before any public listing.
- Then list `plugin/osint-geoint` in MCP/plugin registries and
  awesome-claude-code style indexes. Angle: "the investigative agent's
  self-hosted world model — live + recorded, no API keys."

### W6 — Dark-fleet productization (DEFER; demand-gated)
Closest true differentiator after replay (bundled, cross-domain,
self-hosted), and the detectors exist — but FleetLeaks already serves
explainable AIS-gap/loitering/STS scoring free with SAR corroboration. Hold
until post-launch feedback asks for it; when built, it must clear
FleetLeaks' explainability bar (per-event "why flagged" with evidence) or it
stays an internal detector, not a marketing pillar. Natural shape when it
comes: detector events → ontology objects (W4) → replay windows (W1) →
webhook alerts (W3) — i.e., the first three workstreams *are* the dark-fleet
product's chassis.

## 4. Where the ontology roadmap lands (nothing silently dropped)

| roadmap-ontology-2026-07 item | Disposition |
|---|---|
| Phase 2 auto-population | **Pulled forward** → W4 (fixes hollow demo; cheap) |
| Phase 3 Ontology Home / default surface | **Deferred until real users exist.** Building the analyst workspace for an imagined persona consumes the exact window in which launch must happen; the graph it fronts is hollow until W4 beds in. Revisit at the 90-day mark with user feedback. |
| Phase 4 kinetics/audit UI | Deferred with Phase 3; the `actions.py` audit rewrite to the local store (named-deferred in `decisions.md:340`) rides along when Phase 4 wakes. |
| Phase 5 analyst agent | Deferred; the MCP surface (W5) is the interim answer — external agents over typed tools, which is also the honest one (labeled automation, user's own model). |
| Continuous design track (label collision, replay bar) | Replay bar → W1 core. Label declutter → fold into W1/W2 polish. |
| Assertion schema, provenance, budgets | Unchanged — it is the chain-of-custody substrate (§2 want #6) and the anti-"unlabeled AI" answer. |

## 5. What NOT to do (evidence-backed)

1. **Don't build Ontology Home / the autonomous analyst now** — zero users,
   hollow graph, and the 90-day launch window is the scarce resource.
2. **Don't lead any pitch with "multi-domain fusion globe" or "AI-powered"**
   — commoditized concept, active AI backlash in the target community.
3. **Don't stand up a public real-time demo** — feed-redistribution ToS,
   OPSEC/DDoS, misuse liability. GIF/video + self-host.
4. **Don't ship unlabeled AI output as intel** — label automated vs verified
   everywhere; render provenance (the assertion schema exists for this).
5. **Don't chase World Monitor feature-parity** (tool counts, more feeds,
   scenario engines) — compete on the axis they can't follow: local-first,
   private, replayable. Corollary: no new feeds for their own sake (already
   settled in the old roadmap §6).
6. **Don't monetize the data** — feeds are research-tolerated keyless
   sources; redistribution/resale breaks both ToS and identity. If
   sustainability matters later, the evidence says: sponsors + consulting/
   services ($2–5k/mo realistic by month 12), never data resale, and treat
   all per-channel revenue forecasts as vibes.

## 6. Success measures (90-day review)

- Replay: archive-mode instance holding ≥30 days of multi-domain history
  within its disk budget, scrub-to-any-hour proven live.
- Launch: the gate in W2 (stars + qualitative engagement — are self-hosters
  filing issues about *their* use cases?).
- Alerts: ≥1 real watch-list rule firing to a phone via Discord on a keyless
  boot, no browser attached.
- Graph: object count in budget band with 100% reason-link coverage after a
  week of unattended operation.
- The 939-test baseline never regresses; `scripts/verify.sh` green at every
  boundary; guarded invariants untouched.

## 7. How to work this roadmap

Unchanged from the predecessor doc §7: one workstream = one cycle (explore →
spec with file:line integration points → vertical slice → verify.sh green →
screenshots → memory), evidence over assertion, guarded files additive-only.
The lens shifts one word: **does it turn what we already see into something a
stranger can run, trust, and keep?** That is the whole strategy in one
sentence.
