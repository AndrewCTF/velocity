import type { ReactNode } from 'react';
import * as Cesium from 'cesium';
import { useAppView, APP_META } from '../state/appView.js';
import { InvestigationCanvas } from '../graph/InvestigationCanvas.js';
import { TargetKanbanPanel } from '../target-kanban/TargetKanbanPanel.js';
import { VideoApp } from '../fmv/VideoApp.js';
import { ReportsApp } from '../reports/ReportsApp.js';
import { ExplorerApp } from '../explorer/ExplorerApp.js';
import { FoundryApp } from '../foundry/FoundryApp.js';
import { WorkflowsApp } from '../workflows/WorkflowsApp.js';
import { CityApp } from '../city/CityApp.js';

// AppSurface (design §6.1) — the non-Map apps render as a full surface over the
// globe (which stays mounted behind for instant return + shared selection). Map +
// Sim show the globe (Sim's controls are an overlay), so they render nothing here.
export function AppSurface({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element | null {
  const app = useAppView((s) => s.app);
  if (app === 'map' || app === 'sim') return null;

  let node: ReactNode;
  switch (app) {
    case 'explorer':
      node = <ExplorerApp viewer={viewer} />;
      break;
    case 'graph':
      node = <InvestigationCanvas />;
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
    default:
      node = null;
  }

  return (
    <div
      className="absolute left-11 top-0 bottom-0 z-[var(--z-overlay)] flex flex-col bg-bg-0"
      style={{ right: 'var(--rail-right-w, 360px)' }}
    >
      <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-line-2 bg-bg-1">
        <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0">
          {APP_META[app].label}
        </span>
        <span className="mono text-[10px] text-txt-3 truncate">{APP_META[app].hint}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">{node}</div>
    </div>
  );
}
