import type { RuntimeConfig } from '@osint/shared';
import { apiFetch } from './http.js';

// Boot config fetch, resilient to the backend's cold-start window. On a cold
// boot the API lifespan blocks `accept` until its ADS-B snapshot warms (~15-25s),
// so the first requests refuse/fail — the page used to strand on "config error"
// until a manual reload. Retry through the warmup (the caller shows "loading
// config…" meanwhile); only a 4xx (won't self-heal) or exhausting all attempts
// surfaces the error.
// ponytail: fixed 2 s × 15 ≈ 30 s ceiling — bump if the cold start ever runs longer.
export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const ATTEMPTS = 15;
  const DELAY_MS = 2000;
  let lastErr: unknown = new Error('/api/config: no attempt made');
  for (let i = 0; i < ATTEMPTS; i++) {
    let status: number | null = null;
    try {
      const r = await apiFetch('/api/config');
      if (r.ok) return (await r.json()) as RuntimeConfig;
      status = r.status;
      lastErr = new Error(`/api/config failed: ${r.status}`);
    } catch (e) {
      lastErr = e; // network refusal (backend not accepting yet) → retry
    }
    // 4xx won't fix itself (bad route/auth) — fail fast. 5xx / network → retry.
    if (status !== null && status >= 400 && status < 500) break;
    if (i < ATTEMPTS - 1) await new Promise((f) => setTimeout(f, DELAY_MS));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
