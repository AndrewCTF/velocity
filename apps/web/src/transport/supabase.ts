// Supabase browser client — the single source of the auth session.
//
// Reads the project URL + publishable key from Vite env (inlined at build
// time). The publishable key is safe to ship in the bundle; it is NOT the
// service_role/secret key. Row-level security on the server is what actually
// guards data — never put a secret key here.
//
// If the env vars are absent the client is null and auth is simply disabled —
// the globe and every keyless layer keep working (a hard throw here would
// white-screen the whole SPA, violating the "core layers work without a key"
// guarantee). The /login + /signup pages surface the misconfiguration instead.
//
// `persistSession` keeps the session in localStorage so a reload stays logged
// in; `autoRefreshToken` rotates the JWT before it expires. Both set explicitly
// so a future supabase-js default change can't silently flip them.
//
// `flowType: 'pkce'` (ASVS V10.1.2 / V10.2.1 / V7.6.2): email confirmation and
// password-recovery links return a one-time `?code=`, and detectSessionInUrl
// exchanges it with the code_verifier this browser stored when it asked for the
// link. The implicit flow instead accepted access tokens from any URL fragment,
// so a crafted link could sign a victim into an attacker's account. Trade-off:
// a link opened in a different browser than the one that requested it cannot
// be exchanged; AuthForm's /reset says so.
//
// ACCEPTED RISK (ASVS V10.1.1, 2026-09): supabase-js keeps the access and
// refresh tokens in localStorage by design, where an XSS could read them. The
// mitigation is the build CSP (apps/web/csp.ts: no inline script, no eval,
// object-src 'none'), plus short JWT expiry, the idle sign-out
// (auth/useIdleSignOut.ts) and MFA for operator routes. A backend-for-frontend
// with an httpOnly cookie was considered and not built.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function readEnv(name: string): string | undefined {
  // Spelled `import.meta.env` literally: vitest's stubEnv (supabase.test.ts)
  // only rewrites that exact token, not a cast-wrapped `(import.meta).env`.
  const v = (import.meta.env as Record<string, string | boolean | undefined>)[name];
  return typeof v === 'string' ? v : undefined;
}

const URL = readEnv('VITE_SUPABASE_URL');
const ANON = readEnv('VITE_SUPABASE_ANON_KEY');

export const isSupabaseConfigured = Boolean(URL && ANON);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(URL as string, ANON as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  : null;

// ── access token for the API layer ──────────────────────────────────────────
// The gated backend requires the Supabase access token (Authorization: Bearer).
// Cache it here so the hot apiFetch path / WS upgrade can read it synchronously,
// and keep it fresh via onAuthStateChange (covers sign-in, sign-out, refresh).
let _accessToken: string | null = null;

export function getAccessToken(): string | null {
  return _accessToken;
}

// Resolves once the initial getSession() bridge below has settled, so callers
// can await a populated `_accessToken` instead of racing the async boot (the
// first apiFetch / WS upgrade otherwise fired before the Bearer was attached →
// a 401 on first paint). Resolves immediately when auth is unconfigured.
let _resolveTokenReady: () => void = () => {};
export const tokenReady: Promise<void> = new Promise((resolve) => {
  _resolveTokenReady = resolve;
});

// Await the initial session, then read the current token (kept fresh by
// onAuthStateChange). Logged-out / unconfigured resolves null and the caller
// proceeds keyless.
export async function getAccessTokenAsync(): Promise<string | null> {
  await tokenReady;
  return _accessToken;
}

// Keys a retired marketing /login page wrote raw tokens under. This client used
// to adopt them with setSession() on load, which created a session with no user
// action and no PKCE binding (ASVS V7.6.2), and signOut never removed them
// (V7.4.1). Nothing writes them any more; clear any leftovers on load and on
// every sign-out.
export const LEGACY_TOKEN_KEYS = ['vel_tok', 'vel_refresh'] as const;

export function clearLegacyTokens(): void {
  try {
    for (const k of LEGACY_TOKEN_KEYS) localStorage.removeItem(k);
  } catch {
    /* storage blocked → nothing to clear */
  }
}

clearLegacyTokens();

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    _accessToken = session?.access_token ?? null;
    if (event === 'SIGNED_OUT') clearLegacyTokens();
  });
  // Watchdog: a hung getSession() — possible under a dead/slow network, since
  // auth-js serializes it behind navigator.locks with no timeout (and on a PKCE
  // callback it also waits on the code exchange) — must never leave tokenReady
  // unresolved. That would hang EVERY apiFetch, including the keyless globe
  // poll (violating "core layers work without a key"). try/finally can't bound
  // a hang, so resolve after 4 s regardless; onAuthStateChange still populates
  // _accessToken if the session settles afterwards.
  const watchdog = setTimeout(() => _resolveTokenReady(), 4000);
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      _accessToken = data.session?.access_token ?? null;
    } catch {
      /* no session / storage blocked → stay signed out */
    } finally {
      clearTimeout(watchdog);
      _resolveTokenReady();
    }
  })();
} else {
  // Auth unconfigured: nothing to settle — unblock awaiters immediately so
  // keyless calls don't hang on tokenReady.
  _resolveTokenReady();
}
