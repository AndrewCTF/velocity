// Thin HTTP wrapper that authenticates every backend call. Two credentials are
// supported, in priority order:
//   1. The Supabase access token (Authorization: Bearer …) — the gated backend
//      requires this; it's the "API key you get from Supabase" after sign-in.
//   2. A static VITE_API_KEY (X-API-Key) — dev server and desktop build only;
//      a hosted production build refuses to bundle it (buildGuard.ts, V7.2.2).
// When neither is present it behaves like plain fetch (keyless local dev).

import { getAccessToken, getAccessTokenAsync, supabase } from './supabase.js';
import { isMfaRequired, mfaDetail, useMfaNeeded } from '../auth/mfa.js';

// Spelled `import.meta.env` literally: vitest's stubEnv (http.test.ts) only
// rewrites that exact token, not a cast-wrapped `(import.meta).env`.
function readEnv(name: string): string | undefined {
  const v = (import.meta.env as Record<string, string | boolean | undefined> | undefined)?.[name];
  return typeof v === 'string' ? v : undefined;
}

function readKey(): string | null {
  // Vite exposes import.meta.env at runtime via the bundler.
  try {
    const k = readEnv('VITE_API_KEY');
    return k && k.trim() ? k : null;
  } catch {
    return null;
  }
}

const API_KEY = readKey();

function readApiBase(): string | null {
  try {
    const v = readEnv('VITE_API_URL');
    return v && v.trim() ? v.trim().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function isTauriApp(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

export function backendHttpBase(): string {
  const configured = readApiBase();
  if (configured) return configured;
  // ponytail: pin 127.0.0.1 not localhost — WebKitGTK (Tauri) resolves localhost
  // to IPv6 ::1 first and does not fall back; backend on IPv4 only → refused.
  return isTauriApp() ? 'http://127.0.0.1:8000' : '';
}

export function backendUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = backendHttpBase();
  if (!base) return url;
  return url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
}

export function backendWsUrl(url: string): string {
  if (/^wss?:/i.test(url)) return url;
  if (/^https?:/i.test(url)) return url.replace(/^http/i, 'ws');
  const httpBase = backendHttpBase();
  if (httpBase) {
    const wsBase = httpBase.replace(/^http/i, 'ws');
    return url.startsWith('/') ? `${wsBase}${url}` : `${wsBase}/${url}`;
  }
  if (typeof window === 'undefined') return url;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = url.startsWith('/') ? url : `/${url}`;
  return `${proto}//${window.location.host}${path}`;
}

// The cached token is null for the first few calls right after load (the
// session resolves asynchronously) — six authed boot calls otherwise raced the
// bridge and 401'd on first paint. Await getAccessTokenAsync(), which blocks on
// the initial getSession() settling, so EVERY apiFetch carries the Bearer once
// it exists. Logged-out resolves null and the request proceeds keyless.
async function bearerToken(): Promise<string | null> {
  const settled = await getAccessTokenAsync();
  if (settled) return settled;
  if (!supabase) return null;
  // Secondary net: a refresh in flight may have cleared the cache momentarily.
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

// Whether a resolved URL points at this app's own backend (ASVS V10.1.1): a
// path on the page origin, the page origin spelled out, or the configured
// backend base. Anything else is a third party and gets no credential, so a
// variable URL that turns out absolute never carries the session token away.
// Protocol-relative `//host/x` is another host, not a path.
export function isBackendUrl(resolvedUrl: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(resolvedUrl) && !resolvedUrl.startsWith('//')) return true;
  const base = backendHttpBase();
  if (base && (resolvedUrl === base || resolvedUrl.startsWith(`${base}/`))) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(resolvedUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

export async function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const resolvedUrl = backendUrl(url);
  if (!isBackendUrl(resolvedUrl)) return fetch(resolvedUrl, init);
  const token = await bearerToken();
  if (!token && !API_KEY) return fetch(resolvedUrl, init);
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (API_KEY) headers.set('X-API-Key', API_KEY);
  const res = await fetch(resolvedUrl, { ...init, headers });
  if (res.status === 403 && token) noteMfaRequired(res);
  return res;
}

// The backend refuses an aal1 Supabase token on operator routes with a 403 that
// names MFA. Read a CLONE so the caller still owns the body; never throws.
function noteMfaRequired(res: Response): void {
  if (useMfaNeeded.getState().needed) return;
  void res
    .clone()
    .text()
    .then((body) => {
      if (isMfaRequired(res.status, body)) useMfaNeeded.getState().report(mfaDetail(body));
    })
    .catch(() => undefined);
}

// For WebSocket URLs, append ?key=… (browsers can't set headers on the upgrade
// request). The backend accepts the Supabase token or the static key via ?key=.
// WebSocket credential carrier (ASVS V14.2.1). Browsers cannot set headers on
// the upgrade, so the credential rides in Sec-WebSocket-Protocol as
// ["velocity.v1", "key.<credential>"]; the API echoes only velocity.v1
// (apps/api/app/auth.py). That keeps tokens out of URLs, and so out of proxy
// access logs. A credential with characters a subprotocol cannot carry (a
// hand-made API_KEY with = / +) falls back to ?key=, which the API still takes.
const WS_TOKEN_CHARS = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function openAuthedWebSocket(url: string): WebSocket {
  const full = backendWsUrl(url);
  const key = getAccessToken() ?? API_KEY;
  if (!key) return new WebSocket(full);
  if (WS_TOKEN_CHARS.test(key)) return new WebSocket(full, ['velocity.v1', `key.${key}`]);
  const sep = full.includes('?') ? '&' : '?';
  return new WebSocket(`${full}${sep}key=${encodeURIComponent(key)}`);
}

export function hasApiKey(): boolean {
  return API_KEY != null || getAccessToken() != null;
}

// Whether a static VITE_API_KEY is present (independent of any Supabase
// session). AlertSubscriber uses this to decide, once auth has settled, whether
// there's *any* credential to attempt a /ws/alerts upgrade with.
export function hasStaticApiKey(): boolean {
  return API_KEY != null;
}
