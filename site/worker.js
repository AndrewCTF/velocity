/* ============================================================================
   Velocity — Cloudflare Worker access gateway
   - Serves the marketing site (ASSETS binding) for public routes
   - Gates /app behind a Supabase session + paid tier
   - /api/config  : public Supabase URL + anon key + price ids (for the pages)
   - /api/me      : verify Supabase JWT → return user + effective tier + limits
   - /api/checkout: create a Stripe Checkout session for a tier
   - /api/stripe/webhook : Stripe events → write tier into Supabase (service role)
   Secrets (wrangler secret put): SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
     STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
   Vars (wrangler.jsonc): SUPABASE_URL, SUPABASE_ANON_KEY, STRIPE_PRICE_ANALYST,
     STRIPE_PRICE_TEAM, APP_URL
   ============================================================================ */

const enc = new TextEncoder();
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// ============================================================================
// Backend origin — the FastAPI OSINT API (apps/api). Runs on a host reachable
// at env.BACKEND_URL (a VPS during the beta; swap to the TLS domain once DNS +
// Caddy are up). The browser only ever talks to this Worker over HTTPS; the
// Worker→origin hop is server-side. The backend independently verifies the
// caller's Supabase access token, so the forwarded Authorization header is
// what gates it; X-Velocity-Tier selects commercial-legal vs NC sources.
// ============================================================================

// Proxy a request to the backend origin, forwarding method/headers (incl. the
// Supabase Bearer token) and body, and stamping the caller's commercial tier.
function proxyToBackend(request, env, tier) {
  const src = new URL(request.url);
  const target = env.BACKEND_URL.replace(/\/$/, "") + src.pathname + src.search;
  const req = new Request(target, request);
  req.headers.set("X-Velocity-Tier", tier);
  return fetch(req);
}

// ---- effective commercial tier, isolate-cached (avoid a Supabase hit per poll) ----
const _tierCache = new Map(); // sub -> { tier, exp }
async function deriveTier(request, env) {
  const tok = bearer(request);
  if (!tok) return "free";
  const claims = await verifyJwt(tok, env);
  if (!claims) return "free";
  const hit = _tierCache.get(claims.sub);
  if (hit && hit.exp > Date.now()) return hit.tier;
  let eff = "none";
  try {
    const r = await sbAsUser(env, `subscriptions?user_id=eq.${claims.sub}&select=tier,status,trial_ends_at`, tok);
    eff = effective((await r.json())[0] || null);
  } catch {}
  // Paying/trialing customers are commercial users → commercial-legal sources.
  const tier = eff === "none" ? "free" : "paid";
  _tierCache.set(claims.sub, { tier, exp: Date.now() + 60_000 });
  return tier;
}

// ---- base64url ----
function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
const b64urlStr = (s) => new TextDecoder().decode(b64urlBytes(s));

// ---- HMAC helpers (Web Crypto) ----
async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}
async function hmacHex(secret, msg) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- verify a Supabase access token ----
// This project signs access tokens with ES256 (asymmetric JWT signing keys), so
// we verify against the project's published JWKS rather than a shared HS256
// secret. The imported keys are cached per isolate (re-fetched on an unknown
// kid, i.e. key rotation). HS256 is still honoured if a legacy secret is set.
let _jwksKeys = null; // Map<kid, CryptoKey>
let _jwksAt = 0;
async function getJwkKey(env, kid) {
  if (_jwksKeys && _jwksKeys.has(kid)) return _jwksKeys.get(kid);
  if (_jwksKeys && Date.now() - _jwksAt < 30_000) return null; // throttle refetch
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, {
      headers: { apikey: env.SUPABASE_ANON_KEY },
    });
    const { keys } = await r.json();
    const m = new Map();
    for (const j of keys || []) {
      if (j.kty !== "EC") continue;
      m.set(
        j.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "EC", crv: j.crv, x: j.x, y: j.y },
          { name: "ECDSA", namedCurve: j.crv },
          false,
          ["verify"],
        ),
      );
    }
    _jwksKeys = m;
    _jwksAt = Date.now();
  } catch {
    /* leave previous cache in place */
  }
  return _jwksKeys ? _jwksKeys.get(kid) || null : null;
}

