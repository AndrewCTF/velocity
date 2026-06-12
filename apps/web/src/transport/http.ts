// Thin HTTP wrapper that attaches X-API-Key on every request when the build
// or the environment supplies one. Backwards-compatible — when no key is set,
// behaves like plain fetch.
//
// The key is read once at module load. In dev it comes from VITE_API_KEY;
// in production it's expected to be set in the same way (Vite inlines env
// vars prefixed with VITE_ into the bundle).

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

export async function apiFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (API_KEY) {
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', API_KEY);
    return fetch(url, { ...init, headers });
  }
  return fetch(url, init);
}

// For WebSocket URLs, append ?key=… (since you can't set headers on the
// upgrade request in browsers).
export function withWsKey(url: string): string {
  if (!API_KEY) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(API_KEY)}`;
}

export function hasApiKey(): boolean {
  return API_KEY != null;
}
