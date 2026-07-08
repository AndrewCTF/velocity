# Database schema — where it lives and how to apply it

The repo has **two** SQL trees, applied to **different** databases. If you are
looking for the classification / clearance RLS and could not find it here, it is
in the Supabase tree (see below) — that was the confusion behind issue #18.

## 1. `infra/db/*.sql` — the self-hosted Postgres (PostGIS + TimescaleDB)

`00_extensions.sql`, `10_ontology.sql`, `11_llm_calls.sql`, `12_maps.sql`.
These are run by the TimescaleDB-HA container's `/docker-entrypoint-initdb.d/`
hook on a fresh data volume. They define the **ownership-scoped** tables
(`auth.uid() = user_id`) used when a self-hosted Postgres backs the ontology.

> Note: the default keyless backend is now local SQLite
> (`app/intel/ontology_local.py`) — see `docs/decisions.md`. These files matter
> only for a Postgres-backed ontology deployment.

## 2. `apps/api/supabase/migrations/*.sql` — the Supabase project

The **classification ACL, clearance model, collaborative-doc store, and immutable
audit log** live here, applied to the Supabase database that backs auth + the
collab/BYOK features:

| file | defines |
| --- | --- |
| `0000_profiles.sql` | base `public.profiles` (id → `auth.users`, email) + own-row RLS + signup trigger — the clearance table's root |
| `0001_gotham_substrate_acl_audit.sql` | clearance columns on `profiles`; `current_clearance()/current_compartments()/current_roles()`; **clearance-aware** RLS on `objects`/`links`/`target_board`; the **`collab_docs`** table with clearance-gated read/write RLS; the **`collab_doc_acl`** SECURITY DEFINER RPC; append-only `action_log` |

Apply **in numeric order** (0000 before 0001 — 0001 ALTERs `profiles` and the
helper functions validate their bodies at `CREATE` time):

```bash
# Supabase CLI (reads apps/api/supabase/migrations in order):
supabase db push

# …or raw psql against the project DB:
psql "$SUPABASE_DB_URL" -f apps/api/supabase/migrations/0000_profiles.sql
psql "$SUPABASE_DB_URL" -f apps/api/supabase/migrations/0001_gotham_substrate_acl_audit.sql
```

The backend never runs DDL — the operator applies these. A guard test
(`apps/api/tests/test_collab_rls_schema.py`) asserts the security-critical
policies (clearance predicate on `collab_docs`, revoked `collab_doc_acl`,
own-row `profiles`) stay present and versioned so they cannot silently regress.

Defense in depth: the API also re-checks clearance in-app on every classified
read (`app/intel/classification.can_read`), so the confidentiality of a
classified `collab_docs` row does not rest on the RLS policy alone
(`app/routes/collab.py:load_doc`, the WS join gate, and the write path).
