// ── Faceted classification (pure) ──────────────────────────────────────────
//
// Maps a feature's raw properties to the facet bucket id(s) it belongs in —
// altitude band, aircraft category, vessel type, flag (derived client-side),
// squawk. Extracted out of HistogramPanel so BOTH the panel and the shared
// entity-stats sampler (globe/entityStats.ts) classify with one source of
// truth, with no React or store-subscription dependency (keeps this importable
// from the globe layer without an import cycle).
//
// The renderer's `aircraftStyle`/`vesselStyle` classifiers are reused here so a
// bar labelled "military" filters exactly the icons drawn as military.

import {
  matchesFilterClauses,
  type FilterClause,
  type FilterFacet,
  type FacetResolver,
} from '../state/stores.js';
import { aircraftStyle, vesselStyle } from '../globe/adapters/styles.js';

// Altitude bands (metres). Aviation-flavoured but expressed in the metric the
// feed carries (`baro_alt_m`/`geo_alt_m`). Ground + unknown are their own
// buckets so a parked fleet doesn't smear across the low band.
export interface AltBand {
  id: string;
  label: string;
  // inclusive lo, exclusive hi (metres). null hi = open top.
  lo: number;
  hi: number | null;
}
export const ALT_BANDS: readonly AltBand[] = [
  { id: 'fl000_010', label: '0–1 km', lo: 0, hi: 1_000 },
  { id: 'fl010_030', label: '1–3 km', lo: 1_000, hi: 3_000 },
  { id: 'fl030_080', label: '3–8 km', lo: 3_000, hi: 8_000 },
  { id: 'fl080_120', label: '8–12 km', lo: 8_000, hi: 12_000 },
  { id: 'fl120_up', label: '12 km+', lo: 12_000, hi: null },
];
const ALT_GROUND = 'ground';
const ALT_UNKNOWN = 'alt_unknown';

function altBucketId(props: Record<string, unknown>): string {
  if (props['on_ground'] === true) return ALT_GROUND;
  const alt =
    (typeof props['geo_alt_m'] === 'number' ? (props['geo_alt_m'] as number) : null) ??
    (typeof props['baro_alt_m'] === 'number' ? (props['baro_alt_m'] as number) : null) ??
    (typeof props['alt'] === 'number' ? (props['alt'] as number) : null);
  if (alt == null || !Number.isFinite(alt)) return ALT_UNKNOWN;
  for (const b of ALT_BANDS) {
    if (alt >= b.lo && (b.hi == null || alt < b.hi)) return b.id;
  }
  return ALT_UNKNOWN;
}

// Squawk: the literal Mode-A code, plus a synthetic 'emergency' bucket so the
// 7500/7600/7700 codes roll up into one clickable "emergencies" slice as well
// as showing individually.
const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']);
function squawkValues(props: Record<string, unknown>): string[] {
  const raw = props['squawk'];
  if (raw == null || raw === '') return [];
  const code = String(raw);
  return EMERGENCY_SQUAWKS.has(code) ? [code, 'emergency'] : [code];
}

// Flag / country, derived CLIENT-SIDE — the feeds do NOT send a flag field, so
// we honestly derive it from the identity that IS present: an aircraft's
// ICAO24 24-bit address block (ITU country allocation) and a vessel's MMSI MID
// (first 3 digits → Maritime Identification Digit country). Coarse by design;
// a small high-traffic table + an "other" fallback, never a fabricated value.
const ICAO24_BLOCKS: ReadonlyArray<{ lo: number; hi: number; cc: string }> = [
  // A small, high-traffic subset of ICAO Annex 10 24-bit address allocations.
  { lo: 0xa00000, hi: 0xafffff, cc: 'US' },
  { lo: 0x400000, hi: 0x43ffff, cc: 'GB' },
  { lo: 0x3c0000, hi: 0x3fffff, cc: 'DE' },
  { lo: 0x380000, hi: 0x3bffff, cc: 'FR' },
  { lo: 0x300000, hi: 0x33ffff, cc: 'IT' },
  { lo: 0x340000, hi: 0x37ffff, cc: 'ES' },
  { lo: 0x480000, hi: 0x4bffff, cc: 'NL' },
  { lo: 0x140000, hi: 0x1bffff, cc: 'RU' },
  { lo: 0x780000, hi: 0x7bffff, cc: 'CN' },
  { lo: 0x840000, hi: 0x87ffff, cc: 'JP' },
  { lo: 0x7c0000, hi: 0x7fffff, cc: 'AU' },
  { lo: 0xc00000, hi: 0xc3ffff, cc: 'CA' },
  { lo: 0xe00000, hi: 0xe3ffff, cc: 'AR' },
  { lo: 0x0a0000, hi: 0x0affff, cc: 'EG' },
  { lo: 0x440000, hi: 0x447fff, cc: 'AT' },
  { lo: 0x460000, hi: 0x467fff, cc: 'FI' },
  { lo: 0x468000, hi: 0x46ffff, cc: 'GR' },
  { lo: 0x4a0000, hi: 0x4a7fff, cc: 'SE' },
  { lo: 0x4b0000, hi: 0x4b7fff, cc: 'CH' },
  { lo: 0x500000, hi: 0x5003ff, cc: 'PL' },
  { lo: 0x710000, hi: 0x717fff, cc: 'SA' },
  { lo: 0x738000, hi: 0x73ffff, cc: 'IL' },
  { lo: 0x896000, hi: 0x896fff, cc: 'AE' },
  { lo: 0x800000, hi: 0x83ffff, cc: 'IN' },
  { lo: 0x88_0000, hi: 0x887fff, cc: 'TR' },
];
function flagFromIcao24(icao24: string): string | null {
  const n = Number.parseInt(icao24, 16);
  if (!Number.isFinite(n)) return null;
  for (const b of ICAO24_BLOCKS) {
    if (n >= b.lo && n <= b.hi) return b.cc;
  }
  return 'other';
}