async function verifyJwt(token, env) {
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return null;
    const header = JSON.parse(b64urlStr(h));
    const payload = JSON.parse(b64urlStr(p));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    // Only a genuine signed-in USER session is a valid credential. The public
    // anon/publishable key and service-role tokens are validly signed JWTs too,
    // so without this an anon token would authenticate once a legacy HS256
    // secret is configured. Require the authenticated role + a subject (and the
    // project's own issuer) before trusting any branch below.
    if (payload.role !== "authenticated" || !payload.sub) return null;
    if (payload.iss && payload.iss !== `${env.SUPABASE_URL}/auth/v1`) return null;
    if (header.alg === "ES256") {
      const key = await getJwkKey(env, header.kid);
      if (!key) return null;
      const ok = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        b64urlBytes(sig),
        enc.encode(h + "." + p),
      );
      return ok ? payload : null;
    }
    if (header.alg === "HS256" && env.SUPABASE_JWT_SECRET) {
      const ok = await crypto.subtle.verify(
        "HMAC",
        await hmacKey(env.SUPABASE_JWT_SECRET, ["verify"]),
        b64urlBytes(sig),
        enc.encode(h + "." + p),
      );
      return ok ? payload : null;
    }
    return null;
  } catch {
    return null;
  }
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// ---- Supabase REST (service role; bypasses RLS) ----
// Only for privileged WRITES (the Stripe webhook). Requires SUPABASE_SERVICE_ROLE_KEY.
async function sb(env, path, init = {}) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

