import { useEffect, useMemo } from 'react';
import * as Cesium from 'cesium';
import { useFilters, type FilterFacet, type FilterMode } from '../state/stores.js';
import { bucketLabel, type Histogram } from './facets.js';
import { useEntityStats, setStatsViewer, acquireStats } from '../globe/entityStats.js';
import { SectionLabel, MicroLabel, Btn, Badge } from '../shell/instruments.js';

// ── Map-side faceted histogram + filter panel (C2) ──────────────────────────
//
// Renders facet buckets — altitude band, aircraft category, vessel type, flag
// (derived client-side), squawk — and lets the analyst click a bar to "filter
// to" (keep only it) or use the ⊘ affordance to "filter out". The active filter
// is the shared `useFilters` slice; `PollGeoJsonAdapter.applyStyle` reads the
// same evaluator and de-emphasises non-matching entities (translucent, never
// removed — the SVG icon + upsert-by-id stay intact).
//
// The faceted classification + histogram assembly now live in ./facets.ts
// (pure, no React), and the LIVE walk over the viewer in ../globe/entityStats.ts
// (one shared, idle-scheduled sampler that also feeds OpsPanel's AOI counts).
// This panel just SUBSCRIBES to the resulting store slice and renders — it no
// longer runs its own per-tick entity walk next to Cesium's render loop.

// Re-export the pure facet helpers from their new home so existing importers —
// the adapter's `entityPassesFilter`, the test's `deriveFacets`/`ALT_BANDS` —
// keep their import path unchanged.
export {
  deriveFacets,
  facetResolver,
  entityPassesFilter,
  ALT_BANDS,
} from './facets.js';
export type { EntityFacets, AltBand } from './facets.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

export function HistogramPanel({ viewer }: Props = {}): JSX.Element {
  const histograms = useEntityStats((s) => s.histograms);
  const counted = useEntityStats((s) => s.counted);
  const clauses = useFilters((s) => s.clauses);
  const toggleClause = useFilters((s) => s.toggleClause);
  const clearAll = useFilters((s) => s.clear);
  const isActive = useFilters((s) => s.isActive);

  // Drive the shared entity-stats sampler while this panel is mounted. The walk
  // ref-counts its consumers and idle-schedules itself (see entityStats.ts), so
  // mounting the panel no longer adds a hard 800 ms interval next to Cesium's
  // render loop — and it shares the single walk with OpsPanel.
  useEffect(() => {
    if (!viewer) return;
    setStatsViewer(viewer);
    return acquireStats();
  }, [viewer]);

  const nonEmpty = useMemo(() => histograms.filter((h) => h.buckets.length > 0), [histograms]);

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
        <SectionLabel title="Filters" count={`${counted} contacts`} className="flex-1" />
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
            <HistogramBlock key={h.facet} hist={h} isActive={isActive} onToggle={toggleClause} />
          ))
        )}
        <p className="mono text-[10px] text-txt-4 leading-relaxed pt-1">
          Filters dim non-matching contacts on the map — icons stay drawn, never removed. Flag is
          derived client-side from ICAO24 / MMSI blocks (coarse).
        </p>
      </div>
    </div>
  );
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
                      ? 'var(--alert-bg)'
                      : onlyOn
                        ? 'var(--accent-dim)'
                        : 'var(--line-2)',
                  }}
                />
                <span className="relative z-10 flex items-center justify-between h-full px-2">
                  <span
                    className={`mono text-[10px] truncate ${
                      notOn ? 'text-txt-4 line-through' : onlyOn ? 'text-accent' : 'text-txt-1'
                    }`}
                  >
                    {b.label}
                  </span>
                  <span className="mono text-[10px] tabular-nums text-txt-3 ml-2">{b.count}</span>
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
                    ? 'border-alert-line text-alert-fg bg-alert-bg'
                    : 'border-line text-txt-3 hover:text-alert-fg hover:border-alert-line'
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
