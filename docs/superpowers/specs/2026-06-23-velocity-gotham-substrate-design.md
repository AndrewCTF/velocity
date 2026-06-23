# Velocity Gotham Substrate — Design Spec

_2026-06-23. Branch `gotham-substrate`. Closes the §5 "back half" gap from `docs/gotham-vs-velocity-2026-06-23.md`._

## Goal
Add the institutional substrate that separates Gotham from a viewer: enforced classification + access control, immutable audit, document→ontology entity extraction, and real-time multi-analyst collaboration.

## Non-goals (explicit)
- **AI guardrails** (per-model data/action permissioning) — dropped for cost this round.
- **Attribute-level redaction** — row/object-level only for v1; field masking deferred.
- SIEM connector — provide a read endpoint, not a push integration.
- Full classification-scheme admin UI — scheme is fixed (US IC) in code for v1.

## Decisions (locked)
- Classification = **US IC**: `0 UNCLASSIFIED · 1 CUI · 2 CONFIDENTIAL · 3 SECRET · 4 TOP SECRET`, plus `compartments text[]` (e.g. `NOFORN`, `FVEY`).
- ACL = **row-level via Postgres RLS**, policy joins `profiles` on `auth.uid()` (no custom-claims auth hook).
- Extractor = **`app.llm`** existing fallback chain (NVIDIA MiniMax-M3 → DeepSeek → Ollama).
- Collab = **full CRDT** (Yjs), server is a relay + snapshot (no server-side Yjs engine).

## Reused infra (verified 2026-06-23)
- Supabase Postgres, RLS already on all tables. Tables: `profiles`(5), `objects`, `links`, `action_log`, `target_board`, `llm_calls`, `alert_rules`.
- Ontology persists via Supabase REST `/rest/v1/objects` + `/rest/v1/links` (`ontology.py`, `keys._client/_headers`).
- Auth: `app/auth.py` Supabase JWT; `require_ws_key(ws)` gate-before-accept for WS.
- `app.llm` chain (config.py:159–171); `NVIDIA_API_KEY` in `.env`.
- `/ws/cop` follow-along room (`routes/maps.py:353`) — JSON `{kind,...}` frames, room manager.

---

## Subsystem A — Classification + Access Control

### Data model (migration)
- `ALTER TABLE objects/links/target_board ADD classification smallint NOT NULL DEFAULT 0, ADD compartments text[] NOT NULL DEFAULT '{}', ADD owner_uid uuid` (owner where absent).
- `ALTER TABLE profiles ADD clearance smallint NOT NULL DEFAULT 0, ADD compartments text[] NOT NULL DEFAULT '{}', ADD roles text[] NOT NULL DEFAULT '{analyst}'`.
- New tables `documents`, `annotations`, `collab_docs` carry the same `classification`/`compartments`/`owner_uid`.

### RLS (the enforcement)
For each classified table, a read policy:
```sql
create policy clf_read on objects for select using (
  classification <= coalesce((select clearance from profiles where id = auth.uid()), 0)
  and compartments <@ coalesce((select compartments from profiles where id = auth.uid()), '{}')
);
```
Write policy: same predicate AND (`owner_uid = auth.uid()` OR `'admin' = any(roles)`). Service-role key (backend) bypasses RLS for system writes (extraction, snapshots) but stamps classification explicitly.

### Backend
- `app/intel/classification.py`: the level enum, label↔int maps, `marking(level, compartments) -> "SECRET//NOFORN"`, and `redact_for(user, rows)` defense-in-depth filter (RLS is primary; this is belt-and-suspenders for service-role reads).
- `app/auth.py`: extend the verified principal with `clearance`, `compartments`, `roles` (one profile fetch, cached per request).

### Frontend
- `apps/web/src/security/Classification.tsx`: top banner (highest marking currently visible) + `<MarkingBadge level compartments/>`.
- Object/layer/situation cards render their marking badge.

---

## Subsystem B — Immutable Audit

### Schema (`action_log`)
`id bigserial, ts timestamptz default now(), actor_uid uuid, actor_email text, action text, resource_type text, resource_id text, classification smallint, detail jsonb, ip inet, user_agent text`.

### Immutability
- RLS: INSERT allowed for authenticated/service; **no UPDATE/DELETE policy** (default-deny under RLS) + `REVOKE UPDATE, DELETE ON action_log FROM authenticated, anon` + a `BEFORE UPDATE OR DELETE` trigger raising `'action_log is append-only'`.
- Read: SELECT policy gated to `'auditor' = any(roles) or 'admin' = any(roles)`.

