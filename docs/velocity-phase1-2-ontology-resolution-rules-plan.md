# Velocity → Gotham-class (civilian observer tier): Phase 1 + 2 implementation plan

**Date:** 2026-06-24
**Scope:** Phase 1 (Persistent Ontology + **Entity Resolution**) and Phase 2 (**Dynamic Layer: rules → alerts + tip-and-cue**) of the roadmap derived from the two Palantir Gotham reports.
**Audience reframe:** Velocity users **observe** (journalists, private companies, aircraft/ship enthusiasts). No sensor/weapon tasking, no kill-chain. "Tip-and-cue" stays **observe→observe** (open-source collection only).

---

## 0. Ground truth (verified this turn, with file refs)

The original roadmap treated Phase 1/2 as large greenfield gaps. Reading the code shows most of the scaffolding **already exists**. The plan below builds **only the genuinely missing pieces** and reuses the rest.

| Capability | Status | Evidence |
|---|---|---|
| Observation/position history store | **built** | `apps/api/app/history.py` — `positions(kind,id,t,lon,lat,track,extra)`, idx `(id,t)`+`(t)`, retention + 2 GB byte-cap + vacuum |
| Per-user ontology Object/Link store | **built** | `apps/api/app/intel/ontology.py` — `OntologyRegistry.upsert/get/link` over Supabase PostgREST, RLS-scoped |
| k-hop search-around | **built** | `intel/ontology.py:307` `traverse()` (BFS, depth clamп 1..3) |
| Shortest-path link analysis | **built** | `intel/ontology.py:347` `path_between()` (undirected BFS, depth 1..6) |
| Geofence rule engine + alert firing | **built** | `apps/api/app/intel/watch.py` (518 lines) — enter/exit transition, persistent acknowledgeable `Alert` objects, `RiskIndicator` stamping |
| Alert push transport | **built** | `routes/alerts.py:117` `/ws/alerts`; `:29` `/api/alerts`; `:34` watch-session token registration |
| Classification ACL + immutable audit + collab | **built + DB-verified** | migration `0001_gotham_substrate_acl_audit.sql` applied; PostgREST probes green this turn |
| **Entity resolution (cross-source identity)** | **NOT BUILT** | `positions`/ontology keyed by a single id (`vessel:<mmsi>`, `aircraft:<icao24>`); no IMO↔MMSI↔name / ICAO24↔reg↔callsign linking |
| **Vessel/behavioral rule types** | **NOT BUILT** | `watch.py` rule kinds = `military_air / jamming / incident / fire` only; no `ais_gap / rendezvous / loiter / new_link` |
| **Tip-and-cue action** | **NOT BUILT** | a fired alert persists + pushes; it does not trigger open-source collection |

### Architecture decisions (locked unless changed)
1. **Split store along the natural seam.** Global open-data corpus (positions + resolved identity) lives **backend-side in SQLite** (`history.py` already owns it; no auth, backend-owned, per-node). Private analysis (flags, notes, investigation links) stays in **Supabase per-user** (`ontology.py`, RLS). Rationale: there is **no service-role key** in the backend (verified — `grep service_role app` empty), so the backend cannot write shared Supabase rows; and the corpus is public open data that doesn't belong in any one user's RLS scope.
2. **Resolution is an INDEX, not a rewrite.** The resolver maintains an alias graph and answers `canonical_of(id)` / `aliases_of(canonical)`. It does **not** re-key `positions` or the ontology. Downstream (dossier, search-around) consults it at query time to gather a vessel's whole MMSI history under one identity. Lazy + non-destructive.
3. **Deterministic-first resolution.** Strong immutable ids resolve the bulk with zero ML: vessel `IMO > MMSI > name+callsign`; aircraft `ICAO24 > registration > callsign`. Fuzzy (normalized-name) is a **deferred, review-only** second pass — **never auto-merge fuzzy**. In OSINT a false merge = misattribution = the cardinal sin both reports stress.
4. **Reuse the existing evaluator.** Phase 2 extends `watch.py` and `alert_rules`; it does **not** introduce a CEP cluster (Flink/Kafka). The detector is a periodic async scan over the warm snapshot + `positions` — the pattern `watch.py` already uses.

---

## Phase 1 — Entity Resolution

### New module: `apps/api/app/intel/resolve.py`
Backend-owned canonical-identity index over SQLite (same DB file as `history.py`, new tables — one file to back up/prune).

