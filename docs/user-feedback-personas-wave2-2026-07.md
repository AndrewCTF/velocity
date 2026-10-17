# Persona feedback, waves 2 and 3 (2026-07-23/24)

Follow-up to the seven-persona study of 2026-07-22
(`user-feedback-personas-2026-07.md`). Two more waves ran overnight against the
live app, each persona paired with an adversarial verifier that had to
reproduce every finding from scratch before it counted. Wave 2 re-ran the
original seven personas against the fix wave their study forced; its 15
confirmed findings were then fixed the same night. Wave 3 ran ten personas (the
seven returning, plus three new: a SOC threat-intel analyst, a humanitarian-NGO
field-operations coordinator, and a Foundry/Workflows data engineer) against
the fixed build, and its quick blockers were fixed before this report was
written. Everything below that says "confirmed" means the verifier reproduced
it live, independently.

## Verdict trajectory

|             | 2026-07-22 study | Wave 2 | Wave 3 |
| ----------- | ---------------- | ------ | ------ |
| Adopt today | 4/7              | 5/7    | 6/10   |
| Star        | 7/7              | 7/7    | 10/10  |
| Recommend   | 6/7              | 6/7    | 10/10  |

Movement that matters: Riley (investigator) and Mika (sanctions journalist)
flipped to adopt in wave 2 when identity-scoped history and keyless
investigate proved out live. Priya (conflict researcher) — the study's hardest
no — flipped to adopt AND recommend in wave 3 after the GDELT mis-attribution
fixes landed; her wave-3 summary verified the word-boundary matcher and the
weight clamp by hand against the live API. The wave-3 no-adopts are Riley
(one new blocker, fixed since — see below), Alex (retention edge case after
restarts), Casey (provenance labeling, fixed since), and Sofia (a dead
upstream, handoff below).

## Wave 2: 15 findings, all fixed the same night

All 15 wave-2 findings were verifier-confirmed, then fixed in 13 commits with
the api suite rising 1916 → 1966 (now 1972) passed and `scripts/verify.sh`
green at every commit. Wave 3 re-checked every one of these claims live and
filed zero regressions against them.

| Commit    | Fixed                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `b608323` | api ruff backlog cleared (102 errors → 0); per-file E501 ignore for the URL-registry                                                                                                                                                                                |
| `ca54844` | WebSocket upgrade to unmatched `/ws/*` → clean JSON-404 denial (was a bare 500)                                                                                                                                                                                     |
| `217bf6a` | GDELT honesty: word-boundary matcher (demonym "Ethiopian" ≠ Ethiopia), instability armed_conflict actor-matched not raw-iso3, renormalized weight clamped ≤ 0.40 without redistribution, GDELT citations carry a reporting-intensity caveat in the Sources footnote |
| `ea562a4` | `/api/alerts/standing` + watch-session work keyless; Ops panel says "unavailable (HTTP n)" instead of a confident 0                                                                                                                                                 |
| `96cf864` | Identity-only alert rules: AOI optional with a real validator, no silent blank→0 coercion, "identity pin · global" badge, NOT NULL relaxed by migration                                                                                                             |
| `841dc2f` | `/api/eq` partial geo params → 422; `/api/history/track` accepts bare unambiguous ids, 422 on ambiguous                                                                                                                                                             |
| `c180620` | Dossier gap window derives from configured retention and reports the EFFECTIVE available depth; AisGapCard discloses a shortened window                                                                                                                             |
| `478b883` | Country brief no longer truncates mid-sentence before Sources (real cause: max_tokens 900; now 1600 + sentence-boundary trim)                                                                                                                                       |
| `3943d65` | Company screening counts (including zeros) persist to the org object; keyless deployments get a local audit trail (`data/audit_log.db`)                                                                                                                             |
| `9d4f281` | Five new MCP tools (46 total): quakes_near, track_history, create/list/delete_watch_rule                                                                                                                                                                            |
| `477bb8c` | Retention truth: `/api/history/coverage` exposes `oldest_ts` (index-served), replay scrubber shows real depth, README states the byte-cap-binds-first math (~3 GB/h measured; ~150 GB for a true 48h global archive), version unified to 1.0.1, 46 tools everywhere |

Live verification after the fixes (fresh boot, all four services up): ws-404,
keyless standing, partial-eq 422, bare-hex track, coverage `oldest_ts`,
dossier window fields, and the identity-only rule round trip all probed green;
GBR's instability score dropped 65.6 → 33.2 with the junk armed-conflict
component gone entirely, restoring coherence with the Security Events card on
the same page, and the 0.40 clamp verified live on AFG/ARG/AUS rows. The globe
UI protocol passed end to end (category icons over Europe, EntityPanel +
magenta track on select, clean deselect, 30 s with no blink-off, zero console
errors). Headless GPU fps remains unverified by policy.

## Wave 3: 22 findings — 7 fixed now, the rest ranked below

Fixed before this report:

