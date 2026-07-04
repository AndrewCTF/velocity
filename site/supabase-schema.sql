-- ============================================================================
-- Velocity SaaS — Supabase schema (run in Supabase → SQL Editor)
-- Auth is handled by Supabase Auth (GoTrue). This adds the profile + paid-tier
-- (subscription) model, row-level security, and a 14-day trial on signup.
-- ============================================================================

-- Tiers a subscription can hold. 'none' = trial expired / no plan.
do $$ begin
  create type velocity_tier as enum ('none', 'analyst', 'team', 'enterprise');
exception when duplicate_object then null; end $$;

do $$ begin
  create type velocity_status as enum ('trialing', 'active', 'past_due', 'canceled');
exception when duplicate_object then null; end $$;

-- ---- profiles: 1:1 with auth.users ----------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);

-- ---- subscriptions: the paywall source of truth ---------------------------
create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  tier                   velocity_tier   not null default 'analyst',
  status                 velocity_status not null default 'trialing',
  stripe_customer_id     text,
  stripe_subscription_id text,
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  updated_at             timestamptz not null default now()
);

-- ---- entitlements a tier grants (read by the gateway) ---------------------
-- Kept in the DB so limits can change without a redeploy.
create table if not exists public.tier_limits (
  tier        velocity_tier primary key,
  warm_aois   int  not null,
  seats       int  not null,
  byok        bool not null,   -- may connect restricted feeds (ACLED, commercial imagery, global AIS)
  agent       bool not null,   -- MCP agent endpoint access
  history     bool not null    -- replay / persistence
);

insert into public.tier_limits (tier, warm_aois, seats, byok, agent, history) values
  ('none',       0,  1, false, false, false),
  ('analyst',    3,  1, false, true,  false),
  ('team',      15,  5, true,  true,  false),
  ('enterprise', 999, 999, true, true, true)
on conflict (tier) do update set
  warm_aois = excluded.warm_aois, seats = excluded.seats,
  byok = excluded.byok, agent = excluded.agent, history = excluded.history;

-- ---- new signup → profile + 14-day Analyst trial --------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
    on conflict (id) do nothing;
  insert into public.subscriptions (user_id, tier, status, trial_ends_at)
    values (new.id, 'analyst', 'trialing', now() + interval '14 days')
    on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- handle_new_user only ever runs as a trigger. Postgres grants EXECUTE to
-- PUBLIC by default, which would also expose it as a SECURITY DEFINER RPC at
-- /rest/v1/rpc/handle_new_user. Revoke so anon/authenticated can't call it
-- directly (the trigger still fires regardless of these grants).
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---- row-level security: a user sees only their own rows ------------------
alter table public.profiles      enable row level security;
alter table public.subscriptions enable row level security;
alter table public.tier_limits   enable row level security;

drop policy if exists "own profile"      on public.profiles;
drop policy if exists "own subscription" on public.subscriptions;
drop policy if exists "read tier limits" on public.tier_limits;

create policy "own profile"      on public.profiles      for select using (auth.uid() = id);
create policy "own subscription" on public.subscriptions for select using (auth.uid() = user_id);
create policy "read tier limits" on public.tier_limits   for select using (true);

-- NB: writes to subscriptions happen ONLY via the Stripe webhook using the
-- service_role key (which bypasses RLS). The client can never grant itself a tier.

-- ---- effective access helper (trial-aware) --------------------------------
-- Returns the tier the user is actually entitled to right now.
create or replace function public.effective_tier(uid uuid)
returns velocity_tier language sql stable set search_path = public as $$
  select case
    when s.status = 'canceled' then 'none'::velocity_tier
    when s.status = 'trialing' and s.trial_ends_at < now() then 'none'::velocity_tier
    else s.tier
  end
  from public.subscriptions s where s.user_id = uid;
$$;

-- ---- BYOK: per-user upstream API keys (Fernet-encrypted at rest) -----------
-- The backend encrypts each key with BYOK_ENC_KEY before insert and decrypts
-- on read, so this table only ever holds ciphertext + a last-4 hint. RLS
-- scopes every row to its owner; PostgREST upsert needs insert+update grants.
create table if not exists public.user_keys (
  user_id    uuid not null references auth.users(id) on delete cascade,
  provider   text not null,
  ciphertext text not null,
  hint       text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.user_keys enable row level security;

drop policy if exists user_keys_self_select on public.user_keys;
drop policy if exists user_keys_self_insert on public.user_keys;
drop policy if exists user_keys_self_update on public.user_keys;
drop policy if exists user_keys_self_delete on public.user_keys;

create policy user_keys_self_select on public.user_keys for select using (auth.uid() = user_id);
create policy user_keys_self_insert on public.user_keys for insert with check (auth.uid() = user_id);
create policy user_keys_self_update on public.user_keys for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy user_keys_self_delete on public.user_keys for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.user_keys to authenticated;

-- ---- per-user alert rules (standing watches) ------------------------------
create table if not exists public.alert_rules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  label        text not null,
  lat          double precision not null,
  lon          double precision not null,
  radius_nm    double precision not null default 50,
  kinds        text[] not null default '{}',
  min_severity int not null default 1,
  channel      text not null default 'inapp',
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.alert_rules enable row level security;

drop policy if exists alert_rules_self_select on public.alert_rules;
drop policy if exists alert_rules_self_insert on public.alert_rules;
drop policy if exists alert_rules_self_update on public.alert_rules;
drop policy if exists alert_rules_self_delete on public.alert_rules;

create policy alert_rules_self_select on public.alert_rules for select using (auth.uid() = user_id);
create policy alert_rules_self_insert on public.alert_rules for insert with check (auth.uid() = user_id);
create policy alert_rules_self_update on public.alert_rules for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy alert_rules_self_delete on public.alert_rules for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.alert_rules to authenticated;

-- ---- per-user target lifecycle board (F2T2EA Kanban) ----------------------
-- One row per (user, entity) tracked through the kill chain. Moving an entity
-- across stages PATCHes `stage`; re-adding the same entity upserts on the
-- unique(user_id, entity_id) constraint, so a track is never duplicated.
create table if not exists public.target_board (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  entity_id      text not null,
  stage          text not null default 'confirm',
  priority       int not null default 3,
  note           text not null default '',
  requirements   jsonb not null default '{}'::jsonb,   -- F2T2EA confirmation checklist
  classification text not null default 'UNCLAS//FOUO', -- per-target caveat
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, entity_id)
);
alter table public.target_board add column if not exists requirements jsonb not null default '{}'::jsonb;
alter table public.target_board add column if not exists classification text not null default 'UNCLAS//FOUO';

