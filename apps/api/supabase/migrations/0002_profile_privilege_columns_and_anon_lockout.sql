-- 0002 — a user can no longer grant themselves roles or clearance, and the
-- public anon key reads and writes nothing it should not (ASVS 5.0 V8.2.1,
-- V8.2.3, V10.3.2; docs/security/auth-and-sessions.md).
--
-- Apply AFTER 0000 and 0001. Idempotent. Never edit 0000/0001 in place: they
-- are already applied to live projects, so a fix there reaches nobody.
--
-- ── The defect ──────────────────────────────────────────────────────────────
-- 0000 granted UPDATE on the WHOLE profiles row to `authenticated`, gated only
-- by `auth.uid() = id`. 0001 then added `roles`, `clearance` and `compartments`
-- to that same row, and app.security builds Principal.roles/clearance from it.
-- So any signed-in user could send
--     PATCH /rest/v1/profiles?id=eq.<self>   {"roles":["admin"],"clearance":4}
-- with their own access token and the public anon key, and pass
-- require_operator (op.python, actuation, model downloads) plus every
-- clearance-gated RLS policy.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- No column of profiles is self-writable. Nothing in apps/api or apps/web
-- PATCHes profiles (the signup trigger writes the row), and `email` is not
-- safe to hand out either: app.security uses profiles.email as the principal's
-- email and the audit log records it as `actor_email`, so a self-writable email
-- is a forgeable audit identity. Email is kept in sync from auth.users by a
-- trigger instead.
--
-- roles / clearance / compartments change only through
--   * the service role (Supabase dashboard / server-side admin scripts), or
--   * public.admin_set_profile_access(), a SECURITY DEFINER RPC that refuses
--     any caller without the `admin` role and cannot grant a clearance or
--     compartment the calling admin does not hold.

-- ── 1. profiles: no self-service writes ─────────────────────────────────────
revoke insert, update, delete on public.profiles from authenticated, anon;
revoke all on public.profiles from anon;
drop policy if exists profiles_self_update on public.profiles;
-- Read-own stays (0000's profiles_self_select); scope it to signed-in users.
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated
  using (auth.uid() = id);
grant select on public.profiles to authenticated;

-- ── 2. keep profiles.email in step with auth.users (it is no longer writable) ─
create or replace function public.handle_user_email_change() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end
$$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ── 3. the one path by which a human changes another human's access ─────────
create or replace function public.admin_set_profile_access(
  p_user uuid,
  p_roles text[] default null,
  p_clearance smallint default null,
  p_compartments text[] default null
) returns void
  language plpgsql security definer set search_path = public as
$$
begin
  if auth.uid() is null or not ('admin' = any(public.current_roles())) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin cannot mint access above their own: the same ceiling the
  -- *_clf_ceiling policies apply to rows.
  if p_clearance is not null and p_clearance > public.current_clearance() then
    raise exception 'cannot grant clearance above your own' using errcode = '42501';
  end if;
  if p_compartments is not null
     and not (p_compartments <@ public.current_compartments()) then
    raise exception 'cannot grant a compartment you do not hold' using errcode = '42501';
  end if;
  update public.profiles
     set roles        = coalesce(p_roles, roles),
         clearance    = coalesce(p_clearance, clearance),
         compartments = coalesce(p_compartments, compartments)
   where id = p_user;
  if not found then
    raise exception 'no profile for that user' using errcode = 'P0002';
  end if;
end
$$;
revoke all on function public.admin_set_profile_access(uuid, text[], smallint, text[])
  from public, anon;
grant execute on function public.admin_set_profile_access(uuid, text[], smallint, text[])
  to authenticated;

-- ── 4. the anon key is public: it must not read or write classified tables ───
-- 0001's permissive clearance policies had no `to` clause, so they applied to
-- `anon` as well. For anon, current_clearance() is 0 and current_compartments()
-- is '{}', so every shared unclassified objects/links/target_board row and
-- every unclassified collab doc was readable with the key shipped in the web
-- bundle, and collab_docs_write's WITH CHECK let anon INSERT.
drop policy if exists objects_clearance_select on public.objects;
create policy objects_clearance_select on public.objects for select to authenticated
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());
drop policy if exists links_clearance_select on public.links;
create policy links_clearance_select on public.links for select to authenticated
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());
drop policy if exists target_board_clearance_select on public.target_board;
create policy target_board_clearance_select on public.target_board for select to authenticated
  using (shared and classification <= public.current_clearance()
         and compartments <@ public.current_compartments());

revoke all on public.collab_docs from anon;
drop policy if exists collab_docs_read on public.collab_docs;
create policy collab_docs_read on public.collab_docs for select to authenticated
  using (owner_uid = auth.uid()
         or (classification <= public.current_clearance()
             and compartments <@ public.current_compartments()));
-- 0001's WITH CHECK tested clearance only, so a user could INSERT a doc owned by
-- someone else (or by nobody, squatting the doc_id) and UPDATE their own doc's
-- owner_uid away. The owner predicate now holds on the written row too.
drop policy if exists collab_docs_write on public.collab_docs;
create policy collab_docs_write on public.collab_docs for all to authenticated
  using (owner_uid = auth.uid() or 'admin' = any(public.current_roles()))
  with check ((owner_uid = auth.uid() or 'admin' = any(public.current_roles()))
              and classification <= public.current_clearance()
              and compartments <@ public.current_compartments());
