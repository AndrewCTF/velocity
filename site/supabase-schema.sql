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
