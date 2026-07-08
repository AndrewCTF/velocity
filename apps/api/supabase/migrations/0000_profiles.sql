-- Base identity + clearance table — the root of the classification ACL model.
-- Apply with `supabase db push` or psql BEFORE 0001_gotham_substrate_acl_audit.sql
-- (which ALTERs this table to add clearance/compartments/roles and defines the
-- current_clearance()/current_compartments() helpers every classified RLS policy
-- keys off). Idempotent: safe to re-run.
--
-- Previously the base `public.profiles` table was assumed to exist (created out of
-- band in the Supabase dashboard) — so a deployer applying only the versioned SQL
-- could not stand the schema up from scratch (issue #18). This commits it.

-- ── profiles: one row per auth user; app.security reads clearance/compartments/roles ──
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read + update ONLY their own profile. app.security.current_principal
-- fetches clearance/compartments/roles with the user's OWN token via this policy
-- (never a service key), so least privilege holds end to end.
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select
  using (auth.uid() = id);
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

grant select, update on public.profiles to authenticated;

-- Auto-provision a profile row on signup so every user has clearance defaults
-- (0001 adds `clearance smallint default 0` etc.) without an out-of-band insert.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
