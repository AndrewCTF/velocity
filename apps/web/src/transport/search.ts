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

// ── Faceted object search (Gotham "Search for Objects", /api/search/objects) ──
export interface ObjectResult {
  kind: string;
  id: string;
  label: string;
  lon: number;
  lat: number;
  t: number;
  source: string;
}

export interface ObjectSearch {
  results: ObjectResult[];
  count: number;
  by_type: Record<string, number>;
}

export interface ObjectFacets {
  type?: string; // 'all' | 'aircraft' | 'vessel' | 'quake' | …
  q?: string;
  /** Drawn-AOI bounding box [minLon, minLat, maxLon, maxLat]. */
  bbox?: [number, number, number, number];
  /** Rolling window in seconds (o.t >= now - sinceS). */
  sinceS?: number;
  limit?: number;
}

export async function searchObjects(
  f: ObjectFacets,
  signal?: AbortSignal,
): Promise<ObjectSearch> {
  const p = new URLSearchParams();
  if (f.type && f.type !== 'all') p.set('type', f.type);
  if (f.q && f.q.trim()) p.set('q', f.q.trim());
  if (f.bbox) {
    p.set('min_lon', String(f.bbox[0]));
    p.set('min_lat', String(f.bbox[1]));
    p.set('max_lon', String(f.bbox[2]));
    p.set('max_lat', String(f.bbox[3]));
  }
  if (f.sinceS != null) p.set('since_s', String(Math.round(f.sinceS)));
  if (f.limit != null) p.set('limit', String(f.limit));
  const r = await apiFetch(`/api/search/objects?${p.toString()}`, signal ? { signal } : {});
  if (!r.ok) return { results: [], count: 0, by_type: {} };
  return (await r.json()) as ObjectSearch;
}
