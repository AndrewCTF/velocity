// WORKFLOWS surface (docs/dashboard-workflows-plan.md §2) — user-authored
// analysis pipelines (DAGs of source/op/sink blocks, including real Python/
// SQL/LLM power blocks) over live platform data. Left rail switches between
// the three stages of the loop, mirroring FoundryApp's shell chrome exactly
// so the app switcher reads as one console.

import { EditorView } from './EditorView.js';
import { RunsView } from './RunsView.js';
import { BlocksView } from './BlocksView.js';
import { useWorkflowsNav, type WorkflowsView } from './nav.js';

export type { WorkflowsView } from './nav.js';

const NAV: Array<{ id: WorkflowsView; label: string; glyph: string; hint: string }> = [
  { id: 'workflows', label: 'Workflows', glyph: '⋔', hint: 'author + edit DAGs' },
  { id: 'runs', label: 'Runs', glyph: '⧉', hint: 'run history + logs' },
  { id: 'blocks', label: 'Blocks', glyph: '◈', hint: 'catalog reference' },
];

export function WorkflowsApp(): JSX.Element {
  const view = useWorkflowsNav((s) => s.view);
  const setView = useWorkflowsNav((s) => s.setView);

  return (
    <div className="h-full flex text-txt-1 bg-bg-0">
      <nav className="w-[168px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line-2">
          <span aria-hidden className="w-2.5 h-2.5 bg-accent rotate-45 shrink-0" />
          <span className="mono font-semibold tracking-[1.5px] text-[12px] text-txt-0">WORKFLOWS</span>
        </div>
        <div className="flex-1 py-2 flex flex-col gap-0.5">
          {NAV.map((n) => {
            const on = view === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setView(n.id)}
                data-testid={`workflows-nav-${n.id}`}
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
          keyless · local · BYO-compute
        </div>
      </nav>
      <div className="flex-1 min-w-0 overflow-auto">
        {view === 'workflows' && <EditorView />}
        {view === 'runs' && <RunsView />}
        {view === 'blocks' && <BlocksView />}
      </div>
    </div>
  );
}