### Capture
- `app/audit.py`: `await audit(action, resource_type, resource_id, *, classification=0, detail=None, request=None)` writes one row (service-role).
- FastAPI dependency `audit_mutations` on mutating intel routes (POST/PATCH/DELETE) auto-logs verb+path+actor+ip.
- Explicit `audit(...)` calls in ontology write, `/api/extract`, collab snapshot/join.
- `GET /api/audit?since=&limit=` (auditor-gated) for export.

---

## Subsystem C — Document Entity-Extraction

### Endpoint
`POST /api/extract` (auth-gated) body `{ text?: str, situation_id?: str, classification: int, compartments: [str] }` (file upload → text server-side; v1 accepts text + .txt/.md/.csv, PDF later).

### Pipeline
1. `app.llm` strict-JSON prompt → `{entities:[{type,name,props}], relationships:[{src,rel,dst}]}`. Types constrained to ontology set (Person, Organization, Location, Vessel, Aircraft, Event, Document, Other).
2. Persist a `Document` object (the source) + extracted `objects`, deduped by `(type, lower(name))`; create `links` for relationships + `Appears In`/provenance links doc→entity (with char span in props).
3. All rows stamped with request classification/compartments + `owner_uid`.
4. `audit('extract', 'document', doc_id, ...)`.

### Frontend
- `apps/web/src/extract/ExtractPanel.tsx`: paste/upload + classification picker → calls `/api/extract` → **review list** (entities/links with confidence) → "Commit to graph" pushes into the investigation canvas.

### Fallback / cost
- `app.llm` already falls NVIDIA→DeepSeek→Ollama; if all unset → 503 with a clear message (no silent empty).

---

## Subsystem D — Multi-analyst Collab (CRDT)

### Transport
- New `app/routes/collab.py` `@router.websocket("/ws/collab")` `?doc=<id>`: `require_ws_key` → clearance check on the doc's classification (join denied if `doc.classification > user.clearance`) → join room → **relay** every inbound binary Yjs update to all other peers; awareness frames relayed too.
- Server is a dumb relay + **snapshot**: debounced (~2s) it stores the latest full Yjs state from a designated client into `collab_docs.state bytea`; on join it sends the stored state so a late joiner syncs. No Python Yjs engine.

### Schema
`collab_docs(doc_id text primary key, kind text, classification smallint, compartments text[], owner_uid uuid, state bytea, updated_at timestamptz)`.

### Frontend
- Add deps `yjs`, `y-protocols`. `apps/web/src/collab/useCollabDoc.ts`: a Yjs `Doc` + a custom provider over `withWsKey` WS (encode/decode update + awareness). Binds:
  - investigation graph nodes/edges (`Y.Map`/`Y.Array`),
  - annotations/markers,
  - awareness (cursor, viewport, name/color, who's-online roster).
- Presence roster + remote cursors rendered on the canvas/globe.

### Conflict
- Yjs CRDT auto-merges (last-writer-wins per field, no manual resolution).

---

## Phasing & order
**A (ACL+audit DB + backend)** → **B (audit capture wired)** → **C (extraction)** → **D (collab CRDT)**. A+B are the foundation C and D log into and respect.

## Testing (CLAUDE.md: pytest ≥25 must hold, `pnpm -r typecheck` green at each commit)
- A: `test_classification.py` — marking() strings; RLS predicate unit (clearance 2 cannot see classification 3 row) via SQL against a test principal.
- B: `test_audit.py` — `audit()` writes a row; UPDATE/DELETE on `action_log` raises; auditor-only read.
- C: `test_extract.py` — sample text → schema-valid entities/links; objects carry classification + provenance; dedup works (mock `app.llm`).
- D: `test_collab.py` — two relayed update streams converge to one state; join below clearance rejected.

## Risks
- RLS sub-selects on `profiles` per row: index `profiles(id)` (PK already) — fine at current scale; revisit with custom JWT claims if hot.
- Service-role writes bypass RLS → extraction/collab MUST stamp classification explicitly (covered by `classification.py` + tests).
- Yjs snapshot trusts one client's state → pick the snapshot source deterministically (lowest peer id) + cap blob size (reuse cop room's delta cap).
