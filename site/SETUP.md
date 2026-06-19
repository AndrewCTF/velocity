# Velocity SaaS — go-live setup

The gateway Worker is deployed. It serves the marketing site now; **auth + billing
turn on once you complete these steps** (all use accounts only you control).

## 1. Supabase (auth + Postgres)

1. Create a project at supabase.com.
2. **SQL Editor** → paste & run `supabase-schema.sql` (profiles, subscriptions,
   tiers, RLS, 14-day trial trigger).
3. **Authentication → Providers → Email**: enable. (Optional: turn off "Confirm
   email" for instant trial signups.)
4. **Authentication → URL config**: add `https://projectvelocity.org` to Site URL
   + redirect allow-list.
5. Grab from **Project Settings → API**:
   - Project URL → `SUPABASE_URL`
   - `anon` public key → `SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (secret)
   - **Project Settings → API → JWT Secret** → `SUPABASE_JWT_SECRET` (secret)

## 2. Stripe (billing)

1. Create two **recurring (monthly)** products → copy their **price IDs**:
   - Analyst — $99/mo → `STRIPE_PRICE_ANALYST`
   - Team — $499/mo → `STRIPE_PRICE_TEAM`
2. **Developers → API keys**: secret key → `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint**:
   - URL: `https://projectvelocity.org/api/stripe/webhook`
   - Events: `customer.subscription.created`, `.updated`, `.deleted`
   - Signing secret (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

## 3. Configure the Worker

Non-secret vars — edit `wrangler.jsonc` `vars` (or Dashboard → Worker → Settings → Variables):
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STRIPE_PRICE_ANALYST`, `STRIPE_PRICE_TEAM`.

Secrets — run from `site/`:

```bash
npx wrangler@4 secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler@4 secret put SUPABASE_JWT_SECRET
npx wrangler@4 secret put STRIPE_SECRET_KEY
npx wrangler@4 secret put STRIPE_WEBHOOK_SECRET
npx wrangler@4 deploy
```

## 4. Verify

- `https://projectvelocity.org/api/config` → `"configured": true`
- `/login.html` → create account → lands on `/app.html` showing **Analyst · trial · 14 days left**
- Click **Upgrade** → Stripe Checkout → after paying, `/app.html` shows **active**
  (the webhook wrote the tier into Supabase).

## The backend (now wired)

The gated **console + data API** (the FastAPI OSINT backend) runs as a
**Cloudflare Container** — `apps/api/Dockerfile`, configured in `wrangler.jsonc`
(`containers` + `durable_objects` + `migrations`). This Worker proxies `/api/*`
(minus the four gateway routes above), `/tiles/*` and `/ws/*` to one warm
`BackendContainer` instance and stamps `X-Velocity-Tier: paid|free` so the API
serves commercial-legal sources to paying customers. Full steps:
[`../docs/deploy-cloudflare.md`](../docs/deploy-cloudflare.md). Data-source
commercial-licensing audit: [`../docs/commercial-licensing.md`](../docs/commercial-licensing.md).

Requires the **Workers Paid plan** (Containers are paid). Run `npm install` in
`site/` once for `@cloudflare/containers`.
