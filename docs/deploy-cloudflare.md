# Deploy Velocity on Cloudflare (everything, commercial-legal)

The whole stack runs on Cloudflare:

```
projectvelocity.org ──> Velocity gateway Worker (site/)
                          ├─ static marketing site + /login + /app        (ASSETS)
                          ├─ /api/config /api/me /api/checkout /api/stripe/webhook  (gateway)
                          ├─ /mcp  ──> BackendContainer (agent MCP endpoint, token-gated)
                          └─ /api/*  /tiles/*  /ws/*  ──> BackendContainer (Cloudflare Container)
                                                          = apps/api FastAPI image
```

- **Frontend + gateway + billing**: the Worker in `site/` (auth via Supabase,
  billing via Stripe — see `site/SETUP.md`).
- **Backend**: the FastAPI app (`apps/api`) as a **Cloudflare Container**
  (`apps/api/Dockerfile`), wired in `site/wrangler.jsonc` (`containers` +
  `durable_objects` + `migrations`). The Worker proxies `/api/*` (minus its own
  four routes), `/tiles/*`, and `/ws/*` to one warm instance and stamps
  `X-Velocity-Tier: paid|free` so the API serves commercial-legal sources to
  paying customers. **Requires the Workers Paid plan** (Containers are paid).
- **Commercial-legal data**: `COMMERCIAL_MODE=1` (set in the Dockerfile) →
  adsb.lol / CDSE Sentinel / GDELT+EONET / NWS, with the non-commercial sources
  off. See [`commercial-licensing.md`](./commercial-licensing.md).

## One-time

1. `cd site && npm install` (pulls `@cloudflare/containers` + `wrangler`).
2. `npx wrangler@4 login` (the account that owns `projectvelocity.org`).
3. Complete Supabase + Stripe wiring in `site/SETUP.md` (auth/billing).

## Secrets (run from `site/`, forwarded into the container by the Worker)

```bash
# billing / auth (gateway)
npx wrangler@4 secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler@4 secret put SUPABASE_JWT_SECRET
npx wrangler@4 secret put STRIPE_SECRET_KEY
npx wrangler@4 secret put STRIPE_WEBHOOK_SECRET
# backend data sources (forwarded to the container via BackendContainer.envVars)
npx wrangler@4 secret put CDSE_CLIENT_ID
npx wrangler@4 secret put CDSE_CLIENT_SECRET
npx wrangler@4 secret put FIRMS_MAP_KEY
npx wrangler@4 secret put DEEPSEEK_API_KEY      # optional (news/analysis)
npx wrangler@4 secret put CESIUM_ION_TOKEN      # optional (terrain/3D)
```

Optional commercial-mode vars (in `wrangler.jsonc` `vars`, not secret):
`COMMERCIAL_BASEMAP_URL`, `OVERPASS_URL`, `NOMINATIM_URL` — without them the
basemap/buildings/geocode features degrade (see the audit doc).

**MCP endpoint auth.** The agent endpoint is mounted into the backend at `/mcp`
and proxied by the Worker, which verifies the caller's Velocity (Supabase) token
before forwarding it. For the backend to (a) authorise the in-process tool
self-calls to `/api/intel/*` and (b) independently gate a request that reaches
the container directly (the origin is publicly resolvable), forward two values
into the container via `BackendContainer.envVars`:

```bash
npx wrangler@4 secret put API_KEY              # static key the MCP self-hop presents
npx wrangler@4 secret put SUPABASE_JWT_SECRET  # so the backend verifies user tokens too
```

Without `API_KEY` on the container, `deep_analyze` and the other tools 401
against their own backend once auth is enabled. The Worker path stays gated
regardless via its `verifyJwt` check on `/mcp`.

## Deploy

```bash
cd site
npx wrangler@4 deploy        # builds + pushes apps/api image, deploys Worker + Container
```

`wrangler` builds `../apps/api/Dockerfile` (build context = `apps/api`), pushes it
to the Cloudflare container registry, and provisions the `BackendContainer`
Durable Object. First deploy also runs the `v1` migration.

## Verify

- `https://projectvelocity.org/api/health` (or `/api/intel/situation`) → backend reachable through the proxy.
- `/api/imagery/aoi?before=2025-01-01&after=2025-02-01&lat=...&lon=...` while
  signed in as a paid user → `"commercial": true`, `maxar` empty (CC BY-NC dropped),
  Sentinel offered.
- `/tiles/sat/8/130/90.jpg` (paid) → `X-Sat-Source: cdse-s2` (needs CDSE creds).
- `https://projectvelocity.org/mcp` → an MCP `initialize` + `tools/list`
  handshake returns **22 tools**; a request with no valid token → `401`. Quick
  check: `claude mcp add --transport http osint-geoint https://projectvelocity.org/mcp --header "Authorization: Bearer $TOKEN"` then `claude mcp list`.

## Notes / limits

- One warm backend instance holds the shared snapshot + AIS firehose + warmers;
  the Worker always routes to id `velocity-backend`. `sleepAfter = "30m"` keeps it
  warm between bursts — a cron ping keeps it from cold-starting if traffic is bursty.
- The GPU fusion pipeline (`apps/ml/fusion`) does **not** run on Cloudflare
  (no CUDA containers) — it stays an offline/GPU-host research pipeline.
- `instance_type` is `standard-1`; raise it in `wrangler.jsonc` if the snapshot +
  imagery processing needs more memory/CPU.
