import type { RuntimeConfig } from '@osint/shared';
import { apiFetch } from './http.js';

// Boot config fetch, resilient to the backend's cold-start window. On a cold
// boot the API lifespan blocks `accept` until its ADS-B snapshot warms — and
// through the Vite proxy a not-yet-accepting backend answers 500, not a
// refusal. A fixed attempt ceiling lost that race (measured 2026-08-08: accept
// came ~35 s after page load, the old 15 × 2 s ceiling gave up at ~29 s and the
// page stranded on "config error" until a manual reload). 5xx / network
// failures are exactly the ones a backend boot self-heals, so retry those
// FOREVER (the map renders on keyless defaults meanwhile, with a "connecting to
// backend…" label, and upgrades in place when this resolves); only a 4xx (bad
// route/auth — won't self-heal) fails fast.
let latest: RuntimeConfig | null = null;

/** What a caller the backend will not give keys to boots with: every keyed layer off. */
export const KEYLESS_CONFIG: RuntimeConfig = {
  cesiumIonToken: '',
  googleApiKey: '',
  features: { enableGoogle3D: false },
  classification: 'UNCLAS',
  buildId: '',
};

/** The last config the backend returned, for readers that must not refetch it. */
export function latestRuntimeConfig(): RuntimeConfig | null {
  return latest;
}

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const DELAY_MS = 2000;
  for (;;) {
    let r: Response | null = null;
    try {
      // Per-attempt timeout: a queued (not refused) connection would otherwise
      // hang one attempt indefinitely and stall the whole loop.
      r = await apiFetch('/api/config', { signal: AbortSignal.timeout(4000) });
    } catch {
      // network refusal / timeout (backend not accepting yet) → retry
    }
    if (r?.ok) {
      latest = (await r.json()) as RuntimeConfig;
      return latest;
    }
    // Signed out on an auth-gated deployment: the backend may refuse the keyed
    // config to an anonymous caller. The globe still boots keyless; App
    // refetches on sign-in and the keys arrive then.
    if (r && (r.status === 401 || r.status === 403)) {
      latest = KEYLESS_CONFIG;
      return KEYLESS_CONFIG;
    }
    // Any other 4xx won't fix itself — surface it. 5xx (incl. proxy 500/502) → retry.
    if (r && r.status >= 400 && r.status < 500)
      throw new Error(`Configuration unavailable (HTTP ${r.status})`);
    await new Promise((f) => setTimeout(f, DELAY_MS));
  }
}