**Schema (new tables in `history.db`):**
```sql
CREATE TABLE IF NOT EXISTS entities (
  canonical_id TEXT PRIMARY KEY,   -- e.g. entity:vessel:imo:9074729, or vessel:<mmsi> fallback
  kind         TEXT NOT NULL,      -- vessel | aircraft | ...
  display_name TEXT,
  props        TEXT NOT NULL DEFAULT '{}',
  first_seen   REAL NOT NULL,
  last_seen    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  id_type      TEXT NOT NULL,      -- imo | mmsi | name | callsign | icao24 | registration
  id_value     TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  source       TEXT,
  first_seen   REAL NOT NULL,
  PRIMARY KEY (id_type, id_value)
);
CREATE INDEX IF NOT EXISTS idx_alias_canon ON aliases (canonical_id);
CREATE TABLE IF NOT EXISTS merge_candidates (  -- conflicts held for human review, never auto-merged
  id_a TEXT, id_b TEXT, reason TEXT, ts REAL,
  PRIMARY KEY (id_a, id_b)
);
```

**Public API:**
- `resolve(kind: str, identifiers: dict[str, str]) -> str` — given whatever ids a record carries, upsert aliases and return the canonical id. Deterministic priority per kind. If two **strong** ids point to **different** existing canonicals → record a `merge_candidate`, do **not** merge; keep the strongest-priority canonical for this record.
- `canonical_of(any_id: str) -> str` — alias lookup; mints a canonical from the id itself if unseen.
- `aliases_of(canonical_id: str) -> list[str]` — all source ids fused under one identity (this is what lets a dossier pull a vessel's whole MMSI history).
- `stats() -> dict` — entity/alias counts, conflict count (for `/api/intel/sources` + a `data_sources` MCP field).

**Priority tables (in-module constants):**
```
VESSEL_PRIORITY   = ["imo", "mmsi", "name+callsign"]
AIRCRAFT_PRIORITY = ["icao24", "registration", "callsign"]
```

**Steps**
- **E1.** Write `resolve.py` with the schema + deterministic resolver + conflict→`merge_candidates`. Reuse `history.py`'s `_connect`/executor pattern (async-safe, WAL).
- **E2.** Wire into ingestion: in the AIS path (`routes/ais.py` / `app/marinetraffic.py`) and ADS-B path, call `resolve(kind, identifiers)` for each record that carries >1 identifier (AIS static data → mmsi+imo+name+callsign; ADS-B → icao24+callsign+registration when present). Cheap: only when a *new* alias appears (dedupe in-memory like `history._last`). If a feed never supplies IMO (likely for keyless AIS), resolution gracefully degrades to MMSI-only — **no harm, documented**.
- **E3.** Surface resolved identity: `intel/dossier.py` and the search-around path call `aliases_of(canonical)` so the same vessel across MMSI changes is one object with merged history. Add resolved-identity fields to the vessel dossier.

**Tests — `apps/api/tests/test_resolve.py`** (temp SQLite, no network):
- same MMSI twice → same canonical.
- `(mmsi=A, imo=X)` then `(mmsi=B, imo=X)` → **same** canonical (IMO links across MMSI change). ← the headline behavior.
- `(mmsi=A, imo=X)` then `(mmsi=A, imo=Y)` (MMSI reused / conflict) → **no silent merge**; a `merge_candidate` row is written.
- `canonical_of(unseen)` mints; `aliases_of` returns all linked ids.

**Acceptance:** `pytest -q` still ≥25 passed incl. the new file; a two-MMSI/one-IMO vessel resolves to one identity in a live dossier (or, if no live IMO, documented degrade).

---

## Phase 2 — Dynamic Layer: new rule types + tip-and-cue

Extend `intel/watch.py` (do not fork it). Add rule kinds and a collection action.

### New detectors (over `history.positions` + the warm snapshot)
- **R1 — `ais_gap`.** Vessel had positions inside an AOI, then **no observation for ≥ N minutes** while last seen in-area. Reads `history.query_tracks` for the AOI; fires when a tracked MMSI goes silent past threshold. (Directly attacks the AIS-blindspot/dark-vessel concern.)
- **R2 — `rendezvous` / `proximity`.** Two vessels within X nm for ≥ Y minutes (ship-to-ship transfer signature). Pairwise scan over recent in-AOI tracks (bounded by AOI + candidate cap).
- **R3 — `loiter`.** A single entity stays within a small radius for ≥ Y minutes (anchoring/holding off a sensitive site).
- **R4 — `new_link`.** Fires when entity resolution (Phase 1) or an ontology write creates an edge between two **watched** entities (e.g. a watched company now `operates` a watched vessel). Hooks the resolver/ontology write path.

All reuse `watch.py`'s **enter/exit transition** state model (`_WatchState`) so a standing condition fires **once**, not every tick.

### Tip-and-cue action: `apps/api/app/intel/cue.py`
- On a fired alert whose rule has `action="cue"`, enqueue an **open-source** collection for the alert's AOI:
  - Sentinel-1 SAR dark-vessel pass (reuse `maritime.sar.*` / `app.imagery.ondemand`) — the keyless coverage for AIS-dark zones.
  - On-demand AOI imagery (reuse `app.imagery.ondemand` by AOI + before/after).
- The cue result attaches back onto the alert object (`props.cue = {...}`) so the analyst sees "we went and looked." **Observe→observe only** — no external command, no tasking of anything we don't own.

**Steps**
- **R-schema.** Add the new kinds to `routes/alert_rules.py` KINDS + any rule-shape fields (AOI polygon/centre+radius, threshold minutes, pair distance). Confirm `alert_rules` columns cover `params` (jsonb) for thresholds; add a migration only if a column is missing.
- **R1–R4.** Implement detectors in `watch.py` behind the existing evaluator loop; each returns `_Candidate`s exactly like `candidates_from_snapshot`.
- **R-cue.** Implement `cue.py`; call it from the fire path when `rule.action == "cue"`.
- **R-push.** No transport work — reuse `/ws/alerts` + `/api/alerts` (already there).

**Tests — `apps/api/tests/test_watch_rules.py`** (synthetic tracks, no network):
- `ais_gap`: feed positions then a silence gap → exactly one fire on transition, none while still reporting.
- `rendezvous`: two synthetic tracks converge < X nm for > Y min → one fire; diverging → none.
- `loiter`: stationary track > Y min → one fire.
- `new_link`: asserting a watched↔watched edge → one fire; unwatched edge → none.
- `cue` (mock the imagery/SAR call): a `cue`-action fire calls the collector once with the AOI.

**Acceptance:** `pytest -q` ≥25 + new tests green; `pnpm -r typecheck` green (if any frontend rule-form field is added); a synthetic AIS-gap inside an AOI fires one alert and (with `action=cue`) records a SAR pull.

---

## Out of scope / deferred (named, not silently dropped)
- **Phase 3** (centrality/community/Louvain, auto pattern-of-life baselines) — separate spec.
- **Phase 4** (AIS keyless-source spike, civilian connectors) — parallel track; honest expectation per memory `keyless-ais-sources-exhausted`: little new live AIS reachable from server egress, SAR remains the dark-zone coverage. R1 (`ais_gap`) makes the existing data more useful regardless.
- **Phase 5** (NL query over the ontology, auto-briefs, collab UX polish).
- **Fuzzy/probabilistic entity merge** — schema supports `merge_candidates`; the matcher + review UI are deferred until the deterministic gap is measured.
- **System-corpus in Supabase** (shared rows written by a service role) — not pursued; the split-store decision makes it unnecessary. Revisit only if cross-user shared corpus is required.

## Verification plan (evidence, per the anti-hallucination contract)
1. `cd apps/api && .venv/bin/pytest -q` → ≥25 passed incl. `test_resolve.py` + `test_watch_rules.py` (show output).
2. `pnpm -r typecheck` green at each commit boundary.
3. Live: a vessel observed under two MMSIs sharing one IMO resolves to one dossier identity (or documented degrade if no live IMO).
4. Live: a synthetic/real AIS-gap inside a watch AOI fires exactly one `/ws/alerts` event; `action=cue` records a SAR/imagery pull on the alert object.

## Risks
- **AIS identifier poverty.** Keyless AIS may omit IMO/static data → resolution degrades to MMSI-only. Mitigation: resolver is non-destructive; quality improves automatically as richer feeds (Phase 4) land. No correctness risk, only coverage.
- **False merge.** Guarded by deterministic-only auto-merge + `merge_candidates` review queue. Never auto-merge fuzzy.
- **Detector cost.** Pairwise rendezvous is O(n²) per AOI; bounded by AOI scope + a candidate cap (`# ponytail: O(n²) within AOI; spatial index if AOIs grow large`).
