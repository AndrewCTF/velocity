// Supabase browser client — the single source of the auth session.
//
// Reads the project URL + publishable key from Vite env (inlined at build
// time, like VITE_API_KEY in http.ts). The publishable key is safe to ship in
// the bundle; it is NOT the service_role/secret key. Row-level security on the
// server is what actually guards data — never put a secret key here.
//
// If the env vars are absent the client is null and auth is simply disabled —
// the globe and every keyless layer keep working (a hard throw here would
// white-screen the whole SPA, violating the "core layers work without a key"
// guarantee). The /login + /signup pages surface the misconfiguration instead.
//
// `persistSession` keeps the session in localStorage so a reload stays logged
// in; `autoRefreshToken` rotates the JWT before it expires. Both set explicitly
// so a future supabase-js default change can't silently flip them.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function readEnv(name: string): string | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env?.[name];
  } catch {
    return undefined;
  }
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

if (supabase) {
  supabase.auth.onAuthStateChange((_event, session) => {
    _accessToken = session?.access_token ?? null;
  });
  void (async () => {
    // Bridge a session created by the marketing /login page (which stores raw
    // tokens in localStorage) into this supabase-js client, so a user who
    // signed in there lands in the console already authenticated instead of
    // hitting a second login. Harmless if there's already a session.
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        const at = localStorage.getItem('vel_tok');
        const rt = localStorage.getItem('vel_refresh');
        if (at && rt) {
          await supabase.auth.setSession({ access_token: at, refresh_token: rt });
        }
      }
    } catch {
      /* no session / storage blocked → stay signed out */
    }
    try {
      const { data } = await supabase.auth.getSession();
      _accessToken = data.session?.access_token ?? null;
    } catch {
      /* ignore */
    }
  })();
}
