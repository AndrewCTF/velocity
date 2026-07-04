// Thin HTTP wrapper that authenticates every backend call. Two credentials are
// supported, in priority order:
//   1. The Supabase access token (Authorization: Bearer …) — the gated backend
//      requires this; it's the "API key you get from Supabase" after sign-in.
//   2. A static VITE_API_KEY (X-API-Key) — legacy/dev fallback.
// When neither is present it behaves like plain fetch (keyless local dev).

import { getAccessToken, getAccessTokenAsync, supabase } from './supabase.js';

function readKey(): string | null {
  // Vite exposes import.meta.env at runtime via the bundler.
  try {
    const k = (import.meta as unknown as { env?: { VITE_API_KEY?: string } }).env
      ?.VITE_API_KEY;
    return k && k.trim() ? k : null;
  } catch {
    return null;
  }
}

const API_KEY = readKey();

function readApiBase(): string | null {
  try {
    const v = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env
      ?.VITE_API_URL;
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

export async function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await bearerToken();
  const resolvedUrl = backendUrl(url);
  if (!token && !API_KEY) return fetch(resolvedUrl, init);
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (API_KEY) headers.set('X-API-Key', API_KEY);
  return fetch(resolvedUrl, { ...init, headers });
}

// For WebSocket URLs, append ?key=… (browsers can't set headers on the upgrade
// request). The backend accepts the Supabase token or the static key via ?key=.
export function withWsKey(url: string): string {
  url = backendWsUrl(url);
  const key = getAccessToken() ?? API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(key)}`;
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
