import { useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import {
  useFilters,
  matchesFilterClauses,
  type FilterFacet,
  type FilterMode,
  type FacetResolver,
} from '../state/stores.js';
import { aircraftStyle, vesselStyle } from '../globe/adapters/styles.js';
import { SectionLabel, MicroLabel, Btn, Badge } from '../shell/instruments.js';

// ── Map-side faceted histogram + filter panel (C2) ──────────────────────────
//
// Aggregates the LIVE entities in `viewer.dataSources` into facet buckets —
// altitude band, aircraft category, vessel type, flag (derived client-side),
// and squawk — and lets the analyst click a bar to "filter to" (keep only it)
// or shift-click / use the ⊘ affordance to "filter out". The active filter is
// the shared `useFilters` slice; `PollGeoJsonAdapter.applyStyle` reads the same
// `matchesFilterClauses` evaluator and de-emphasises non-matching entities
// (translucent, never removed — the SVG icon + upsert-by-id stay intact).
//
// This panel READS the viewer; it never mutates entities. The only side effect
// is on the `useFilters` store, which the adapter observes. So toggling a layer,
// the motion model, and the icon dispatch can never regress from here.

// How often we re-aggregate the (up to ~13 k) live entities. The walk is a
// cheap classify-and-count; 800 ms keeps the bars feeling live without burning
// the main thread next to Cesium's own per-frame render.
const AGGREGATE_INTERVAL_MS = 800;

// ── Facet derivation (pure; shared with the adapter) ────────────────────────
// These map a feature's raw properties to the bucket id(s) it belongs in. They
// are exported so the adapter's visibility predicate classifies an entity with
// the EXACT same logic the histogram counted it under — one source of truth for
// "what bucket is this".

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
  clauses: readonly import('../state/stores.js').FilterClause[],
): boolean {
  if (clauses.length === 0) return true;
  return matchesFilterClauses(clauses, facetResolver(deriveFacets(props)));
}

// ── Aggregation over the live viewer ────────────────────────────────────────
interface Bucket {
  value: string;
  label: string;
  count: number;
}
interface Histogram {
  facet: FilterFacet;
  title: string;
  buckets: Bucket[];
  total: number;
}

const ALT_LABELS: Record<string, string> = {
  [ALT_GROUND]: 'On ground',
  [ALT_UNKNOWN]: 'Unknown alt',
  ...Object.fromEntries(ALT_BANDS.map((b) => [b.id, b.label])),
};
const ALT_ORDER = [ALT_GROUND, ...ALT_BANDS.map((b) => b.id), ALT_UNKNOWN];

