import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';

// Live per-layer contact counts, keyed by Cesium DataSource name (which is the
// registry layer id).
//
// Extracted from LayerRail so the curated catalog can show the same numbers.
// The catalog previously rendered `on` / `off` chips and no count at all, which
// is the "stop showing me numbers, I want to see the data" complaint in its
// worst form: not a bare number, but no number.
//
// `entities.values.length` returns the underlying entity total even when
// EntityCluster aggregates them visually, because clustering is a render-time
// grouping and not a collection mutation. So this counts real contacts, not
// icons on screen. Verified for vessels, which do cluster.
export function useLayerCounts(viewer: Cesium.Viewer | null | undefined): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const perDsUnsub = new Map<Cesium.DataSource, () => void>();

    const recount = (): void => {
      // A destroyed viewer (HMR / globe ErrorBoundary) throws on .dataSources.
      if (viewer.isDestroyed()) return;
      const next: Record<string, number> = {};
      for (let i = 0; i < viewer.dataSources.length; i++) {
        const ds = viewer.dataSources.get(i);
        next[ds.name] = ds.entities.values.length;
      }
      setCounts(next);
    };

    const attach = (ds: Cesium.DataSource): void => {
      if (perDsUnsub.has(ds)) return;
      perDsUnsub.set(ds, ds.entities.collectionChanged.addEventListener(recount));
    };
    const detach = (ds: Cesium.DataSource): void => {
      perDsUnsub.get(ds)?.();
      perDsUnsub.delete(ds);
    };

    for (let i = 0; i < viewer.dataSources.length; i++) attach(viewer.dataSources.get(i));
    const removeAdded = viewer.dataSources.dataSourceAdded.addEventListener((_c, ds) => {
      attach(ds);
      recount();
    });
    const removeRemoved = viewer.dataSources.dataSourceRemoved.addEventListener((_c, ds) => {
      detach(ds);
      recount();
    });

    // Initial count, plus a 2 s safety net for any source that mutates without
    // firing collectionChanged.
    recount();
    const safety = window.setInterval(recount, 2000);

    return () => {
      window.clearInterval(safety);
      removeAdded();
      removeRemoved();
      for (const remove of perDsUnsub.values()) remove();
      perDsUnsub.clear();
    };
  }, [viewer]);

  return counts;
}

/** Sum of the live counts for every registry layer a catalog row maps to. */
export function rowCount(counts: Record<string, number>, layerIds: readonly string[]): number {
  let n = 0;
  for (const id of layerIds) n += counts[id] ?? 0;
  return n;
}

/** What a row can honestly say about itself.
 *
 *  `rowCount` alone cannot tell "this source answered and there is nothing
 *  there" from "this source has not answered yet", because it folds a missing
 *  key to 0. Those are different facts and an operator acts differently on
 *  them: a quiet layer is information, a layer that never loaded is a fault.
 *  A DataSource exists only once the compositor has spawned and fetched the
 *  layer, so a missing key IS the pending case. */
export type RowState =
  | { state: 'off' }
  | { state: 'pending' }
  | { state: 'empty' }
  | { state: 'live'; n: number };

export function rowState(
  counts: Record<string, number>,
  layerIds: readonly string[],
  enabled: boolean,
): RowState {
  if (!enabled) return { state: 'off' };
  const known = layerIds.filter((id) => counts[id] !== undefined);
  if (known.length === 0) return { state: 'pending' };
  const n = known.reduce((a, id) => a + (counts[id] ?? 0), 0);
  return n > 0 ? { state: 'live', n } : { state: 'empty' };
}
