# Roadmap — where this is going and how to choose next

The living version is `~/.claude/plans/if-you-need-to-mellow-pebble.md` and the memory
`[[roadmap-2026-07]]`. This is the durable summary of the reasoning, so a junior can pick
the next thing without re-deriving it.

## What this platform is for

A **personal analysis & research platform** — not a commercial SaaS, not a demo
showcase. That framing decides priorities: build capability and analyst leverage, not
tiering/onboarding/hardening. Perf/stability had a pass and is deprioritized until it
annoys the operator.

## The strategic thesis: sensing outruns sense-making

The platform *sees* a great deal — ~13k aircraft, ~21k vessels, satellites, imagery,
digital-OSINT, news. The bottleneck is that the operator still does most of the
correlation and investigation by hand. So the roadmap leans toward **automating the
analyst workflow** and closing the two named capability holes (person OSINT, imagery CV),
rather than adding yet another sensor.

When you're handed an open-ended "what should we build", this is the lens: does the idea
turn existing data into finished intel with less operator labor? That beats a new feed.

## Priority tiers

**Tier 0 — housekeeping (cheap, do first):**
- Commit uncommitted work before it's lost (much is dirty on `gotham-console-rebuild`).
- Loose ends from architecture.md: dark `route.py` nav (backend-complete, no UI), the
  `/api/interpreter` dead reference in TrafficController.

**Tier 1 — force multipliers (the "what we really need"):**
- **Watch-officer agent** (FIRST build, largely done — see worked-example.md): detectors
  auto-run playbooks → cited draft briefs in the Inbox for approve/dismiss. Biggest labor
  cut. Extend it: more playbooks (POL pull, OSINT investigate), optional LLM enrichment,
  a richer Inbox surface.
- **Person/identity OSINT:** keyless username enumeration, Gravatar, GitHub/GitLab public
  APIs, HIBP k-anonymity breach check → mint `person:`/`username:`/`email:` into the same
  ontology graph. Completes the digital-OSINT layer (`app/osint/`). Self-contained.
- **Natural-language query over the world:** command-bar → LLM query-planner → structured
  queries over ontology + history.db + live snapshot → answers as map selections + graph
  highlights + a cited list. Cheap now that local inference + grounding exist.

**Tier 2 — coverage + closing loops:**
- Imagery CV (YOLO/SAM2 on Sentinel-2/SAR chips → geo-referenced detections as map
  entities) — closes the tip-and-cue loop (detector → task imagery → auto-count ships).
- SAR dark-vessel chokepoint expansion (clone the Hormuz layer for Malacca,
  Bab-el-Mandeb, Suez, Black Sea — same CDSE creds + layer pattern).
- News/event ingest depth fused into `incidents.py` so briefs cite reporting, not just
  sensors.
- History depth: long-horizon POL + revisit detection over already-collected history.db.

**Tier 3 — big bets (only after Tier 1-2):** FMV/video AR fusion (real R&D), metrics-
over-time + PPTX export, GPL deep-recon sidecar, 3DGS recon productization (`rpc_stereo`
works — make it a routine on-demand product).

## Explicitly NOT on the roadmap

- Keyless global AIS beyond the sidecar — measured exhausted.
- ADS-B motion synthesis / cadence changes — guardrailed and working.
- Commercial hardening, tiering, deploy — wrong goal for a personal platform.
- Visual reskin V1-V3 — polish, not capability; revisit when it annoys.

## How to run a build from the roadmap

Each Tier-1 item is its own cycle: brainstorm → spec (`docs/<feature>-plan.md`) →
implement the minimum vertical slice → verify with evidence → save a memory. The
watch-officer in worked-example.md is the template. Reuse the substrate — most of what a
new feature needs (fusion, graph, alerts bus, proposal queue, local LLM) already exists.