| Commit    | Finding         | Fixed                                                                                                                                                                                                                 |
| --------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `29330a9` | casey (BLOCKER) | Investigate/recon persistence stamps the real connector (rdap+dns, otx, …) as assertion source; case-report footnotes stop claiming "asserted by analyst" for automated collection                                    |
| `972cc9a` | riley (BLOCKER) | Screening data now has a live UI surface: ObjectInspector's Properties tab falls back to `GET /api/ontology/object/{id}` for positionless ontology nodes (was "No properties resolved." for every investigate result) |
| `7adb764` | casey           | Workflows `source.quakes` returned 0 rows forever (called the eq ROUTE in-process → Query-sentinel TypeError → swallowed). Now calls the internal loader, per the standing invariant                                  |
| `17e0b46` | marcus          | Foundry upload with `?mode=append` in the query string was silently ignored → destructive snapshot replace. Now 422s with the fix named; response echoes the applied mode                                             |
| `c080bc3` | dana            | `/api/history/track` matches ICAO24 hex case-insensitively (uppercase ids silently returned empty)                                                                                                                    |
| `cfcf423` | priya           | Brief progress copy promised "~60s" against a 90s server budget and 69–93s observed latency                                                                                                                           |
| `11e6b53` | sam             | README states measured sidecar RAM (~11 GB ADS-B tree, ~3–6 GB AIS) instead of "several GB"                                                                                                                           |

### Handoff queue (confirmed, not fixed tonight — ranked)

1. **sofia-1 (BLOCKER): ReliefWeb layer is dead and fails silently.** Upstream
   v1 API returns 410 (decommissioned); v2 requires a registered appname (403
   with the current one). Needs the registration, and — separately — the layer
   rail needs a degraded-state surface: a dead humanitarian-disaster layer that
   renders as a clean empty map is dangerous. The top-bar FEEDS counter drops
   by one with no drill-down naming the broken feed.
2. **mika-2: window_note reports depth, not contiguity.** An 18.3-hour
   recording blackout (the box was off) is invisible — the note said "~27h of
   history" across a gap with zero rows. Track-level honesty needs a
   contiguity check (e.g. report the largest internal gap, or per-bucket
   coverage from `/api/history/coverage` buckets).
3. **alex-1: retention prune has no catch-up pass after restarts**, so the
   README's "well under 2 hours" worked example understates depth variance;
   ties into the named operator decision on `HISTORY_MAX_BYTES`.
4. **jordan-1: `/api/intel/vessels` and `/api/intel/aircraft` silently ignore
   unsupported filter params** — same class as the `/api/eq` fix; agents get
   the full feed thinking it's filtered.
5. **jordan-2: MCP error returns never set protocol-level `isError`** —
   structured error JSON comes back as a "successful" tool call.
6. **marcus-2: zero MCP coverage of Foundry/Workflows** — the automation
   surface the data-engineer persona wanted most.
7. **marcus-3 + casey: no DELETE route for ontology objects/links.** Also a
   test-hygiene problem: wave test artifacts could not be cleaned up and are
   now permanent (`ext:organization:w3-verifier-testcorp-x1`,
   `ext:organization:tesla`, `ext:organization:zzzqqxnonexistentcorp12345`,
   `foundry:ds_1356a354c06e:w3verify001`, `domain:github.com` investigation
   residue). A delete route would let the next wave clean up after itself.
8. **riley-2: `audit_log.db` has no query/export surface** and doesn't cover
   evidence capture / case export — the two actions a due-diligence audit
   trail most needs.
9. **mika-1: one incident-narrative branch still emits "possible interdiction
   or shadowing"** for stationary-vessel pairs (the Koblenz complaint from the
   original study, surviving in a second code path).
10. **priya-1: GDELT armed-conflict counts are non-monotonic across window
    sizes** (a 24h query can exceed a 72h query for the same country), quietly
    breaking Security/Instability comparability on one page.
11. **alex-2: residual GDELT junk survives the matcher** when the actor field
    legitimately contains a country name in an unrelated story (a US legal
    story tagged "assassination — Israel/Iran", geocoded to Washington DC).
    Known ceiling of text-heuristic attribution; the caveat labels cover it,
    a geo-coded-location cross-check would shrink it.
12. **marcus-4: `op.llm` workflow block is synchronous** (91 s observed for a
    trivial call) with no job-id pattern.
13. **dana-002: the aircraft entity panel never shows the gap-window honesty**
    that vessels got (AisGapCard is vessel-only).
14. **sofia-2: the brief's GDELT caveat lives in the Sources footnote**, not
    adjacent to the "Recent security events" narrative it qualifies (partially
    disputed — some runs carry a model-authored hedge in the body).
15. **sam-1 follow-up: full-coverage sidecars deserve a first-class budget
    toggle** (the ARCHIVE_MODE pattern), not just honest prose.
16. Dev-harness note (found during the UI protocol, not by a persona): passing
    a non-string to `__useSelection.select()` crashes EntityPanel to a black
    screen — no error boundary on the right rail. Not user-reachable.

## Named operator decisions (deliberately not taken overnight)

- `history_max_bytes` default stays 2 GB. A true 48h global archive costs
  ~150 GB at measured ingest; raising the default is a disk-budget decision.
  The docs, coverage API, and scrubber now tell the truth about it either way.
- Sidecar RAM (~15 GB combined) as an explicit opt-in toggle vs. documentation.

## Method notes

Personas are simulations grounded in the original study's community research;
verifiers reproduced every finding independently (several personas' evidence
was corrected or bounded by their verifier — disputes are recorded in the raw
results). The wave-3 run started minutes after a machine reboot; personas were
instructed not to file boot-warmup artifacts, and the one finding that
depended on the blackout (mika-2) is about the _reporting_ of gaps, not the
gap itself. Raw persona/verifier JSON for both waves lives in the session
workflow journals; per-finding briefs with full evidence and repro commands
were extracted alongside this report.