// ---- Supabase REST as the calling user (RLS-scoped reads) ----
// The "own subscription" / "read tier limits" RLS policies let a signed-in user
// read their own row with their own token, so tier lookups need NO service_role
// key. Pass the caller's access token.
async function sbAsUser(env, path, userToken) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${userToken}`,
      "content-type": "application/json",
    },
  });
}

function priceToTier(env, priceId) {
  if (priceId && priceId === env.STRIPE_PRICE_ANALYST) return "analyst";
  if (priceId && priceId === env.STRIPE_PRICE_TEAM) return "team";
  return "none";
}
function tierToPrice(env, tier) {
  return tier === "analyst" ? env.STRIPE_PRICE_ANALYST : tier === "team" ? env.STRIPE_PRICE_TEAM : null;
}
const mapStatus = (s) =>
  s === "active" || s === "trialing" ? s : s === "past_due" ? "past_due" : "canceled";

// ---- effective tier (trial-aware) ----
function effective(sub) {
  if (!sub) return "none";
  if (sub.status === "canceled") return "none";
  if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) return "none";
  return sub.tier || "none";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---------- public config ----------
    // Superset of two shapes on one path: the marketing/login pages need the
    // Supabase + Stripe fields; the apps/web console needs the backend's
    // RuntimeConfig (cesiumIonToken, features.enableGoogle3D, …). Merge the
    // backend's /api/config (public, no auth) so both consumers are satisfied.
    if (path === "/api/config") {
      // Login depends on this route, so a slow/down backend must NEVER hang it:
      // bounded fetch + defaults guarantee `configured` and the console's
      // RuntimeConfig shape (features.enableGoogle3D, …) are always present.
      let backendCfg = {};
      if (env.BACKEND_URL) {
        try {
          const r = await fetch(`${env.BACKEND_URL.replace(/\/$/, "")}/api/config`, {
            signal: AbortSignal.timeout(2500),
          });
          if (r.ok) backendCfg = await r.json();
        } catch {
          /* slow/unreachable backend → fall back to defaults below */
        }
      }
      const defaults = {
        cesiumIonToken: "",
        googleApiKey: "",
        features: { enableGoogle3D: false },
        classification: "UNCLAS",
        buildId: "prod",
      };
      return json({
        ...defaults,
        ...backendCfg,
        supabaseUrl: env.SUPABASE_URL || "",
        supabaseAnonKey: env.SUPABASE_ANON_KEY || "",
        configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        prices: { analyst: env.STRIPE_PRICE_ANALYST || "", team: env.STRIPE_PRICE_TEAM || "" },
      });
    }

    // ---------- who am I + what tier ----------
    if (path === "/api/me") {
      const tok = bearer(request);
      const claims = tok ? await verifyJwt(tok, env) : null;
      if (!claims) return json({ error: "unauthenticated" }, 401);
      let sub = null,
        limits = null;
      try {
        const r = await sbAsUser(env, `subscriptions?user_id=eq.${claims.sub}&select=tier,status,trial_ends_at,current_period_end`, tok);
        sub = (await r.json())[0] || null;
        const tier = effective(sub);
        const lr = await sbAsUser(env, `tier_limits?tier=eq.${tier}&select=*`, tok);
        limits = (await lr.json())[0] || null;
        return json({
          email: claims.email,
          tier,
          status: sub?.status || "none",
          trial_ends_at: sub?.trial_ends_at || null,
          current_period_end: sub?.current_period_end || null,
          limits,
        });
      } catch (e) {
        return json({ error: "backend", detail: String(e) }, 502);
      }
    }

    // ---------- start a Stripe Checkout for a tier ----------
    if (path === "/api/checkout" && request.method === "POST") {
      const tok = bearer(request);
      const claims = tok ? await verifyJwt(tok, env) : null;
      if (!claims) return json({ error: "unauthenticated" }, 401);
      if (!env.STRIPE_SECRET_KEY) return json({ error: "billing not configured" }, 503);
      let tier = "analyst";
      try {
        tier = (await request.json()).tier || "analyst";
      } catch {}
      const price = tierToPrice(env, tier);
      if (!price) return json({ error: "unknown tier" }, 400);

      const body = new URLSearchParams();
      body.set("mode", "subscription");
      body.set("line_items[0][price]", price);
      body.set("line_items[0][quantity]", "1");
      body.set("success_url", `${env.APP_URL}/account?checkout=success`);
      body.set("cancel_url", `${env.APP_URL}/account?checkout=cancel`);
      body.set("client_reference_id", claims.sub);
      if (claims.email) body.set("customer_email", claims.email);
      body.set("subscription_data[metadata][user_id]", claims.sub);

      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await r.json();
      if (!r.ok) return json({ error: "stripe", detail: data?.error?.message }, 502);
      return json({ url: data.url });
    }

    // ---------- Stripe webhook → write tier into Supabase ----------
    if (path === "/api/stripe/webhook" && request.method === "POST") {
      const raw = await request.text();
      const sigHeader = request.headers.get("stripe-signature") || "";
      const parts = Object.fromEntries(sigHeader.split(",").map((kv) => kv.split("=")));
      if (!env.STRIPE_WEBHOOK_SECRET || !parts.t || !parts.v1) return json({ error: "bad signature" }, 400);
      const expected = await hmacHex(env.STRIPE_WEBHOOK_SECRET, `${parts.t}.${raw}`);
      if (!timingEq(expected, parts.v1)) return json({ error: "bad signature" }, 400);

      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return json({ error: "bad json" }, 400);
      }

      if (event.type?.startsWith("customer.subscription.")) {
        const o = event.data.object;
        const uid = o.metadata?.user_id;
        if (uid) {
          const deleted = event.type === "customer.subscription.deleted";
          const priceId = o.items?.data?.[0]?.price?.id;
          const row = {
            user_id: uid,
            tier: deleted ? "none" : priceToTier(env, priceId),
            status: deleted ? "canceled" : mapStatus(o.status),
            stripe_customer_id: o.customer,
            stripe_subscription_id: o.id,
            current_period_end: o.current_period_end ? new Date(o.current_period_end * 1000).toISOString() : null,
            updated_at: new Date().toISOString(),
          };
          await sb(env, "subscriptions", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: JSON.stringify(row),
          });
        }
      }
      return json({ received: true });
    }

    // ---------- agent endpoint: MCP over streamable-HTTP ----------
    // The hosted "MCP agent endpoint (your token)": an AI agent points its MCP
    // client at https://<host>/mcp and presents its Velocity (Supabase) access
    // token as a Bearer. We require a valid signed-in user HERE (defence in
    // depth on top of the backend's own token check), then forward the request
    // and stream the streamable-HTTP/SSE response straight back. fetch() streams
    // the body and preserves the Mcp-Session-Id response header. Native MCP
    // clients (Claude Code / Desktop / Agent SDK) don't send a CORS preflight,
    // so no OPTIONS handling is needed. To restrict MCP to paying customers,
    // swap the verifyJwt gate below for `(await deriveTier(request, env)) === "paid"`.
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      if (!env.BACKEND_URL) return json({ error: "backend not configured" }, 503);
      const claims = await verifyJwt(bearer(request) || "", env);
      if (!claims)
        return json(
          {
            error: "unauthenticated",
            detail:
              "The MCP endpoint needs a Velocity access token: Authorization: Bearer <token>.",
          },
          401,
        );
      return proxyToBackend(request, env, "free");
    }

    // ---------- proxy the live OSINT API/tiles/ws to the backend container ----------
    // The gateway owns the four /api/* routes above; everything else under
    // /api/, plus /tiles/ and /ws/, is the FastAPI backend. Stamp the tier so
    // the API serves commercial-legal sources to paying customers and the
    // (non-commercial) firehoses to free sessions.
    if (
      path.startsWith("/api/") ||
      path.startsWith("/tiles/") ||
      path.startsWith("/ws/")
    ) {
      if (!env.BACKEND_URL) return json({ error: "backend not configured" }, 503);
      // Beta: serve the full keyless (non-commercial) source set to everyone —
      // OpenSky/airplanes.live aircraft, Carto dark basemap, etc. The "paid"
      // tier forces the thinner commercial-legal set (and a basemap that needs
      // COMMERCIAL_BASEMAP_URL → 503 → bare blue globe), so stamp "free" until
      // GA. Restore `await deriveTier(request, env)` to re-enable tier gating.
      const tier = "free";
      return proxyToBackend(request, env, tier);
    }

    // ---------- console SPA (apps/web) under /app ----------
    // Static files (/app/assets/*, /app/cesium/*) serve directly; client-side
    // routes (/app, /app/2d, …) fall back to the SPA shell.
    if (path === "/app" || path.startsWith("/app/")) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      return env.ASSETS.fetch(new Request(new URL("/app/index.html", request.url), request));
    }

    // ---------- everything else → static marketing site ----------
    // Assets auto-maps clean URLs (/login → login.html, /account → account.html).
    return env.ASSETS.fetch(request);
  },
};
