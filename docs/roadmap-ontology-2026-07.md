# Velocity roadmap — the ontology becomes the product (2026-07-07)

Succession document. Written by the retiring lead for whoever picks this up.
It records what this platform is, what our peers and Palantir actually are,
what the evidence (live screenshots + source reads, 2026-07-07) says about
where we stand, and a phased plan whose ordering optimizes for **biggest
impact, not fastest win**. Read `CLAUDE.md` and
`.claude/skills/osint-platform-dev/` before acting on any of it.

---

## 1. Identity — what makes us *us*

Velocity is a **personal, keyless, live-world intelligence console**. Its
unfakeable assets, measured live on 2026-07-07:

- **The live world, without accounts.** 69,065 live objects in the Explorer
  (56,247 vessels + 12,813 aircraft, sub-10 s freshness), ~16.5k entities in
  the world scene, 6/6 feeds live — all keyless. No peer at any price ships a
  no-signup, self-hosted globe with this breadth (screenshots:
  `docs/media/hero-world.png`, `docs/media/ui-explorer.png`).
- **One console, many domains.** Air + maritime + space + hazards + digital
  OSINT + imagery + news in a single scene. Peers are vertical silos
  (Flightradar24 = air, MarineTraffic/Windward = sea, BlackSky = imagery);
  fusion across silos is precisely what they can't do cheaply.
- **A real analytics engine already exists** (`apps/api/app/intel/` — 30+
  modules: detectors, fusion, incidents, dossier, POL, deception, tip-and-cue,
  watch-officer, graph analytics, entity resolution), guarded by 715 backend
  tests and executable invariants (`scripts/verify.sh`).
- **Operational discipline unusual for a personal project:** guard tests for
  operator decisions, decision history in `docs/decisions.md`, evidence-first
  culture.

What we are NOT: a commercial SaaS, a data-integration business, or a
Palantir competitor. We have no customers whose data we integrate — and that
is a *feature*: our data is the open world, already flowing.

## 2. What Palantir actually is — and the lesson

