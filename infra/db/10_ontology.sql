-- ============================================================================
-- Velocity ontology spine — objects / links / action_log (Track A1 + C1)
-- Per-user, RLS-scoped exactly like alert_rules / target_board / user_keys.
-- Idempotent: safe to re-run. Apply via Supabase SQL editor / MCP (the operator
-- applies; the backend never runs DDL).
-- ============================================================================

-- ---- objects: typed nodes keyed by canonical id ----------------------------
-- id is a canonical id already used across the repo:
--   aircraft:<icao24> | vessel:<mmsi> | incident:<uuid> | sim:<id>
-- (and derived nodes the action layer mints: target:<uuid>, watch:<uuid>).
-- One row per (user, id); props holds distilled attributes (NOT a feature dump).
create table if not exists public.objects (
  id          text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'object',
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists objects_user_kind_idx on public.objects (user_id, kind);

alter table public.objects enable row level security;

drop policy if exists objects_self_select on public.objects;
drop policy if exists objects_self_insert on public.objects;
drop policy if exists objects_self_update on public.objects;
drop policy if exists objects_self_delete on public.objects;

create policy objects_self_select on public.objects for select using (auth.uid() = user_id);
create policy objects_self_insert on public.objects for insert with check (auth.uid() = user_id);
create policy objects_self_update on public.objects for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy objects_self_delete on public.objects for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.objects to authenticated;

-- ---- links: typed directed edges src --rel--> dst --------------------------
-- Idempotent per (user, src, dst, rel) so re-asserting an edge upserts.
create table if not exists public.links (
  id          uuid not null default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  src         text not null,
  dst         text not null,
  rel         text not null,
  props       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (id),
  unique (user_id, src, dst, rel)
);

-- Traversal walks both endpoints; index each side scoped to the user.
create index if not exists links_user_src_idx on public.links (user_id, src);
create index if not exists links_user_dst_idx on public.links (user_id, dst);

alter table public.links enable row level security;

drop policy if exists links_self_select on public.links;
drop policy if exists links_self_insert on public.links;
drop policy if exists links_self_update on public.links;
drop policy if exists links_self_delete on public.links;

create policy links_self_select on public.links for select using (auth.uid() = user_id);
create policy links_self_insert on public.links for insert with check (auth.uid() = user_id);
create policy links_self_update on public.links for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy links_self_delete on public.links for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.links to authenticated;

-- ---- action_log: who did what (audit-of-who, NOT RBAC) ----------------------
-- Every governed write-back (flag_entity / promote_incident / nominate_target /
-- add_watch) appends one row. user_id = WHO; there is no role column by design.
-- Append-only from the app: grant insert + select, NOT update/delete.
create table if not exists public.action_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  action      text not null,
  target_id   text not null,
  params      jsonb not null default '{}'::jsonb,
  ts          timestamptz not null default now()
);

create index if not exists action_log_user_ts_idx on public.action_log (user_id, ts desc);

alter table public.action_log enable row level security;

drop policy if exists action_log_self_select on public.action_log;
drop policy if exists action_log_self_insert on public.action_log;

create policy action_log_self_select on public.action_log for select using (auth.uid() = user_id);
create policy action_log_self_insert on public.action_log for insert with check (auth.uid() = user_id);

grant select, insert on public.action_log to authenticated;

-- ---- target_board: created here IF NOT already present ----------------------
-- routes/targets.py owns this table; it is normally created in
-- site/supabase-schema.sql. Re-declared here (idempotent) so the ontology
-- migration is self-contained — nominate_target writes to it. Columns mirror
-- the canonical definition exactly (see site/supabase-schema.sql).
create table if not exists public.target_board (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  entity_id      text not null,
  stage          text not null default 'confirm',
  priority       int not null default 3,
  note           text not null default '',
  -- F2T2EA confirmation checklist (target_identity / location_verified /
  -- collateral_estimate / authority_signoff) gating stage advancement, and a
  -- per-target classification caveat. See routes/targets.py.
  requirements   jsonb not null default '{}'::jsonb,
  classification text not null default 'UNCLAS//FOUO',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, entity_id)
);

-- Idempotent add for boards created before the checklist columns existed.
alter table public.target_board add column if not exists requirements jsonb not null default '{}'::jsonb;
alter table public.target_board add column if not exists classification text not null default 'UNCLAS//FOUO';

create or replace function public.target_board_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists target_board_set_updated on public.target_board;
create trigger target_board_set_updated before update on public.target_board
  for each row execute function public.target_board_touch();

alter table public.target_board enable row level security;

drop policy if exists target_board_self_select on public.target_board;
drop policy if exists target_board_self_insert on public.target_board;
drop policy if exists target_board_self_update on public.target_board;
drop policy if exists target_board_self_delete on public.target_board;

create policy target_board_self_select on public.target_board for select using (auth.uid() = user_id);
create policy target_board_self_insert on public.target_board for insert with check (auth.uid() = user_id);
create policy target_board_self_update on public.target_board for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy target_board_self_delete on public.target_board for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.target_board to authenticated;
