import type * as Cesium from 'cesium';
import { HomeView } from './HomeView.js';
import { DatasetsView } from './DatasetsView.js';
import { PipelineView } from './PipelineView.js';
import { BuildsView } from './BuildsView.js';
import { OntologyView } from './OntologyView.js';
import { useFoundryNav, type FoundryView } from './nav.js';

// FOUNDRY surface (docs/foundry-plan.md) — BYO-data layer: upload → transform
// (with lineage) → build → bind into the ontology, operated from a Workshop-
// style dashboard. A left rail switches between the five stages of the loop;
// the surface is wired into the app switcher like Explorer/Graph (see
// state/appView.ts + shell/AppSurface.tsx). All chrome is token-driven so the
// whole thing flips with the light/dark theme.

export type { FoundryView } from './nav.js';

const NAV: Array<{ id: FoundryView; label: string; glyph: string; hint: string }> = [
  { id: 'home', label: 'Overview', glyph: '◱', hint: 'health + recent builds' },
  { id: 'datasets', label: 'Datasets', glyph: '▤', hint: 'upload, schema, checks' },
  { id: 'pipeline', label: 'Pipeline', glyph: '⋔', hint: 'transforms + lineage' },
  { id: 'builds', label: 'Builds', glyph: '⧉', hint: 'history + schedules' },
  { id: 'ontology', label: 'Ontology', glyph: '◈', hint: 'bindings + sync' },
];

export function FoundryApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  void viewer; // reserved for future fly-to-on-select parity with other apps
  const view = useFoundryNav((s) => s.view);
  const setView = useFoundryNav((s) => s.setView);

  return (
    <div className="h-full flex text-txt-1 bg-bg-0">
      <nav className="w-[168px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line-2">
          <span aria-hidden className="w-2.5 h-2.5 bg-accent rotate-45 shrink-0" />
          <span className="mono font-semibold tracking-[1.5px] text-[12px] text-txt-0">FOUNDRY</span>
        </div>
        <div className="flex-1 py-2 flex flex-col gap-0.5">
          {NAV.map((n) => {
            const on = view === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setView(n.id)}
                data-testid={`foundry-nav-${n.id}`}
                title={n.hint}
                className={[
                  'group text-left mx-1.5 px-2.5 py-2 rounded-sm border-l-2 flex items-start gap-2.5 transition-colors',
                  on
                    ? 'border-accent bg-accent-dim text-txt-0'
                    : 'border-transparent text-txt-2 hover:text-txt-0 hover:bg-bg-2',
                ].join(' ')}
              >
                <span aria-hidden className={`mono text-[13px] leading-none mt-px ${on ? 'text-accent' : 'text-txt-3 group-hover:text-txt-1'}`}>
                  {n.glyph}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium tracking-[0.06em] uppercase">{n.label}</span>
                  <span className="block text-[9.5px] tracking-[0.02em] text-txt-4 truncate">{n.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="px-3 py-2 border-t border-line-2 text-[9px] uppercase tracking-[0.4px] text-txt-4">
          keyless · local
        </div>
      </nav>
      <div className="flex-1 min-w-0 overflow-auto">
        {view === 'home' && <HomeView />}
        {view === 'datasets' && <DatasetsView />}
        {view === 'pipeline' && <PipelineView />}
        {view === 'builds' && <BuildsView />}
        {view === 'ontology' && <OntologyView />}
      </div>
    </div>
  );
}
