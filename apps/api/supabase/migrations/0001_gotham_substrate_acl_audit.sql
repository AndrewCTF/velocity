-- Gotham substrate — classification ACL + immutable audit (phase A+B).
-- Apply with `supabase db push` or psql against the project DB.
-- Idempotent: safe to re-run (IF NOT EXISTS / drop-then-create policies).
--
-- Model: US IC classification ladder 0..4 on each classified row + positive
-- compartments[] the reader must hold. A row is visible iff it is the owner's
-- OR (shared AND row.classification <= reader.clearance AND row.compartments ⊆
-- reader.compartments). A user may never create/raise a row above their own
-- clearance. action_log is append-only (trigger + revoked grants).
--
-- ORDER MATTERS: columns are added BEFORE the language-sql helper functions and
-- the policies that reference them. A `language sql` function body is validated
-- at CREATE time, so profiles.clearance must exist before current_clearance() is
-- defined (else ERROR 42703 column "clearance" does not exist).

-- ── 1. Add columns FIRST ─────────────────────────────────────────────────────
-- profiles: clearance / compartments / roles (least privilege defaults)
alter table public.profiles
  add column if not exists clearance smallint not null default 0,
  add column if not exists compartments text[] not null default '{}',
  add column if not exists roles text[] not null default '{analyst}';

-- classified tables: classification + compartments + shared flag
alter table public.objects
  add column if not exists classification smallint not null default 0,
  add column if not exists compartments text[] not null default '{}',
  add column if not exists shared boolean not null default false;
alter table public.links
  add column if not exists classification smallint not null default 0,
  add column if not exists compartments text[] not null default '{}',
  add column if not exists shared boolean not null default false;
alter table public.target_board
  add column if not exists classification smallint not null default 0,
  add column if not exists compartments text[] not null default '{}',
  add column if not exists shared boolean not null default false;

-- action_log: audit columns (reuse user_id=actor, target_id=resource_id, params=detail)
alter table public.action_log
  add column if not exists actor_email text,
  add column if not exists resource_type text,
  add column if not exists classification smallint not null default 0,
  add column if not exists ip inet,
  add column if not exists user_agent text;

-- ── 2. Helper fns: read CURRENT user's clearance/compartments/roles (bypass RLS) ──
create or replace function public.current_clearance() returns smallint
  language sql stable security definer set search_path = public as
$$ select coalesce((select clearance from public.profiles where id = auth.uid()), 0::smallint) $$;

create or replace function public.current_compartments() returns text[]
  language sql stable security definer set search_path = public as
$$ select coalesce((select compartments from public.profiles where id = auth.uid()), '{}'::text[]) $$;

create or replace function public.current_roles() returns text[]
  language sql stable security definer set search_path = public as
$$ select coalesce((select roles from public.profiles where id = auth.uid()), '{}'::text[]) $$;

-- ── 3. clearance read policies (permissive → OR'd with existing *_self_select) ──
drop policy if exists objects_clearance_select on public.objects;
create policy objects_clearance_select on public.objects for select
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());
drop policy if exists links_clearance_select on public.links;
create policy links_clearance_select on public.links for select
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());
drop policy if exists target_board_clearance_select on public.target_board;
create policy target_board_clearance_select on public.target_board for select
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());

-- ── 4. restrictive: cannot create/raise a row above your own clearance ──
drop policy if exists objects_clf_ceiling on public.objects;
create policy objects_clf_ceiling on public.objects as restrictive for insert
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
drop policy if exists objects_clf_ceiling_upd on public.objects;
create policy objects_clf_ceiling_upd on public.objects as restrictive for update
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
drop policy if exists links_clf_ceiling on public.links;
create policy links_clf_ceiling on public.links as restrictive for insert
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
drop policy if exists links_clf_ceiling_upd on public.links;
create policy links_clf_ceiling_upd on public.links as restrictive for update
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
drop policy if exists target_board_clf_ceiling on public.target_board;
create policy target_board_clf_ceiling on public.target_board as restrictive for insert
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
drop policy if exists target_board_clf_ceiling_upd on public.target_board;
create policy target_board_clf_ceiling_upd on public.target_board as restrictive for update
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());

-- ── 5. action_log immutability: append-only trigger + revoked grants ──
create or replace function public.action_log_immutable() returns trigger
  language plpgsql as
$$ begin raise exception 'action_log is append-only'; end $$;
drop trigger if exists action_log_no_mutate on public.action_log;
create trigger action_log_no_mutate before update or delete on public.action_log
  for each row execute function public.action_log_immutable();
revoke update, delete on public.action_log from authenticated, anon;

-- action_log auditor read (all rows) — OR'd with existing self_select
drop policy if exists action_log_auditor_select on public.action_log;
create policy action_log_auditor_select on public.action_log for select
  using ('auditor' = any(public.current_roles()) or 'admin' = any(public.current_roles()));

-- ── 6. collab CRDT doc store (phase D) ──
create table if not exists public.collab_docs (
  doc_id text primary key,
  kind text not null default 'investigation',
  classification smallint not null default 0,
  compartments text[] not null default '{}',
  owner_uid uuid references auth.users(id),
  state text,                          -- base64-encoded Yjs doc state (PostgREST-friendly)
  updated_at timestamptz not null default now()
);
alter table public.collab_docs enable row level security;
drop policy if exists collab_docs_read on public.collab_docs;
create policy collab_docs_read on public.collab_docs for select
  using (owner_uid = auth.uid()
         or (classification <= public.current_clearance()
             and compartments <@ public.current_compartments()));
drop policy if exists collab_docs_write on public.collab_docs;
create policy collab_docs_write on public.collab_docs for all
  using (owner_uid = auth.uid() or 'admin' = any(public.current_roles()))
  with check (classification <= public.current_clearance()
              and compartments <@ public.current_compartments());

-- ── collab live-channel join gate: definer RPC returns a doc's ACL regardless ──
-- of RLS, so /ws/collab can reject an under-cleared joiner without a service key.
-- Returns no rows when the doc does not exist yet (a new doc — join allowed).
create or replace function public.collab_doc_acl(p_doc text)
  returns table(classification smallint, compartments text[])
  language sql stable security definer set search_path = public as
$$ select classification, compartments from public.collab_docs where doc_id = p_doc $$;
revoke all on function public.collab_doc_acl(text) from public, anon;
grant execute on function public.collab_doc_acl(text) to authenticated;