// MMSI MID (first three digits) → flag. Subset of ITU-R M.585 Table 1, the
// busiest maritime flags; everything else collapses to 'other'.
const MID_TO_CC: Readonly<Record<string, string>> = {
  '201': 'AL', '205': 'BE', '209': 'CY', '211': 'DE', '219': 'DK',
  '224': 'ES', '226': 'FR', '227': 'FR', '228': 'FR', '230': 'FI',
  '232': 'GB', '233': 'GB', '234': 'GB', '235': 'GB', '236': 'GI',
  '237': 'GR', '238': 'HR', '244': 'NL', '245': 'NL', '246': 'NL',
  '247': 'IT', '248': 'MT', '249': 'MT', '256': 'MT', '257': 'NO',
  '258': 'NO', '259': 'NO', '265': 'SE', '266': 'SE', '269': 'CH',
  '273': 'RU', '304': 'AG', '305': 'AG', '309': 'BS', '311': 'BS',
  '338': 'US', '366': 'US', '367': 'US', '368': 'US', '369': 'US',
  '316': 'CA', '370': 'PA', '371': 'PA', '372': 'PA', '373': 'PA',
  '412': 'CN', '413': 'CN', '414': 'CN', '431': 'JP', '432': 'JP',
  '440': 'KR', '441': 'KR', '477': 'HK', '563': 'SG', '564': 'SG',
  '565': 'SG', '538': 'MH', '525': 'ID', '574': 'VN', '636': 'LR',
  '710': 'BR', '512': 'NZ', '503': 'AU', '423': 'AZ', '422': 'IR',
  '470': 'AE', '403': 'SA',
};
function flagFromMmsi(mmsi: string | number): string | null {
  const s = String(mmsi);
  if (s.length < 3) return null;
  return MID_TO_CC[s.slice(0, 3)] ?? 'other';
}

// The full set of facet values an entity carries. `kind` (aircraft/vessel) is
// read from the same `kind` property the feeds stamp; category/type reuse the
// SAME classifiers the renderer uses (`aircraftStyle`/`vesselStyle`), so a bar
// labelled "military" filters exactly the icons drawn as military.
export interface EntityFacets {
  kind: 'aircraft' | 'vessel' | 'other';
  altBucket: string | null;
  aircraftCategory: string | null;
  vesselType: string | null;
  flag: string | null;
  squawks: string[];
}

export function deriveFacets(props: Record<string, unknown>): EntityFacets {
  const kindRaw = typeof props['kind'] === 'string' ? (props['kind'] as string) : '';
  const kind: EntityFacets['kind'] =
    kindRaw === 'aircraft' ? 'aircraft' : kindRaw === 'vessel' ? 'vessel' : 'other';

  let aircraftCategory: string | null = null;
  let vesselType: string | null = null;
  let flag: string | null = null;

  if (kind === 'aircraft') {
    // aircraftStyle is a pure classifier (icon factory aside); reuse its `kind`.
    aircraftCategory = aircraftStyle(props).kind;
    const icao24 = props['icao24'];
    if (typeof icao24 === 'string' && icao24.length > 0) flag = flagFromIcao24(icao24);
  } else if (kind === 'vessel') {
    vesselType = vesselStyle(props).kind;
    const mmsi = props['mmsi'];
    if (typeof mmsi === 'number' || typeof mmsi === 'string') flag = flagFromMmsi(mmsi);
  }

  return {
    kind,
    altBucket: kind === 'aircraft' ? altBucketId(props) : null,
    aircraftCategory,
    vesselType,
    flag,
    squawks: kind === 'aircraft' ? squawkValues(props) : [],
  };
}

// Build the `FacetResolver` the pure evaluator expects from a derived-facets
// bundle. Exported so the adapter resolves a clause exactly as the panel does.
export function facetResolver(f: EntityFacets): FacetResolver {
  return (facet: FilterFacet): readonly string[] => {
    switch (facet) {
      case 'altBucket':
        return f.altBucket ? [f.altBucket] : [];
      case 'aircraftCategory':
        return f.aircraftCategory ? [f.aircraftCategory] : [];
      case 'vesselType':
        return f.vesselType ? [f.vesselType] : [];
      case 'flag':
        return f.flag ? [f.flag] : [];
      case 'squawk':
        return f.squawks;
      default:
        return [];
    }
  };
}

