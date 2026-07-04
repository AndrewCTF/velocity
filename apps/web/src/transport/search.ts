import { apiFetch } from './http.js';

export interface SearchResult {
  kind: 'aircraft' | 'vessel' | 'place' | 'airport' | 'port' | 'chokepoint';
  id: string;
  label: string;
  lon: number;
  lat: number;
  detail?: string;
}

// ── Result-kind badge presentation (shared by SearchField + Omnibar) ──
// One source of truth so both result lists render an identical badge. The
// class strings reuse the app's existing chip vocabulary — the pill base is
// the ExplorerApp/InboxPanel/AlertsRailList chip (`mono text-[10px] uppercase
// tracking-[0.4px] px-1.5 py-0.5 rounded-sm border`) and each tone is an
// existing token pairing already used elsewhere in the tree (accent-dim /
// warn-bg / alert-bg / mag-dim, see CommandBar/NewsPanel/App).

/** Short uppercase glyph shown in the badge, keyed by result kind. */
export const KIND_BADGE_LABEL: Record<SearchResult['kind'], string> = {
  aircraft: 'AIR',
  vessel: 'SHIP',
  place: 'PLACE',
  airport: 'ARPT',
  port: 'PORT',
  chokepoint: 'CHOKE',
};

const BADGE_BASE =
  'mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-0.5 rounded-sm border text-center shrink-0 w-[54px]';

/** Full className for the kind badge — pill base + a subtly-colored tone. */
export const KIND_BADGE_CLASS: Record<SearchResult['kind'], string> = {
  // moving live contacts → cool data tones (blue / green)
  aircraft: `${BADGE_BASE} border-accent-line text-accent bg-accent-dim`,
  vessel: `${BADGE_BASE} border-ok/40 text-ok bg-ok/10`,
  // static locations → distinct warmer / neutral tones so they aren't lost
  airport: `${BADGE_BASE} border-warn/40 text-warn bg-warn-bg`,
  port: `${BADGE_BASE} border-mag-line text-mag bg-mag-dim`,
  place: `${BADGE_BASE} border-line text-txt-2`,
  chokepoint: `${BADGE_BASE} border-alert/40 text-alert bg-alert-bg`,
};

/**
 * Location-only result kinds. These have no live-store entity to select — a
 * click clears the selection and just flies the camera. Aircraft/vessel are
 * the only kinds that resolve to a selectable entity id.
 */
export const LOCATION_KINDS: ReadonlySet<SearchResult['kind']> = new Set<SearchResult['kind']>([
  'place',
  'airport',
  'port',
  'chokepoint',
]);

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
