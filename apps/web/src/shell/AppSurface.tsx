import { Suspense, lazy, type ReactNode } from 'react';
import * as Cesium from 'cesium';
import { useAppView, APP_META, type AppId } from '../state/appView.js';
import { InvestigationCanvas } from '../graph/InvestigationCanvas.js';
import { InvestigatePanel } from '../osint/InvestigatePanel.js';
import { TargetKanbanPanel } from '../target-kanban/TargetKanbanPanel.js';
import { VideoApp } from '../fmv/VideoApp.js';
import { ReportsApp } from '../reports/ReportsApp.js';
import { ExplorerApp } from '../explorer/ExplorerApp.js';
import { FoundryApp } from '../foundry/FoundryApp.js';
import { WorkflowsApp } from '../workflows/WorkflowsApp.js';
import { CountryApp } from '../country/CountryApp.js';
import { AiHubApp } from '../ai/AiHubApp.js';
import { MarketsApp } from '../markets/MarketsApp.js';
import { TabbedPanel } from './TabbedPanel.js';
import { ExtractPanel } from '../extract/ExtractPanel.js';
import { CountriesPanel } from '../osint/CountriesPanel.js';

// CityApp is the one surface that drags three + the splat renderer with it —
// code-split so the console bundle doesn't carry a 3D engine nobody opened.
const CityApp = lazy(() => import('../city/CityApp.js').then((m) => ({ default: m.CityApp })));

/** Apps whose content is forms and prose, not a table or a board.
 *
 *  Every one of these was written for the old ~380px rail flyout and then
 *  dropped into a 1,244px surface with no measure on it. Reports drew a
 *  600px-wide `Cancel` button beside a 600px-wide `Finish`; Investigate ran a
 *  paragraph of body text the full width of the console. Neither happens in the
 *  reference, which holds a column and lets the surface breathe around it.
 *
 *  Explorer, Targeting, Graph, Foundry, Workflows, City and Markets are left
 *  full-bleed: a result table, a kanban board and a link canvas all genuinely
 *  use the width. */
const MEASURED = new Set<AppId>(['ai', 'investigate', 'video', 'reports', 'country']);

// AppSurface (design §6.1) — the non-Map apps render as a full surface over the
// globe (which stays mounted behind for instant return + shared selection). Map +
// Sim show the globe (Sim's controls are an overlay), so they render nothing here.
export function AppSurface({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const app = useAppView((s) => s.app);
  if (app === 'map' || app === 'sim') return null;

  let node: ReactNode;
  switch (app) {
    case 'ai':
      node = <AiHubApp viewer={viewer} />;
      break;
    case 'explorer':
      node = <ExplorerApp viewer={viewer} />;
      break;
    case 'graph':
      node = <InvestigationCanvas />;
      break;
    case 'investigate':
      // `panels.ts` re-homes the old `extract` rail item here ("extract → the
      // investigate app"), and nothing rendered it, so the document/entity
      // extractor was constructed in App.tsx and discarded by `byHome`. A
      // recorded home only counts once something is at the address.
      node = (
        <TabbedPanel
          ariaLabel="Investigate"
          defaultTab="lookup"
          tabs={[
            { id: 'lookup', label: 'Lookup', content: <InvestigatePanel /> },
            { id: 'extract', label: 'Extract', content: <ExtractPanel /> },
          ]}
        />
      );
      break;
    case 'targeting':
      node = <TargetKanbanPanel viewer={viewer} />;
      break;
    case 'video':
      node = <VideoApp viewer={viewer} />;
      break;
    case 'reports':
      node = <ReportsApp viewer={viewer} />;
      break;
    case 'foundry':
      node = <FoundryApp viewer={viewer} />;
      break;
    case 'workflows':
      node = <WorkflowsApp />;
      break;
    case 'city':
      node = <CityApp />;
      break;
    case 'country':
      // Same story as Extract: `countries` is recorded "redundant with the
      // Country app", but the Country app is a per-country dossier and the old
      // panel is the catalogue of national OSINT sources. Two different things,
      // so the redundancy is only true once both are here.
      node = (
        <TabbedPanel
          ariaLabel="Country"
          defaultTab="dossier"
          tabs={[
            { id: 'dossier', label: 'Dossier', content: <CountryApp /> },
            { id: 'sources', label: 'National sources', content: <CountriesPanel /> },
          ]}
        />
      );
      break;
    case 'markets':
      node = <MarketsApp />;
      break;
    default:
      node = null;
  }

  return (
    // inset-0, not `left-11` + `right: --rail-right-w`. Both offsets were sized
    // against the OLD shell's 44px icon rail and its own right rail; in this
    // shell the map column already excludes both, so the app opened 44px inside
    // the map well and left a dead 36px strip of globe down its left edge with
    // the map legend clipped to `ai / ve / da / GP`.
    <div className="absolute inset-0 z-[var(--z-overlay)] flex flex-col bg-bg-0">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line-2 bg-bg-1 px-3">
        <span className="font-label text-[12px] uppercase tracking-[0.9px] text-txt-0">
          {APP_META[app].label}
        </span>
        <span className="truncate text-[12px] text-txt-3">{APP_META[app].hint}</span>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${MEASURED.has(app) ? 'csl2-app-measure' : ''}`}>
        <Suspense fallback={<div className="mono p-3 text-[12px] text-txt-2">loading…</div>}>
          {node}
        </Suspense>
      </div>
    </div>
  );
}
