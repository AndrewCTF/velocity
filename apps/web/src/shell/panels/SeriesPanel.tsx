import type * as Cesium from 'cesium';
import { Icon } from '../../normal/Icon.js';
import { useSelection } from '../../state/stores.js';
import { MetricsPanel } from '../../metrics/MetricsPanel.js';
import { ArchiveSeriesCard } from '../../entity-panel/ArchiveSeriesCard.js';
import { findEntity, readProperties } from '../../entity-panel/read.js';

// Series — the second right-dock panel, per docs/mockups/console-2026-08
// (WIRING.md, "Right dock, panels the mockup adds"): MetricsPanel over the
// whole picture, plus the archived series for whatever is selected.
//
// It was declared in `panels.ts` and never wired, so `Console` filtered it out
// and the right dock rendered a single unlabelled column. A panel that exists
// in the contract and not in the app is the same "reachable but invisible"
// defect the rebuild set out to fix, one level down.

export function SeriesPanel({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element {
  const id = useSelection((s) => s.selectedEntityId);
  // The archive card needs the entity's kind to pick a series; read it off the
  // live entity rather than parsing it out of the id.
  let kind = '';
  if (viewer && id && !viewer.isDestroyed()) {
    const e = findEntity(viewer, id);
    if (e) kind = String(readProperties(e)['kind'] ?? '');
  }

  return (
    <div className="space-y-3 p-3">
      {id ? (
        <ArchiveSeriesCard id={id} kind={kind} />
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <Icon name="chart-line" className="h-6 w-6 text-txt-3" />
          <p className="max-w-[220px] text-[12px] leading-relaxed text-txt-3">
            Select a contact to chart its archived track against the live one.
          </p>
        </div>
      )}
      <MetricsPanel />
    </div>
  );
}