// Convenience the adapter calls per entity: does this property bag pass the
// active clause list? One import, one call — keeps the adapter's diff tiny.
export function entityPassesFilter(
  props: Record<string, unknown>,
  clauses: readonly FilterClause[],
): boolean {
  if (clauses.length === 0) return true;
  return matchesFilterClauses(clauses, facetResolver(deriveFacets(props)));
}

// ── Histogram assembly ──────────────────────────────────────────────────────
export interface Bucket {
  value: string;
  label: string;
  count: number;
}
export interface Histogram {
  facet: FilterFacet;
  title: string;
  buckets: Bucket[];
  total: number;
}

export const ALT_LABELS: Record<string, string> = {
  [ALT_GROUND]: 'On ground',
  [ALT_UNKNOWN]: 'Unknown alt',
  ...Object.fromEntries(ALT_BANDS.map((b) => [b.id, b.label])),
};
const ALT_ORDER = [ALT_GROUND, ...ALT_BANDS.map((b) => b.id), ALT_UNKNOWN];

export const AC_CAT_LABELS: Record<string, string> = {
  airliner: 'Airliner',
  private: 'Private / light',
  helicopter: 'Helicopter',
  glider: 'Glider',
  military: 'Military',
  emergency: 'Emergency',
};
export const VES_TYPE_LABELS: Record<string, string> = {
  cargo: 'Cargo',
  tanker: 'Tanker',
  fishing: 'Fishing',
  passenger: 'Passenger',
  military: 'Military',
  sailing: 'Sailing',
  pleasure: 'Pleasure',
  tug: 'Tug / service',
  sar: 'SAR',
  generic: 'Other',
};

export function bucketLabel(facet: FilterFacet, value: string): string {
  if (facet === 'altBucket') return ALT_LABELS[value] ?? value;
  if (facet === 'aircraftCategory') return AC_CAT_LABELS[value] ?? value;
  if (facet === 'vesselType') return VES_TYPE_LABELS[value] ?? value;
  return value;
}

// Running tally of facet counts. One per sample; bumped per classified entity,
// then turned into the display histograms. Mutable Maps keep the per-entity hot
// path allocation-free (the sampler walks ~13 k entities).
export interface FacetTally {
  alt: Map<string, number>;
  acCat: Map<string, number>;
  vesType: Map<string, number>;
  flag: Map<string, number>;
  squawk: Map<string, number>;
  counted: number;
}

export function newFacetTally(): FacetTally {
  return {
    alt: new Map(),
    acCat: new Map(),
    vesType: new Map(),
    flag: new Map(),
    squawk: new Map(),
    counted: 0,
  };
}

function bump(m: Map<string, number>, k: string | null): void {
  if (!k) return;
  m.set(k, (m.get(k) ?? 0) + 1);
}

// Classify one property bag and fold it into the tally. Mirrors the old
// HistogramPanel.aggregate inner body exactly — 'other' kinds are scenery and
// don't count.
export function tallyFacets(t: FacetTally, props: Record<string, unknown>): void {
  const f = deriveFacets(props);
  if (f.kind === 'other') return;
  t.counted++;
  if (f.kind === 'aircraft') {
    bump(t.alt, f.altBucket);
    bump(t.acCat, f.aircraftCategory);
    for (const sq of f.squawks) bump(t.squawk, sq);
  } else if (f.kind === 'vessel') {
    bump(t.vesType, f.vesselType);
  }
  bump(t.flag, f.flag);
}

function sortedBuckets(
  m: Map<string, number>,
  labels?: Record<string, string>,
  order?: string[],
): Bucket[] {
  const entries = [...m.entries()].map(([value, count]) => ({
    value,
    count,
    label: labels?.[value] ?? value,
  }));
  if (order) {
    entries.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  } else {
    entries.sort((a, b) => b.count - a.count);
  }
  return entries;
}

function sum(m: Map<string, number>): number {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
}

export function buildHistograms(t: FacetTally): Histogram[] {
  return [
    { facet: 'aircraftCategory', title: 'Aircraft category', buckets: sortedBuckets(t.acCat, AC_CAT_LABELS), total: sum(t.acCat) },
    { facet: 'altBucket', title: 'Altitude band', buckets: sortedBuckets(t.alt, ALT_LABELS, ALT_ORDER), total: sum(t.alt) },
    { facet: 'vesselType', title: 'Vessel type', buckets: sortedBuckets(t.vesType, VES_TYPE_LABELS), total: sum(t.vesType) },
    { facet: 'flag', title: 'Flag (derived)', buckets: sortedBuckets(t.flag).slice(0, 12), total: sum(t.flag) },
    { facet: 'squawk', title: 'Squawk', buckets: sortedBuckets(t.squawk).slice(0, 12), total: sum(t.squawk) },
  ];
}