-- Keep updated_at fresh on every stage move / re-prioritise (the backend PATCH
-- only sends the changed columns; the column advances here instead).
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

-- ---- ontology spine: objects / links / action_log (Track A1 + C1) ----------
-- The typed semantic layer the kanban, alerts, and agent compose on. Per-user,
-- RLS-scoped exactly like the tables above. (Standalone copy: infra/db/10_ontology.sql.)
--
-- objects: typed nodes keyed by the canonical ids already used across the repo
--   (aircraft:<icao24> | vessel:<mmsi> | incident:<uuid> | sim:<id>, plus
--   target:<uuid> / watch:<uuid> derived nodes the action layer mints). props
--   holds distilled attributes, NOT a feature dump. One row per (user, id).
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

-- links: typed directed edges src --rel--> dst, idempotent per (user, src, dst, rel).
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

-- action_log: who did what (audit-of-who, NOT RBAC — no role column by design).
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

-- ---- llm_calls: LLM observability log (Track D3) ----------------------------
-- One row per app/llm.py chat() completion, written best-effort with the
-- caller's OWN Supabase token so RLS (auth.uid() = user_id) scopes every row to
-- the user who made the call. A call with no bound user token is simply NOT
-- logged (the backend has no service-role key here and RLS forbids a NULL-owner
-- insert) — logging degrades silently and NEVER blocks or fails the LLM call.
-- Columns: backend (deepseek|minimax|ollama|NULL), model_id, tier (fast|reason),
-- ok, prompt/completion/total tokens (from LlmResult.usage; 0 when omitted),
-- latency_ms, tool_calls, label (caller tag), error (truncated). Append-only.
create table if not exists public.llm_calls (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  backend           text,
  model_id          text,
  tier              text,
  ok                boolean not null default false,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  total_tokens      int not null default 0,
  latency_ms        int not null default 0,
  tool_calls        int not null default 0,
  label             text not null default '',
  error             text,
  ts                timestamptz not null default now()
);

create index if not exists llm_calls_user_ts_idx on public.llm_calls (user_id, ts desc);
create index if not exists llm_calls_user_model_idx on public.llm_calls (user_id, model_id);

alter table public.llm_calls enable row level security;

drop policy if exists llm_calls_self_select on public.llm_calls;
drop policy if exists llm_calls_self_insert on public.llm_calls;

create policy llm_calls_self_select on public.llm_calls for select using (auth.uid() = user_id);
create policy llm_calls_self_insert on public.llm_calls for insert with check (auth.uid() = user_id);

-- Append-only from the app: grant insert + select, NOT update/delete.
grant select, insert on public.llm_calls to authenticated;

-- ---- auto-enable RLS on any new public table (event trigger) --------------
-- Belt-and-suspenders: if a future table lands in `public` without RLS, this
-- event trigger turns it on automatically. It must stay SECURITY DEFINER so it
-- can ALTER tables it doesn't own. As with handle_new_user above, Postgres
-- grants EXECUTE to PUBLIC by default, which also exposes a SECURITY DEFINER
-- function as an RPC at /rest/v1/rpc/rls_auto_enable (flagged by the Supabase
-- security advisor as anon/authenticated-executable). The function is only ever
-- meaningful when fired by the trigger, so revoke direct EXECUTE.
create or replace function public.rls_auto_enable()
returns event_trigger language plpgsql security definer set search_path = pg_catalog as $$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
    if cmd.schema_name = 'public' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
      exception when others then
        raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    end if;
  end loop;
end $$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
  execute function public.rls_auto_enable();

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- ---- leaked-password protection (HaveIBeenPwned) --------------------------
-- The Supabase security advisor also flags `auth_leaked_password_protection`
-- as disabled. This is GoTrue auth config, NOT a Postgres object, so it cannot
-- be set from this SQL file or the read-only MCP. Enable it ONE of these ways:
--   * Dashboard: Authentication -> Sign In / Providers -> Password settings ->
--     enable "Leaked password protection".
--   * Management API:
--       PATCH https://api.supabase.com/v1/projects/<ref>/config/auth
--       Authorization: Bearer <SUPABASE_PAT>
--       {"password_hibp_enabled": true}
--   * Supabase CLI: [auth] enable_password_hibp = true ; then `supabase config push`.

-- ---- saved maps (shared named COP, Track D2) --------------------------------
-- A saved COP is NOT a new table: it is a public.objects row (kind 'object',
-- props->>kind = 'map') written via the ontology registry, so it inherits the
-- objects RLS (auth.uid() = user_id) above. This partial index just keeps the
-- "list my maps" query (props->>kind = 'map', newest first) off a full per-user
-- scan as the ontology accumulates alerts / investigations / flagged entities.
-- The /ws/cop follow-along channel is in-process only and persists nothing.
create index if not exists objects_user_map_idx
  on public.objects (user_id, created_at desc)
  where (props->>'kind') = 'map';
