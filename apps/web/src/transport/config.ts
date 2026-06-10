import type { RuntimeConfig } from '@osint/shared';
import { apiFetch } from './http.js';

export async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  const r = await apiFetch('/api/config');
  if (!r.ok) throw new Error(`/api/config failed: ${r.status}`);
  return (await r.json()) as RuntimeConfig;
}
