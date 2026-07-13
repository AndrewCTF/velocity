import { apiFetch } from '../../transport/http.js';

// Client for `POST /api/geo/event-shapes` — resolves an event point + admin
// level to the REAL admin polygon (GADM-style adm1/adm2), so conflict/incident
// areas shade the actual place instead of an uncertainty circle.
//
// Contract (backend): body {"queries":[{lat,lon,level,iso3}...]} (max 200) →
// {"shapes":[{keys:[key...], id, name, level, iso3, geometry}...],
//  "misses":[key...]}; key = `${iso3}|${level}|${lat.toFixed(3)}|${lon.toFixed(3)}`
// with lat/lon SERVER-rounded to 3 decimals — shapeKey() below builds the
// identical key client-side. geometry = GeoJSON Polygon or MultiPolygon
// (simplified, may contain holes).
//
// Discipline: module-level session cache (misses cached too — never refetched),
// one request in flight at a time, and queued work is SUPERSEDED by a newer
// call (a fresh poll's wants replace a stale queue, they don't pile up).

export type ShapeLevel = 'adm1' | 'adm2';

export interface ShapeQuery {
  lat: number;
  lon: number;
  level: ShapeLevel;
  iso3: string;
}

export interface ShapeGeometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
}

/** Cache sentinel: the server answered and has no shape for this key. */
export const SHAPE_MISS = 'MISS' as const;
type CacheValue = ShapeGeometry | typeof SHAPE_MISS;

const BATCH_MAX = 200;

const cache = new Map<string, CacheValue>();
let inFlight = false;
let queued: { queries: ShapeQuery[]; onApplied: () => void } | null = null;

/** Build the server's cache key for a query (server rounds to 3 decimals). */
export function shapeKey(q: { iso3: string; level: string; lat: number; lon: number }): string {
  return `${q.iso3}|${q.level}|${q.lat.toFixed(3)}|${q.lon.toFixed(3)}`;
}

/** Session cache lookup: geometry, SHAPE_MISS, or undefined (never asked). */
export function cachedShape(key: string): CacheValue | undefined {
  return cache.get(key);
}

/** Test hook: clear the module-level cache + queue state between tests. */
export function resetEventShapeCache(): void {
  cache.clear();
  inFlight = false;
  queued = null;
}

function isRing(r: unknown): r is number[][] {
  return (
    Array.isArray(r) &&
    r.length >= 4 &&
    r.every(
      (p) =>
        Array.isArray(p) &&
        typeof p[0] === 'number' &&
        Number.isFinite(p[0]) &&
        typeof p[1] === 'number' &&
        Number.isFinite(p[1]),
    )
  );
}

/** Structural validation of a server geometry blob; null when malformed. */
export function validShapeGeometry(g: unknown): ShapeGeometry | null {
  if (g == null || typeof g !== 'object') return null;
  const geom = g as { type?: unknown; coordinates?: unknown };
  const c = geom.coordinates;
  if (geom.type === 'Polygon') {
    if (Array.isArray(c) && c.length >= 1 && c.every(isRing)) return geom as ShapeGeometry;
    return null;
  }
  if (geom.type === 'MultiPolygon') {
    if (
      Array.isArray(c) &&
      c.length >= 1 &&
      c.every((part) => Array.isArray(part) && part.length >= 1 && part.every(isRing))
    ) {
      return geom as ShapeGeometry;
    }
    return null;
  }
  return null;
}

/**
 * Resolve shapes for the given queries (already-cached keys are skipped).
 * `onApplied` fires once after the whole call's batches settle so the caller
 * can apply cached results to live entities and request ONE scene render.
 * While a request is in flight, a newer call replaces any queued one.
 */
export function requestEventShapes(queries: ShapeQuery[], onApplied: () => void): void {
  const byKey = new Map<string, ShapeQuery>();
  for (const q of queries) {
    const k = shapeKey(q);
    if (!cache.has(k) && !byKey.has(k)) byKey.set(k, q);
  }
  if (byKey.size === 0) return;
  const qs = [...byKey.values()];
  if (inFlight) {
    queued = { queries: qs, onApplied }; // supersede any older queued work
    return;
  }
  void run(qs, onApplied);
}

async function run(queries: ShapeQuery[], onApplied: () => void): Promise<void> {
  inFlight = true;
  try {
    for (let i = 0; i < queries.length; i += BATCH_MAX) {
      const batch = queries.slice(i, i + BATCH_MAX).filter((q) => !cache.has(shapeKey(q)));
      if (batch.length) await fetchBatch(batch);
    }
  } finally {
    inFlight = false;
  }
  try {
    onApplied();
  } catch {
    /* a caller error must not wedge the queue */
  }
  const next = queued;
  queued = null;
  if (next) requestEventShapes(next.queries, next.onApplied);
}

async function fetchBatch(batch: ShapeQuery[]): Promise<void> {
  try {
    const r = await apiFetch('/api/geo/event-shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: batch.map((q) => ({ lat: q.lat, lon: q.lon, level: q.level, iso3: q.iso3 })),
      }),
    });
    // Transient failure (5xx/429): leave keys uncached so a later poll retries.
    if (!r.ok) return;
    const j = (await r.json()) as {
      shapes?: { keys?: string[]; geometry?: unknown }[];
      misses?: string[];
    };
    for (const s of j.shapes ?? []) {
      // Malformed geometry is cached as a MISS: the circle fallback stays and
      // the key is never refetched this session.
      const geom = validShapeGeometry(s.geometry);
      for (const k of s.keys ?? []) cache.set(k, geom ?? SHAPE_MISS);
    }
    for (const k of j.misses ?? []) cache.set(k, SHAPE_MISS);
    // A queried key the server answered with NEITHER a shape nor a miss is
    // treated as a miss too — guarantees no per-poll refetch loop.
    for (const q of batch) {
      const k = shapeKey(q);
      if (!cache.has(k)) cache.set(k, SHAPE_MISS);
    }
  } catch {
    /* network error: leave uncached; a later poll retries */
  }
}
