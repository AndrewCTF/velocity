import { apiFetch } from './http.js';

export interface SearchResult {
  kind: 'aircraft' | 'vessel' | 'place' | 'chokepoint';
  id: string;
  label: string;
  lon: number;
  lat: number;
  detail?: string;
}

export async function search(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const r = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`, signal ? { signal } : {});
  if (!r.ok) return [];
  const j = (await r.json()) as { results: SearchResult[] };
  return j.results;
}
