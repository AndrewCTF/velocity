# Velocity beta — operations runbook

Live topology (open beta, set up 2026-06-17):

```
projectvelocity.org ──> Cloudflare Worker (site/)
                          ├─ static site + /login + /app                 (ASSETS)
                          ├─ /api/config /api/me /api/checkout /api/stripe/webhook   (worker-native)
                          └─ /api/* /tiles/* /ws/*  ──HTTPS──>  backend
backend  =  Caddy (Let's Encrypt) on the droplet  ──>  uvicorn 127.0.0.1:8000
            host 167.99.149.34 (Ubuntu 24.04), addressed as 167.99.149.34.nip.io
```

- **Backend**: `apps/api` runs under systemd unit `velocity-api` on the droplet
  (`/opt/velocity-api`, venv, env in `/etc/velocity-api.env`). uvicorn binds
  `127.0.0.1:8000`; Caddy is the only public listener (`:80/:443`).
- **Worker → backend**: `BACKEND_URL=https://167.99.149.34.nip.io` in
  `site/wrangler.jsonc`. `nip.io` is a stopgap because Cloudflare Workers refuse
  `fetch()` to a bare IP (error 1003).
- **Deploy both** with `scripts/deploy.sh [web|api|all]` (web = build + assemble
  `site/app` + `wrangler deploy`; api = rsync to droplet + restart). Backend host
  / creds via env (`DROPLET_HOST`, `SSHPASS`, …); never hard-code them.
  - **Do NOT** `rsync --delete apps/web/dist/ site/app/` by hand. `vite build
    --base=/app/` writes the Cesium runtime to `dist/app/cesium` (vite-plugin-cesium
    joins `outDir` + `CESIUM_BASE_URL=/app/cesium/`), **not** `dist/cesium`. A naive
    sync never carries cesium and `--delete` wipes the old copy → blank globe
    (`Cesium is not defined`, `/app/cesium/Cesium.js` 404). The script assembles
    `site/app` from both roots: `dist` (index.html + assets) and `dist/app/cesium`.
- **AI**: backend LLM points at NVIDIA NIM (`DEEPSEEK_BASE_URL=
  https://integrate.api.nvidia.com/v1`, model `minimaxai/minimax-m3`, a
  reasoner). Config swap only — `app/llm.py` is OpenAI-compatible.
- **Auth**: project signs access tokens with **ES256**. The Worker verifies via
  JWKS; the backend (`app/auth.py`) gates non-public routes and validates the
  Supabase token via GoTrue `/auth/v1/user`. Both require `role=authenticated`.

## One-time DB setup (run in Supabase → SQL Editor)

The `subscriptions` / `tier_limits` tables have RLS self-read policies but were
never granted to the Data API roles, so the Worker (which reads as the signed-in
user, not service_role) gets empty results until these grants exist. RLS still
restricts `subscriptions` to the user's own row.

```sql
grant select on public.subscriptions to authenticated;
grant select on public.tier_limits  to anon, authenticated;
```

## Grant a user a tier (manual, until Stripe is wired)

Tiers: `none | analyst | team | enterprise` (enterprise = max).
The Supabase MCP is read-only, so this is run in the SQL Editor (privileged role,
bypasses RLS).

```sql
-- find the user id
select id, email from auth.users where email = 'user@example.com';

-- grant the tier (replace the uuid)
update public.subscriptions
set tier = 'enterprise', status = 'active', trial_ends_at = null, updated_at = now()
where user_id = '<user-uuid>';

-- verify
select tier, status, public.effective_tier(user_id) as effective
from public.subscriptions where user_id = '<user-uuid>';
```

The Worker caches the data-API tier 60 s; the account page (`/api/me`) reads
fresh, so re-login or hard-reload `/app` to see the change.

Current grant: `andrew@andrewyong.dev` (`b74ae853-c91c-4d08-afe4-ed798e09c203`)
→ `enterprise`.

If the account page shows entitlements as `—`, `tier_limits` has no row for that
tier — insert one (columns: `tier, warm_aois, seats, byok, agent, history`).

## Still to do (dashboard-only — no MCP/API setter available)

- **Auth → URL Configuration**: Site URL is `localhost`. Set it to
  `https://projectvelocity.org` (+ redirect allow-list) so signup-confirmation /
  redirect links work. This is the "sign-in URL is localhost" report.
- **Auth → Providers → Email**: email confirmation is ON and the default sender
  is rate-limited. For an open beta, turn off "Confirm email" for instant signup.

## When `backend.projectvelocity.org` DNS resolves

Repoint off the `nip.io` stopgap:

1. Droplet: change the Caddyfile site label to `backend.projectvelocity.org`,
   `systemctl reload caddy` (issues a cert for the real name).
2. `site/wrangler.jsonc`: `BACKEND_URL=https://backend.projectvelocity.org`, then
   `wrangler deploy`.

## Security notes

- The Worker does NOT hold the service_role key; subscription reads are
  RLS-scoped with the caller's own token (least privilege). Stripe-webhook
  writes would need `SUPABASE_SERVICE_ROLE_KEY` set as a wrangler secret.
- `verifyJwt` (Worker) and `app/auth.py` (backend) both reject any token without
  `role=authenticated` + `sub` — the public anon/publishable key is a valid
  signature but not a valid credential.
