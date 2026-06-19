// Thin HTTP wrapper that authenticates every backend call. Two credentials are
// supported, in priority order:
//   1. The Supabase access token (Authorization: Bearer …) — the gated backend
//      requires this; it's the "API key you get from Supabase" after sign-in.
//   2. A static VITE_API_KEY (X-API-Key) — legacy/dev fallback.
// When neither is present it behaves like plain fetch (keyless local dev).

import { getAccessToken, supabase } from './supabase.js';

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

// The cached token may be null for the first few calls right after load (the
// session resolves asynchronously). Fall back to an awaited getSession() so the
// very first authed request doesn't 401 before the cache warms.
async function bearerToken(): Promise<string | null> {
  const cached = getAccessToken();
  if (cached) return cached;
  if (!supabase) return null;
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
  if (!token && !API_KEY) return fetch(url, init);
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (API_KEY) headers.set('X-API-Key', API_KEY);
  return fetch(url, { ...init, headers });
}

// For WebSocket URLs, append ?key=… (browsers can't set headers on the upgrade
// request). The backend accepts the Supabase token or the static key via ?key=.
export function withWsKey(url: string): string {
  const key = getAccessToken() ?? API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(key)}`;
}

export function hasApiKey(): boolean {
  return API_KEY != null || getAccessToken() != null;
}