const AC_CAT_LABELS: Record<string, string> = {
  airliner: 'Airliner',
  private: 'Private / light',
  helicopter: 'Helicopter',
  glider: 'Glider',
  military: 'Military',
  emergency: 'Emergency',
};
const VES_TYPE_LABELS: Record<string, string> = {
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

// Walk every data source's entities once, classify, and tally each facet. Reads
// properties exactly like EntityPanel.readProperties (PropertyBag → values at
// the clock time). Skips entities with no `kind` (basemap furniture, jamming
// cells, sats) so the bars reflect contacts, not scenery.
function aggregate(viewer: Cesium.Viewer): { histograms: Histogram[]; counted: number } {
  const now = viewer.clock.currentTime;
  const alt = new Map<string, number>();
  const acCat = new Map<string, number>();
  const vesType = new Map<string, number>();
  const flag = new Map<string, number>();
  const squawk = new Map<string, number>();
  let counted = 0;

  const bump = (m: Map<string, number>, k: string | null): void => {
    if (!k) return;
    m.set(k, (m.get(k) ?? 0) + 1);
  };

  for (let i = 0; i < viewer.dataSources.length; i++) {
    const ds = viewer.dataSources.get(i);
    for (const e of ds.entities.values) {
      const bag = e.properties;
      if (!bag) continue;
      const names = bag.propertyNames as readonly string[] | undefined;
      if (!names || names.length === 0) continue;
      const props: Record<string, unknown> = {};
      for (const n of names) {
        const p = (bag as unknown as Record<string, Cesium.Property | undefined>)[n];
        if (!p) continue;
        try {
          props[n] = p.getValue(now);
        } catch {
          /* skip unreadable property */
        }
      }
      const f = deriveFacets(props);
      if (f.kind === 'other') continue;
      counted++;
      if (f.kind === 'aircraft') {
        bump(alt, f.altBucket);
        bump(acCat, f.aircraftCategory);
        for (const sq of f.squawks) bump(squawk, sq);
      } else if (f.kind === 'vessel') {
        bump(vesType, f.vesselType);
      }
      bump(flag, f.flag);
    }
  }

  const sortedBuckets = (m: Map<string, number>, labels?: Record<string, string>, order?: string[]): Bucket[] => {
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
  };

  const sum = (m: Map<string, number>): number => {
    let t = 0;
    for (const v of m.values()) t += v;
    return t;
  };

  const histograms: Histogram[] = [
    { facet: 'aircraftCategory', title: 'Aircraft category', buckets: sortedBuckets(acCat, AC_CAT_LABELS), total: sum(acCat) },
    { facet: 'altBucket', title: 'Altitude band', buckets: sortedBuckets(alt, ALT_LABELS, ALT_ORDER), total: sum(alt) },
    { facet: 'vesselType', title: 'Vessel type', buckets: sortedBuckets(vesType, VES_TYPE_LABELS), total: sum(vesType) },
    { facet: 'flag', title: 'Flag (derived)', buckets: sortedBuckets(flag).slice(0, 12), total: sum(flag) },
    { facet: 'squawk', title: 'Squawk', buckets: sortedBuckets(squawk).slice(0, 12), total: sum(squawk) },
  ];
  return { histograms, counted };
}

interface Props {
  viewer?: Cesium.Viewer | null;
}

export function HistogramPanel({ viewer }: Props = {}): JSX.Element {
  const [data, setData] = useState<{ histograms: Histogram[]; counted: number }>({
    histograms: [],
    counted: 0,
  });
  const clauses = useFilters((s) => s.clauses);
  const toggleClause = useFilters((s) => s.toggleClause);
  const clearAll = useFilters((s) => s.clear);
  const isActive = useFilters((s) => s.isActive);

  // Re-aggregate on a steady interval (independent of Cesium's render loop, so
  // it advances even when the clock is paused / the tab is throttled).
  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    const run = (): void => {
      if (cancelled || viewer.isDestroyed()) return;
      try {
        setData(aggregate(viewer));
      } catch {
        /* a torn-down viewer mid-walk; next tick recovers */
      }
    };
    run();
    const t = window.setInterval(run, AGGREGATE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [viewer]);

  const nonEmpty = useMemo(() => data.histograms.filter((h) => h.buckets.length > 0), [data]);

  if (!viewer) {
    return (
      <div className="p-3">
        <MicroLabel>Filters</MicroLabel>
        <p className="mono text-[10px] text-txt-3 mt-2">Globe not ready.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 pt-3 pb-2 flex-none">
        <SectionLabel title="Filters" count={`${data.counted} contacts`} className="flex-1" />
        {clauses.length > 0 && (
          <Btn size="sm" onClick={clearAll} title="Clear all filters" className="ml-2">
            Clear ({clauses.length})
          </Btn>
        )}
      </div>

      {clauses.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1 flex-none">
          {clauses.map((c) => (
            <button
              key={`${c.facet}:${c.value}:${c.mode}`}
              type="button"
              onClick={() => toggleClause(c.facet, c.value, c.mode)}
              title="Remove this filter"
              className="group"
            >
              <Badge tone={c.mode === 'not' ? 'alert' : 'accent'}>
                {c.mode === 'not' ? '⊘ ' : ''}
                {bucketLabel(c.facet, c.value)} ✕
              </Badge>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
        {nonEmpty.length === 0 ? (
          <p className="mono text-[10px] text-txt-3 mt-1">
            No classified contacts on the globe yet. Pan to a busy region or enable a layer.
          </p>
        ) : (
          nonEmpty.map((h) => (
            <HistogramBlock
              key={h.facet}
              hist={h}
              isActive={isActive}
              onToggle={toggleClause}
            />
          ))
        )}
        <p className="mono text-[9px] text-txt-4 leading-relaxed pt-1">
          Filters dim non-matching contacts on the map — icons stay drawn, never removed. Flag is
          derived client-side from ICAO24 / MMSI blocks (coarse).
        </p>
      </div>
    </div>
  );
}

function bucketLabel(facet: FilterFacet, value: string): string {
  if (facet === 'altBucket') return ALT_LABELS[value] ?? value;
  if (facet === 'aircraftCategory') return AC_CAT_LABELS[value] ?? value;
  if (facet === 'vesselType') return VES_TYPE_LABELS[value] ?? value;
  return value;
}

function HistogramBlock({
  hist,
  isActive,
  onToggle,
}: {
  hist: Histogram;
  isActive: (f: FilterFacet, v: string, m: FilterMode) => boolean;
  onToggle: (f: FilterFacet, v: string, m: FilterMode) => void;
}): JSX.Element {
  const max = Math.max(1, ...hist.buckets.map((b) => b.count));
  return (
    <section>
      <SectionLabel title={hist.title} count={hist.total} />
      <div className="mt-1.5 space-y-[3px]">
        {hist.buckets.map((b) => {
          const onlyOn = isActive(hist.facet, b.value, 'only');
          const notOn = isActive(hist.facet, b.value, 'not');
          const pct = (b.count / max) * 100;
          return (
            <div key={b.value} className="flex items-center gap-1.5 group">
              {/* The bar itself = "filter to" (only this bucket). */}
              <button
                type="button"
                onClick={() => onToggle(hist.facet, b.value, 'only')}
                title={`Filter to ${b.label} (${b.count})`}
                className="relative flex-1 h-[18px] rounded-sm border bg-bg-2 overflow-hidden text-left"
                style={{
                  borderColor: onlyOn ? 'var(--accent-line)' : 'var(--line)',
                }}
              >
                <span
                  className="absolute left-0 top-0 bottom-0 rounded-sm"
                  style={{
                    width: `${pct}%`,
                    background: notOn
                      ? 'rgba(255,90,82,0.18)'
                      : onlyOn
                        ? 'var(--accent-dim)'
                        : 'rgba(120,140,170,0.16)',
                  }}
                />
                <span className="relative z-10 flex items-center justify-between h-full px-2">
                  <span
                    className={`mono text-[9px] truncate ${
                      notOn ? 'text-txt-4 line-through' : onlyOn ? 'text-accent' : 'text-txt-1'
                    }`}
                  >
                    {b.label}
                  </span>
                  <span className="mono text-[9px] tabular-nums text-txt-3 ml-2">{b.count}</span>
                </span>
              </button>
              {/* Exclude toggle (⊘ "filter out this bucket"). */}
              <button
                type="button"
                onClick={() => onToggle(hist.facet, b.value, 'not')}
                title={`Filter out ${b.label}`}
                aria-pressed={notOn}
                className={`mono text-[10px] leading-none w-[18px] h-[18px] flex items-center justify-center rounded-sm border shrink-0 ${
                  notOn
                    ? 'border-[rgba(255,90,82,0.5)] text-[#ffb3ae] bg-alert-bg'
                    : 'border-line text-txt-3 hover:text-[#ffb3ae] hover:border-[rgba(255,90,82,0.4)]'
                }`}
              >
                ⊘
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
