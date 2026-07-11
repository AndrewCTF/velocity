// Workflows-internal navigation — deep-linkable view + selection, same idiom
// as foundry/nav.ts (itself mirroring state/appView.ts's ?app= handling): one
// small zustand store mirrored to query params via history.replaceState, not
// a router. Params are namespaced (wv/wid) and persist() never touches other
// params (`app`, foundry's fv/fid/ftab), so switching apps and returning
// restores the exact Workflows context.
import { create } from 'zustand';

export type WorkflowsView = 'workflows' | 'runs' | 'blocks';

const VIEWS: readonly WorkflowsView[] = ['workflows', 'runs', 'blocks'];

function readInitial(): Pick<WorkflowsNavState, 'view' | 'selectedId'> {
  try {
    const p = new URLSearchParams(window.location.search);
    const wv = p.get('wv');
    const view = wv && (VIEWS as readonly string[]).includes(wv) ? (wv as WorkflowsView) : 'workflows';
    return { view, selectedId: p.get('wid') };
  } catch {
    return { view: 'workflows', selectedId: null };
  }
}

function persist(s: Pick<WorkflowsNavState, 'view' | 'selectedId'>): void {
  try {
    const u = new URL(window.location.href);
    if (s.view === 'workflows') u.searchParams.delete('wv');
    else u.searchParams.set('wv', s.view);
    if (s.selectedId) u.searchParams.set('wid', s.selectedId);
    else u.searchParams.delete('wid');
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* ignore */
  }
}

export interface WorkflowsNavState {
  view: WorkflowsView;
  // Contextual selection: a workflow id (workflows view) or a run id (runs
  // view, arrives expanded). Cleared on plain view change, set explicitly by
  // select()/navigate().
  selectedId: string | null;
  setView: (v: WorkflowsView) => void;
  select: (id: string | null) => void;
  navigate: (v: WorkflowsView, id?: string) => void; // cross-view jump
}

export const useWorkflowsNav = create<WorkflowsNavState>((set, get) => {
  const apply = (patch: Partial<Pick<WorkflowsNavState, 'view' | 'selectedId'>>): void => {
    const next = { view: get().view, selectedId: get().selectedId, ...patch };
    persist(next);
    set(next);
  };
  return {
    ...readInitial(),
    setView: (view) => apply({ view, selectedId: null }),
    select: (selectedId) => apply({ selectedId }),
    navigate: (view, id) => apply({ view, selectedId: id ?? null }),
  };
});
