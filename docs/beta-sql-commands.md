# Beta SQL — run in Supabase → SQL Editor

Copy-paste and run. The SQL Editor runs as a privileged role, so it bypasses RLS
and the MCP read-only restriction.

## 1. One-time: expose self-read for the tier tables

```sql
grant select on public.subscriptions to authenticated;
grant select on public.tier_limits  to anon, authenticated;
```

## 2. Give andrew@andrewyong.dev the max tier (enterprise)

```sql
update public.subscriptions
set tier = 'enterprise', status = 'active', trial_ends_at = null, updated_at = now()
where user_id = 'b74ae853-c91c-4d08-afe4-ed798e09c203';
```

## 3. Verify

```sql
select tier, status, public.effective_tier(user_id) as effective
from public.subscriptions
where user_id = 'b74ae853-c91c-4d08-afe4-ed798e09c203';
-- expect: enterprise | active | enterprise
```

## Grant any other user a tier

Tiers: `none | analyst | team | enterprise`.

```sql
-- find the id
select id, email from auth.users where email = 'user@example.com';

-- set the tier
update public.subscriptions
set tier = 'enterprise', status = 'active', trial_ends_at = null, updated_at = now()
where user_id = '<user-uuid>';
```

After running: re-login or hard-reload `/app` (account page reads fresh; the
data-API tier cache clears within 60 s).
