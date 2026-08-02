# infra — deployment and the two SQL trees

Repo-wide rules: `/CLAUDE.md`. Decision history: `docs/decisions.md`.

The trap here is that the repo has **two** SQL trees applied to **different**
databases, and the one you are looking for is usually the other one.
`db/README.md` has the full table; the short version:

- `db/*.sql` — self-hosted Postgres (PostGIS + TimescaleDB), applied by the
  container's init hook on a fresh volume. Ownership-scoped tables only.
- `apps/api/supabase/migrations/*.sql` — the Supabase project. The
  classification ACL, clearance model, collab-doc store, and audit log live
  HERE, not in `db/`. Apply in numeric order.

Neither is the default path. The keyless default ontology backend is local
SQLite (`apps/api/app/intel/ontology_local.py`); `db/*.sql` matters only for a
Postgres-backed deployment. Don't wire a new feature through Postgres because
the schema exists here.

`docker/`, `nginx/` — production topology. Read `docs/decisions.md` before
changing either.