The research (2026-07-07, agents' reports summarized here) corrected an early
framing error: Gotham's map is a **minor surface**. Palantir's actual product:

1. **The ontology as operating picture.** Customer data → persistent objects,
   typed links, properties, **actions**. Every application (map, graph,
   table, timeline, dossier, video) is a *lens over the same schema*.
   Semantics (types) + kinetics (actions) + interfaces + applications.
2. **Closed decision loops.** Analysts act *through* the platform (task,
   approve, write back), every action governed and audited. Perceive → decide
   → act → record. Dashboards are what you build when you can't close the loop.
3. **Trust as UI.** Classification, need-to-know, lineage and audit are
   *visible*, not back-office. That's why governments pay.
4. **AIP (2024-26):** LLM agents that operate on the ontology with transparent
   derivation chains — AI inside the governed loop, not a chatbot beside it.

**The lesson for us is architectural, not cosmetic.** We cannot and should
not out-Palantir Palantir on enterprise data integration. We apply their
architecture to the domain we own: the live open world. Our sensing already
outruns our sense-making (the standing thesis in
`.claude/skills/osint-platform-dev/references/roadmap.md`); the operator has
now made it explicit: **the ontology is the main dashboard; the OSINT feeds
are the side gig that feeds it.**

## 3. What the peers teach (condensed from the peer survey)

Professional-grade, across Lattice / Windward / Kpler / BlackSky / Dataminr /
Maltego / FR24:

- **Map-centric but not map-only**; playback/replay is table stakes.
- **Identity fused with position** — *who operates this hull/airframe* is as
  valuable as *where it is* (Windward's ownership screening is the moat).
- **Push, not pull**: AI-triaged alerts surface to the analyst; the analyst
  doesn't hunt (Dataminr's whole business is a 45-min lead time).
- **Evidence-grade output**: exports with provenance that survive scrutiny
  (Maltego's legal defensibility).
- **Dark, dense, restrained UI** with one accent spent deliberately.
- **Free/keyless entry** builds trust and community (ADS-B Exchange,
  airplanes.live — our tribe).

## 4. Where we stand — evidence from 2026-07-07

**Strong (proven-live, screenshots in `docs/media/`):**

- `hero-world.png` — full-disc globe, dense global traffic, layers rail,
  agent strip, replay bar. Best single selling image we have.
- `hero-selected-track.png` — click-to-dossier: German Police EC145
  (D-HHEA) near Frankfurt, magenta track, populated inspector (identity,
  kinematics, freshness, ACARS check, actions, analytic assessment). This is
  a Gotham-class object view *for the two feed-native kinds*.
- `hero-europe-density.png`, `hero-us-east.png`, `hero-middle-east.png` —
  regional density; `ui-explorer.png` — 69k-row live object store with facets
  and CSV export; `ui-command-bar.png` — omnibar with workspace jumps.
- `ui-briefs.png` — the watch-officer's fused incident brief is real product:
  25 cross-domain incidents ("ais-gap + dark-vessel + spoofing — signature of
  coordinated denial & deception"), signal counts + distances, a change diff
  (+14/−14 · 25 active), per-incident → Situation / slew-to actions. The
  sense-making engine works; it just isn't the home surface.

**Weak (proven-live, same session):**

- `ui-graph.png` — the GRAPH surface boots to an empty "No investigation
  open" page, and the alerts panel showed "No alerts in buffer". **The
  sense-making surfaces are hollow by default** while the map brims. A
  populated graph shot proved *uncapturable*: both Search-around and Seed
  render "COULD NOT LOAD GRAPH" because `/api/ontology/search-around/*`
  requires a signed-in Supabase user (`routes/ontology.py:79`) and
  `traverse()` reads only that user's RLS-scoped persisted links
  (`intel/ontology.py:306`) — of which a fresh account has zero. The flagship
  investigation surface cannot demo on a keyless boot; this is the product
  gap photographed.
- GDELT incident labels collide illegibly at continental zoom
  (`hero-europe-density.png`, UK/Benelux).
- The replay bar exists but is visually an empty strip — time is plumbed,
  not sold.

**Architectural gaps (source, read 2026-07-07):**

- The ontology store is **remote-only**: `OntologyRegistry` is a per-user
  PostgREST client over Supabase; without Supabase configured every call
  503s (`apps/api/app/intel/ontology.py:190-199`). On a keyless/local boot —
  our core identity — the ontology is *dead weight*, which is exactly why the
  GRAPH page is empty.
- **Upsert replaces props wholesale** — "Callers that want to *extend*
  `props` should `get` first and merge in Python"
  (`ontology.py:216-223`). No per-property history, no observed-at intervals,
  no confidence, no provenance. A Palantir-class object is a *time series of
  evidenced assertions*; ours is a mutable JSON blob.
- **The live world never mints objects.** Feeds render entities on the map
  and rows in Explorer, but an aircraft only becomes an ontology object when
  an analyst or a playbook explicitly writes it. The map and the ontology are
  two worlds bridged by hand. (Object/Link/Action models and the
  search-around/path primitives are solid — `ontology.py:93-169` — the graph
  just has almost nothing in it.)
- Kinds and relations are healthy and already ours: 15 kinds incl. person/
  username/org (`ontology.py:45-50`), 10 canonical verbs incl. `operates`,
  `evidence_of`, `promoted_to` (`ontology.py:64-77`), classification +
  compartments ACL on every row (`ontology.py:107-112`) — the *schema spine
  exists*; it is starving for data and for a home surface.

## 5. The plan — ontology-first, in phases

Ordering principle: each phase makes every later phase cheaper, and the
biggest-impact structural work (persistence + auto-population) comes before
any surface polish. No phase breaks a guarded invariant; the map keeps
working untouched throughout.

### Phase 0 — Preserve the work (hours, do before anything)

Measured 2026-07-07 (`git status`): the branch `sense-making-cycle` holds
4 commits not on master AND — far worse — the **invariant-enforcement layer
is untracked**: `apps/api/tests/test_invariants.py`,
`apps/web/src/globe/invariants.test.ts`, `scripts/verify.sh`,
`scripts/kill-port.sh`, `docs/decisions.md`,
`docs/harness-bitter-lesson-audit.md`, the modified `CLAUDE.md`, the
screenshot scripts, `docs/media/`, and this document. A lost working tree
loses the guards that keep every operator decision enforced.

1. Commit the untracked guard tests + docs + scripts + media + this roadmap
   (several commits, human voice), push the branch, PR to master.
2. Then the loose ends inherited from the previous roadmap: dark `route.py`
   nav (backend-complete, no UI), dead `/api/interpreter` reference in
   `sim/TrafficController.ts`.

### Phase 1 — The ontology gets a local spine — ✅ DONE 2026-07-07

Shipped (as-built spec: `docs/ontology-local-spine-plan.md`; rationale:
`docs/decisions.md#ontology-local-first-store-2026-07-07`). Evidence: 718
backend tests + the `test_ontology_local.py` guard green, `scripts/verify.sh`
ALL GREEN, every `/api/ontology/*` + situations + maps route serving data on a
keyless boot (live curl probes), GRAPH page seeding, saving and persisting an
investigation across a backend restart
(`docs/media/ui-graph-local-spine.png`). Two deviations from the plan below:
(1) the operator invoked the §5c kill criterion immediately — the
Supabase/PostgREST ontology backend was DELETED, not demoted; SQLite is the
only store (`intel/ontology_local.py`, `data/ontology.db`). (2) fixing the
keyless 401 exposed that investigation-save had always 422'd (the `ObjectKind`
Literal lacked "investigation") — fixed; the flagship save flow works for the
first time.

The store must work on a keyless local boot, hold time, and hold provenance.

- **Local-first backend for `OntologyRegistry`:** SQLite (same idiom as
  `app/history.py`) as the default store; Supabase/PostgREST demoted to an
  optional sync/remote backend behind the same interface. Acceptance: every
  `/api/ontology/*` route returns data with no Supabase configured.
- **Assertions, not blobs.** New table `assertions(object_id, prop, value,
  source, confidence, observed_at, valid_until, derivation)` feeding a
  materialized `props` view for compatibility. Every property answers *who
  said this, when, how sure*. This single schema decision unlocks: history
  tabs, derivation chains, deception scoring, diffing, and honest LLM
  grounding — all downstream phases read it.
- **Links get the same treatment** (source + confidence + time bounds in
  `props` today; promote to columns).
- Keep the existing `Object`/`Link` pydantic surface stable so the 130-line
  route layer and frontend don't churn.
- Guard: `tests/test_ontology_local.py` — boot with no Supabase, upsert,
  assert two assertions from two sources coexist with distinct provenance.

**Concrete spec (starting point for `docs/ontology-local-spine-plan.md`):**

```sql
-- apps/api data dir, SQLite, WAL, same idiom as app/history.py
CREATE TABLE objects (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  classification INTEGER DEFAULT 0, compartments TEXT DEFAULT '[]',
  created_at TEXT, updated_at TEXT);
CREATE TABLE assertions (
  id INTEGER PRIMARY KEY, object_id TEXT NOT NULL REFERENCES objects(id),
  prop TEXT NOT NULL, value TEXT NOT NULL,          -- JSON-encoded
  source TEXT NOT NULL,                             -- feed:adsb | detector:ais_gap | analyst | agent:watch_officer | osint:whois
  confidence REAL DEFAULT 1.0,
  observed_at TEXT NOT NULL, valid_until TEXT,
  derivation TEXT);                                 -- nullable JSON: inputs behind a derived value
CREATE INDEX ix_assert_obj ON assertions(object_id, prop, observed_at DESC);
CREATE TABLE links (
  id INTEGER PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL,
  rel TEXT NOT NULL, source TEXT NOT NULL, confidence REAL DEFAULT 1.0,
  observed_at TEXT NOT NULL, valid_until TEXT, props TEXT DEFAULT '{}',
  UNIQUE(src, dst, rel));
```

- **Interface split, not a rewrite:** extract the `OntologyRegistry` method
  surface (`upsert/get/link/traverse/path_between/query`) into a protocol;
  `SqliteRegistry` (new, default) and the existing PostgREST registry
  (`ontology.py:202`) both implement it. Selection: Supabase configured AND
  user signed in → remote (prod droplet unchanged); otherwise local. The
  `Object.props` view = latest assertion per prop, so routes and frontend
  keep their current shapes.
- **Migration:** one-shot `scripts/ontology_export.py` pulls the operator's
  Supabase rows → local store (props become single assertions with
  `source='migrated'`).
- **Budgets (pin after measuring, these are the starting caps):** assertions
  written only on value *change* (dedup identical latest value); per-object
  cap ~2,000 assertions with oldest-first compaction to daily summaries;
  whole store soft cap ~2 GB — same bounding philosophy as history.db
  ([[storage-bounding-and-ondemand-imagery]]).
- **Effort:** ~1-2 focused days for the spine + guards; migration script half
  a day.

### Phase 2 — The world flows into the graph (auto-population)

Kill the hollow-graph problem at the source: the ontology fills itself.

- **A promotion pipeline, not a firehose.** Do NOT mint 69k objects/cycle.
  Mint on *significance*: any entity that (a) trips a detector, (b) is
  selected/flagged/watched by the analyst, (c) appears in an incident,
  brief, or correlation, or (d) matches a standing watch — becomes/updates an
  object with `evidence_of` links to the incident and assertions carrying the
  feed as source. Integration points already exist: the `correlate/bus`
  alerts, `incident_store.record()`, watch-officer playbooks, the selection
  path in `entity-panel`.
- **Identity enrichment as assertions:** route the existing dossier/POL/
  OSINT-investigate outputs (`intel/dossier.py`, `app/osint/`) into
  assertions instead of ad-hoc payloads; `operates` links for airline/fleet
  from callsign+registration prefixes (keyless reference data).
- **Backfill from history:** a one-shot job walks history.db + incident
  store and mints the graph the platform *should* have had. Day one the
  GRAPH page opens onto months of real structure.
- **Minting budget (prevents both starvation and junk):** target order
  1,000-5,000 objects after the first week, not 69k mirrored rows. Every mint
  must carry a *reason* link or assertion (`evidence_of` an incident,
  `watched_by` a rule, analyst selection…). Pruning: objects with zero
  analyst interaction, zero incident links, and no assertion younger than
  30 d are compacted to a tombstone summary. Log mint/prune counts per cycle.
- Guard: live probe — after 24 h of normal operation the object count is
  within the budget band, every object has ≥1 sourced assertion AND ≥1
  reason link; a second probe asserts the count did not grow unbounded
  week-over-week.

- **Effort:** promotion pipeline ~2-3 days (the hook points all exist);
  backfill job ~1 day.

### Phase 3 — The Ontology Home (the new main dashboard)

The default surface stops being the map. It becomes the object workspace;
the map is one lens among four.

Layout (single screen, 2560-wide reference):

```
┌────────────────────────────────────────────────────────────────────────┐
│ top bar: omnibar · AOI · clock · feeds · classification · audit chip   │
├──────────┬──────────────────────────────────────────────┬──────────────┤
│ TYPES    │  WORKBOARD                                   │ INSPECTOR    │
│ tree w/  │  triage strip: incidents · briefs ready ·    │ object view: │
│ live     │  proposals awaiting approval (decision queue)│ overview /   │
│ counts   │  ────────────────────────────────────────    │ assertions   │
│ (schema- │  object table ⇄ graph canvas ⇄ map ⇄ timeline│ (w/ source & │
│ driven)  │  — one selection, four lenses, brushing      │ confidence) /│
│ + saved  │  histogram facets on any property            │ links /      │
│ views    │                                              │ history /    │
│          │                                              │ actions      │
└──────────┴──────────────────────────────────────────────┴──────────────┘
```

- **Schema registry endpoint** (`/api/ontology/schema`): kinds, per-kind
  property specs, link verbs, per-kind actions. Every panel renders from it —
  add a kind in one place and the tree, facets, inspector and graph legend
  pick it up. (This is the deepest Palantir lesson: one schema, many lenses.)
- **Generalize the entity inspector.** `entity-panel` is already excellent
  for aircraft/vessels (see `hero-selected-track.png`); refactor its card
  stack to render any ontology kind from the schema + assertions, with the
  feed-native kinds keeping their bespoke cards (kinematics, ACARS).
- **Linked views / brushing:** one selection store (exists —
  `state`/`useSelection`) drives table row highlight, graph node halo, map
  entity spotlight, timeline lane — magenta (`--mag`) is already reserved for
  exactly this lineage role in `theme/tokens.css`.
- **No empty states.** Every surface boots seeded: GRAPH opens on the most
  recent incident neighborhood; INBOX shows the triage strip; TIMELINE shows
  the last 24 h of incidents. An empty panel is a bug (we photographed why).
- Guard: `invariants.test.ts` additions — schema-driven rendering (a fake
  kind renders without code), seeded-not-empty boot for GRAPH/INBOX.

- **Effort:** the largest FE lift — 1-2 weeks incremental. Ship it as a tab
  first (promote EXPLORER); flip the default route only after real use earns
  it (see risks).

### Phase 4 — Kinetics: close the decision loop

- Every inspector and workboard row exposes its kind's **actions** (the
  vocabulary already lives in `ontology.py:140-152`, handlers + `action_log`
  in `intel/actions.py`, HITL proposal queue in `routes/actions.py`): flag,
  watch, nominate, task imagery, open investigation, approve/dismiss brief.
- **Audit becomes UI.** The dark `/api/audit` route gets a viewer: an
  activity feed on the Home (who/what/when — even single-operator, this is
  the trust surface and the replay of your own tradecraft).
- Watch-officer briefs become objects (`incident` kind) with `evidence_of`
  links — approving a brief *is* an ontology write, so the Home triage strip,
  the graph, and the audit feed are automatically consistent.
- Guard: action → `action_log` row → visible in activity feed, one test.

- **Effort:** ~2-3 days (vocabulary, handlers, proposal queue and audit log
  all exist; this is wiring + one viewer panel).

### Phase 5 — The analyst agent over the ontology (our AIP-analyst)

Only after 1-4: the agent is only as good as the graph it stands on.

- Command-bar NL → query-planner (local LLM via `app/llm.py` `tier="reason"`)
  → **typed** ontology/history/live-snapshot queries → results land as: map
  selection set + graph highlight + cited object list. Never free-text-only.
- **Derivation chains rendered, Palantir-style:** every answer shows the
  assertion trail (source, confidence, time) it stands on — the Phase-1
  schema makes this nearly free.
- Extend watch-officer playbooks to propose ontology writes (new links,
  promotions) through the same HITL queue — the agent becomes a *governed
  contributor to the graph*, not an oracle.

- **Effort:** ~1 week for a grounded first cut (planner prompt + typed query
  executors + the results-as-selection plumbing), then iterative.

### Continuous — design & imagery (parallel track, never blocks phases)

- **Design scheme: keep Cobalt/Ink, extend it for the ontology.** The token
  system (`apps/web/src/theme/tokens.css`) is already deliberately
  Gotham-informed: near-neutral dark substrate (`#0c0e11`→`#2f353e`), steel
  blue accent `#4fa0d8` (interactive only), magenta `#e25bef` (selection/
  lineage only), threat colors reserved for threat. Blueprint-flat shadows,
  2-5 px radii, space-not-lines separation. Do NOT reskin. Add:
  - **A kind-hue ramp**: one desaturated hue family per ontology kind used
    consistently across graph nodes, table chips, tree, timeline lanes, and
    map icons (extend the palette dispatch in `globe/adapters/styles.ts` —
    guarded file, additive only).
  - **A provenance visual language**: observed vs derived assertions
    distinguished typographically (e.g. dotted underline + derivation
    popover), confidence as a quiet 3-step opacity/weight scale — never a
    rainbow.
  - **Density discipline**: 24-28 px rows, tabular numerals, the existing
    contrast ramp; boldness spent on data, chrome stays quiet.
  - Fix the two photographed sores: incident label collision (cluster +
    declutter at low zoom) and the under-dressed replay bar.
- **Imagery pipeline stays alive:** `scripts/screenshot-globe.mjs` (now
  2560×1440, onboarding-suppressed) + `scripts/screenshot-selected.mjs`
  regenerate the `docs/media/` set in minutes. After each phase, retake and
  add the new surface. Rule learned today: **verify every screenshot with
  eyes before calling it good** — the first round was 100% unusable (welcome
  modal) while the capture agent rated it "excellent".

## 5b. Where the previous roadmap's items land (nothing silently dropped)

| Old item (roadmap-2026-07 / skill references/roadmap.md) | New home |
|---|---|
| Commit dirty work (old Tier 0) | Phase 0, expanded — guards are untracked |
| Watch-officer extensions (old 1A) | Phase 4 (briefs as objects) + Phase 5 (playbooks propose writes) |
| Person/identity OSINT (old 1B) | Phase 2 enrichment — outputs land as assertions + `operates`/`member_of` links; the person/username/email kinds already exist (`ontology.py:45-50`) |
| NL query over the world (old 1C) | Phase 5, strictly after the graph is populated |
| Imagery CV, SAR chokepoints, news depth (old Tier 2) | Unchanged as capability work, but their outputs must mint evidence into the ontology (each detection = object + `evidence_of`) |
| FMV/3DGS/PPTX big bets (old Tier 3) | Unchanged — after everything above |

## 5c. Risks and kill criteria

- **Dual-backend drift** (SQLite + PostgREST): RESOLVED 2026-07-07 — the
  operator invoked the kill criterion on day one; the PostgREST ontology path
  is deleted (recorded in `docs/decisions.md`). `get_registry()` remains the
  seam if a remote backend is ever re-earned.
- **Graph junk** (Phase 2 over-minting): the budget + reason-link rule above;
  if pruning fights the minter, tighten significance, don't raise caps.
- **Home-surface rejection**: the operator may keep living on the map. Ship
  Phase 3 as a *tab first* (EXPLORER promoted), only flip the default route
  after a week of real use says it earns it. Reversible one-liner.
- **Assertion-table growth**: measured cap + compaction from day one; if the
  write rate exceeds ~10 assertions/s sustained, the significance filter is
  wrong, not the cap.
- **LLM-agent trust** (Phase 5): answers must render their assertion trail;
  an answer that can't cite is displayed as speculation. This is a UI
  contract, encode it in the panel, not in a prompt.
- **Sunset note (Bitter Lesson):** the minting significance heuristics and
  the NL query-planner scaffolding are compensators for current-model
  weakness — revisit both when the local reasoner improves (dated 2026-07-07);
  the assertion schema and the audit trail are environment facts, keep.

## 6. Explicitly NOT on this roadmap

- Out-Palantiring Palantir: multi-tenant enterprise data integration,
  onboarding, tiering, sales surfaces. Wrong identity.
- A new map renderer, motion synthesis, cadence changes — guarded, settled.
- More keyless AIS hunting (measured exhausted), more sensors for their own
  sake. New feeds only when a phase pulls them in as evidence sources.
- Full visual reskin. The token system is right; extend, don't replace.

## 7. How to work this roadmap (for my successor)

- One phase = one cycle: explore → spec in `docs/<feature>-plan.md` with real
  file:line integration points → minimum vertical slice → `bash
  scripts/verify.sh` green → screenshots → memory entry. The watch-officer
  build (`references/worked-example.md`) is the template.
- Never commit below 715 passed backend tests; `pnpm -r typecheck` green at
  every boundary; guarded files (`styles.ts`, `PollGeoJsonAdapter`,
  `tracks.ts`, viewer opts) are additive-only.
- Evidence over assertion, always. The words global/complete/full/parity
  require a live count that turn.
- When in doubt about priority, re-apply the lens: **does it turn what we
  already see into finished, evidenced, actionable intel with less operator
  labor?** That is the whole strategy in one sentence.

## Appendix — media inventory (2026-07-07, 2560×1440)

| file | shows | verdict |
|---|---|---|
| `docs/media/hero-world.png` | full-disc globe, global traffic, chrome | strong — lead image |
| `docs/media/hero-europe-density.png` | continental icon density + layers | strong (label collision visible) |
| `docs/media/hero-us-east.png` | US East Coast density | strong |
| `docs/media/hero-middle-east.png` | Gulf/Hormuz + AOI box | good, sparser |
| `docs/media/hero-selected-track.png` | click-to-dossier, EC145 + magenta track | strong — best workflow image |
| `docs/media/ui-explorer.png` | 69,065-object live store, facets, export | strong — scale proof |
| `docs/media/ui-command-bar.png` | omnibar workspace jumps | usable |
| `docs/media/ui-briefs.png` | fused incident brief, 25 incidents + change diff | strong — sense-making proof |
| `docs/media/ui-graph.png` | empty investigation canvas | kept as the honest "before" |
| `docs/media/ui-graph-local-spine.png` | GRAPH with a saved investigation, keyless local store | the Phase-1 "after" (2026-07-07) |
| `docs/media/ui-entity-panel.png` | aircraft inspector, magenta track (D-EUMI) | strong |
| `docs/media/hero-channel-vessels.png` | Dover strait, hundreds of labeled vessels + AOI box | strong — best maritime image |
| `docs/media/hero-baltic-vessels.png` | Øresund/Danish straits vessel lanes | good |
| `docs/media/hero-singapore-strait.png` | Singapore anchorage cluster | good |
| `docs/media/hero-satellites.png` | orbital catalogue shell (SPACE 4/4), full disc | good |

Capture method (persist): suppress onboarding via localStorage
`velocity.onboarded.v1=1` in `addInitScript`; toggle layers programmatically
via the DEV global `window.__registry` (LayerRegistry, `App.tsx:150`) with ids
from `apps/web/src/normal/layerCatalog.ts` — far more reliable than clicking
the rail; verify every frame by eye (first rounds shipped a welcome modal,
aircraft mislabeled as vessels, and a basemap mislabeled as the satellite
layer — all caught only by looking).
