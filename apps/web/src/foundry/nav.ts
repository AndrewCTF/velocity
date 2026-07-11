// Foundry-internal navigation — deep-linkable view + selection (design §6.7).
// Same idiom as state/appView.ts's ?app= handling: one small zustand store
// mirrored to query params via history.replaceState, not a router. Params are
// namespaced (fv/fid/ftab) and persist() never touches other params (`app`),
// so switching apps and returning restores the exact Foundry context.
import { create } from 'zustand';

export type FoundryView = 'home' | 'datasets' | 'pipeline' | 'builds' | 'ontology';
export type DetailTab =
  | 'schema'
  | 'preview'
  | 'stats'
  | 'versions'
  | 'lineage'
  | 'deadletter'
  | 'checks'
  | 'docs'
  | 'map'
  | 'sql'
  | 'monitors';

const VIEWS: readonly FoundryView[] = ['home', 'datasets', 'pipeline', 'builds', 'ontology'];
const TABS: readonly DetailTab[] = [
  'schema',
  'preview',
  'stats',
  'versions',
  'lineage',
  'deadletter',
  'checks',
  'docs',
  'map',
  'sql',
  'monitors',
];

function readInitial(): Pick<FoundryNavState, 'view' | 'selectedId' | 'detailTab'> {
  try {
    const p = new URLSearchParams(window.location.search);
    const fv = p.get('fv');
    const view = fv && (VIEWS as readonly string[]).includes(fv) ? (fv as FoundryView) : 'home';
    const ftab = p.get('ftab');
    return {
      view,
      selectedId: p.get('fid'),
      detailTab: ftab && (TABS as readonly string[]).includes(ftab) ? (ftab as DetailTab) : null,
    };
  } catch {
    return { view: 'home', selectedId: null, detailTab: null };
  }
}

function persist(s: Pick<FoundryNavState, 'view' | 'selectedId' | 'detailTab'>): void {
  try {
    const u = new URL(window.location.href);
    if (s.view === 'home') u.searchParams.delete('fv');
    else u.searchParams.set('fv', s.view);
    if (s.selectedId) u.searchParams.set('fid', s.selectedId);
    else u.searchParams.delete('fid');
    if (s.detailTab) u.searchParams.set('ftab', s.detailTab);
    else u.searchParams.delete('ftab');
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* ignore */
  }
}

export interface FoundryNavState {
  view: FoundryView;
  // Contextual selection: dataset id (datasets), lineage node id (pipeline),
  // build id (builds — arrives expanded). Cleared on view change.
  selectedId: string | null;
  detailTab: DetailTab | null; // dataset detail tab, only meaningful on datasets
  setView: (v: FoundryView) => void;
  select: (id: string | null) => void;
  setDetailTab: (t: DetailTab | null) => void;
  navigate: (v: FoundryView, id?: string) => void; // cross-view jump
}

export const useFoundryNav = create<FoundryNavState>((set, get) => {
  const apply = (patch: Partial<Pick<FoundryNavState, 'view' | 'selectedId' | 'detailTab'>>): void => {
    const next = {
      view: get().view,
      selectedId: get().selectedId,
      detailTab: get().detailTab,
      ...patch,
    };
    persist(next);
    set(next);
  };
  return {
    ...readInitial(),
    setView: (view) => apply({ view, selectedId: null, detailTab: null }),
    select: (selectedId) => apply({ selectedId, ...(selectedId ? {} : { detailTab: null }) }),
    setDetailTab: (detailTab) => apply({ detailTab }),
    navigate: (view, id) => apply({ view, selectedId: id ?? null, detailTab: null }),
  };
});
