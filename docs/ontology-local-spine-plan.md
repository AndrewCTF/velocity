# Ontology local spine — Phase 1 spec (implemented 2026-07-07)

Phase 1 of `docs/roadmap-ontology-2026-07.md`: the ontology store works on a
keyless local boot, holds time, and holds provenance. This is the condensed
as-built spec; rationale + the contract revoke live in
`docs/decisions.md#ontology-local-first-store-2026-07-07`.

## Architecture

One backend behind one factory (`app/intel/ontology.py`). The plan shipped as
dual-backend (SQLite default, PostgREST remote); hours later the operator
invoked the §5c kill criterion and the PostgREST ontology backend was deleted
(`docs/decisions.md`). As built:

- `get_registry(ctx, settings)` → `SqliteRegistry`
  (`app/intel/ontology_local.py`), always. The factory is kept as the seam if
  a remote backend is ever re-earned.
- `traverse` / `path_between` are pure BFS over `get` + `_links_touching` in
  the `_GraphWalk` mixin (`test_ontology_path.py`'s matrix covers the walk
  against the real SQLite store).
- Method surface: `upsert / get / delete / link / traverse / path_between /
  list_by_kind / assert_props / get_assertions`.
- Auth: ontology/situations/maps routes use `current_user_or_local`
  (`app/keys.py`): Supabase auth entirely unconfigured → shared `local`
  identity (request already passed ApiKeyMiddleware); otherwise exactly
  `current_user`. Supabase-backed subsystems OUTSIDE the ontology (BYOK,
  target_board, alert_rules, action_log) are untouched.

## Local schema (SQLite, WAL, `data/ontology.db`)

Same idiom as `app/history.py`: fresh connection per op, sync core in the
default executor, `override_db_path()` test hook (autouse fixture in
`tests/conftest.py` isolates every test to a tmp file).

- `objects(user_id, id, kind, props, classification, compartments, shared,
  created_at, updated_at)` — PK `(user_id, id)`. `props` is the materialized
  latest blob: **wholesale-replaced on upsert (removals included)** — the
  frontend round-trip contract (InvestigationCanvas, situations, maps, COP,
  annotations). Never make upsert merge.
- `assertions(id, user_id, object_id, prop, value, source, confidence,
  observed_at, valid_until, derivation)` — append-only, written by `upsert`'s
  diff and by `assert_props` (merge-style, never removes). Removal tombstone:
  `value=null` + `derivation={"op":"remove"}`. Dedup on (value, source);
  a different source restating a value is corroboration, kept.
- `links(…, source, confidence, observed_at, valid_until, …)` — provenance
  as columns; UNIQUE `(user_id, src, dst, rel)` upsert matches PostgREST
  merge-duplicates. `Link`/`Assertion` pydantic models carry the new fields
  (additive, defaulted — frontend unaffected).

Deviations from the roadmap SQL block, deliberate: `user_id` on every table
(RLS parity); no SQL FK assertions→objects (SQLite FKs off by default —
app-level); links keep ACL columns.

## Budgets

- Per-object: `ontology_max_assertions_per_object` (2000) — oldest deleted
  first, enforced on every write.
- Store: `ontology_db_max_bytes` (2 GB) — oldest 10% of assertions dropped +
  VACUUM, checked at most 1×/hour or per 500 writes.
- If writes fight the caps, the Phase-2 significance filter is wrong; tighten
  it, don't raise caps.

## Migration

`scripts/ontology_export.py --supabase-url … (--service-key|--token) …` pages
`objects`/`links` out of Supabase into the local store; each prop becomes one
assertion with `source='migrated'`, `observed_at=created_at`. Idempotent.

## Verification (as run 2026-07-07)

- `OSINT_DISABLE_BACKGROUND=1 apps/api/.venv/bin/pytest apps/api -q` from repo
  root → 718 passed + 1 skipped (baseline raised from 715);
  `scripts/verify.sh` ALL GREEN.
- Guards: `apps/api/tests/test_ontology_local.py` (keyless route contract,
  two-source provenance, tombstones, caps, user scoping, cascade delete).
- Live keyless: boot `bash scripts/run-api.sh` (repo-root `.env`, no
  Supabase), POST/GET `/api/ontology/object`, search-around, path, analytics,
  assertions — all non-503/401; GRAPH page seeded, saved an investigation
  through the browser, data survived a backend restart
  (`docs/media/ui-graph-local-spine.png`).

## Phase-2 hook points

The promotion pipeline writes through `assert_props(object_id, props,
source="feed:adsb" | "detector:…" | "agent:watch_officer", confidence=…,
derivation=…)` + `link(Link(…, source=…))` — no further schema work needed.
