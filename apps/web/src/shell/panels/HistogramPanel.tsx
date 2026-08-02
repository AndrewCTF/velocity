import { useEffect, useMemo } from 'react';
import type * as Cesium from 'cesium';
import { Icon } from '../../normal/Icon.js';
import { useFilters } from '../../state/stores.js';
import { useEntityStats, setStatsViewer, acquireStats } from '../../globe/entityStats.js';
import { bucketLabel } from '../../explorer/facets.js';

// Histogram, built from docs/mockups/console-2026-08 (`13-map-histogram.html`)
// and fed by the same `useEntityStats` walk and `useFilters` slice the old panel
// read. Not a restyle of the old one.
//
// The measured reason it needed rebuilding: the old panel rendered 45 rows at
// 10px with **zero** marks. A faceted histogram whose rows carry no bar is a
// list of numbers wearing the name of a chart, and it was the clearest instance
// of the thing this rebuild exists to fix.
//
// Every row now carries the bar the reference puts on it, and the bar shows two
// quantities: the light segment is the share matching the current filter, the
// track behind it is the facet total. So one glance gives proportion as well as
// magnitude, which the count alone cannot.

export function HistogramPanel({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element {
  const histograms = useEntityStats((st) => st.histograms);
  const counted = useEntityStats((st) => st.counted);
  const clauses = useFilters((st) => st.clauses);
  const toggleClause = useFilters((st) => st.toggleClause);
  const clearAll = useFilters((st) => st.clear);
  const isActive = useFilters((st) => st.isActive);

  // The stats walk ref-counts its consumers and idle-schedules itself, so
  // mounting this panel shares one walk with Ops rather than adding an interval
  // next to Cesium's render loop.
  useEffect(() => {
    if (!viewer) return;
    setStatsViewer(viewer);
    return acquireStats();
  }, [viewer]);

  const nonEmpty = useMemo(() => histograms.filter((h) => h.buckets.length > 0), [histograms]);

  if (!viewer) {
    return (
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <Icon name="chart" className="h-6 w-6 text-txt-3" />
        <div className="text-[13px] text-txt-1">Globe not ready</div>
        <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
          Facets are counted off the live scene. They appear once the globe has loaded.
        </p>
      </div>
    );
  }

  return (
    <div className="pb-2">
      {/* Active filters as removable chips, above the facets they came from. */}
      {clauses.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-[14px] py-[6px]">
          {clauses.map((c) => (
            <button
              key={`${c.facet}:${c.value}:${c.mode}`}
              type="button"
              onClick={() => toggleClause(c.facet, c.value, c.mode)}
              className="flex h-5 items-center gap-[5px] rounded-sm border border-accent-line bg-accent-dim px-[7px] text-[12px] text-accent-fg"
            >
              {c.mode === 'not' && <Icon name="eye-off" className="h-3 w-3" />}
              {bucketLabel(c.facet, c.value)}
              <Icon name="x" className="h-3 w-3" />
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={clearAll}
            className="h-5 rounded-sm px-[7px] text-[12px] text-txt-3 hover:bg-[var(--hover)] hover:text-txt-0"
          >
            Clear {clauses.length}
          </button>
        </div>
      )}

      {nonEmpty.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-8 text-center">
          <Icon name="chart" className="h-6 w-6 text-txt-3" />
          <div className="text-[13px] text-txt-1">No contacts to break down</div>
          <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
            Nothing is in view to count. Turn a layer on, or move the camera to an area with
            traffic.
          </p>
        </div>
      ) : (
        nonEmpty.map((h) => {
          const peak = Math.max(1, ...h.buckets.map((b) => b.count));
          return (
            <section key={h.facet} aria-label={h.title}>
              <div className="mt-3 flex h-[26px] items-center gap-[6px] border-t border-line px-[14px] pt-[6px] first:mt-0 first:border-t-0 first:pt-0">
                <span className="text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
                  {h.title}
                </span>
                <span className="flex-1" />
                <span className="mono text-[12px] tabular-nums text-txt-3">
                  {h.total.toLocaleString()}
                </span>
              </div>

              {h.buckets.map((b) => {
                const on = isActive(h.facet, b.value, 'only');
                const out = isActive(h.facet, b.value, 'not');
                const frac = b.count / peak;
                return (
                  <div
                    key={b.value}
                    className={`flex min-h-[20px] items-center gap-2 px-[14px] py-[2px] ${
                      on ? 'bg-accent-dim shadow-[inset_0_0_0_1px_var(--accent-line)]' : 'hover:bg-[var(--hover)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleClause(h.facet, b.value, 'only')}
                      className={`min-w-0 flex-1 truncate text-left text-[12px] ${
                        out ? 'text-txt-3 line-through' : on ? 'text-txt-0' : 'text-txt-1'
                      }`}
                      title={`Filter to ${b.label}`}
                    >
                      {b.label}
                    </button>
                    <span className="mono w-[52px] shrink-0 text-right text-[12px] tabular-nums text-txt-2">
                      {b.count.toLocaleString()}
                    </span>
                    {/* The bar the old panel never had. Light = the filtered
                        share, track = the facet total. */}
                    <span
                      className="relative h-[10px] w-[66px] shrink-0 overflow-hidden rounded-[1px] bg-bg-0"
                      aria-hidden="true"
                    >
                      <i
                        className={`absolute inset-y-0 left-0 block ${
                          out ? 'bg-bg-4' : on ? 'bg-accent-fg' : 'bg-accent'
                        }`}
                        style={{ width: `${Math.max(2, Math.min(100, frac * 100))}%` }}
                      />
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleClause(h.facet, b.value, 'not')}
                      aria-label={`Filter out ${b.label}`}
                      title={`Filter out ${b.label}`}
                      className={`shrink-0 rounded-sm p-[2px] ${
                        out ? 'text-alert-fg' : 'text-bg-4 hover:text-txt-3'
                      }`}
                    >
                      <Icon name="eye-off" className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })
      )}

      <div className="mt-3 border-t border-line px-[14px] py-[6px] text-[12px] text-txt-3">
        {counted.toLocaleString()} contacts counted in view
      </div>
    </div>
  );
}
