// Top-level app switcher (design §6.1). Gotham is a multi-app workspace, not one
// mega-dashboard: Map (the globe), Explorer (object explorer over the live store),
// Graph (link analysis), Targeting (kill-chain board), Video (FMV + ground recon),
// Sim (war-game), Reports (case files / briefs). All apps share the same selection
// + time context — switching apps never loses the selected object.
//
// The active app persists to localStorage and mirrors to the ?app= URL param so a
// view is deep-linkable (§6.7). ponytail: one small store, not a router — the apps
// render into the same map grid slot; only the globe (Map) is always mounted.
import { create } from 'zustand';

export type AppId =
  | 'map'
  | 'explorer'
  | 'graph'
  | 'targeting'
  | 'video'
  | 'sim'
  | 'reports';

export const APP_IDS: readonly AppId[] = [
  'map',
  'explorer',
  'graph',
  'targeting',
  'video',
  'sim',
  'reports',
];

export const APP_META: Record<AppId, { label: string; hint: string }> = {
  map: { label: 'Map', hint: 'Live geospatial COP (globe)' },
  explorer: { label: 'Explorer', hint: 'Filter / aggregate the live object store' },
  graph: { label: 'Graph', hint: 'Link analysis + search-around' },
  targeting: { label: 'Targeting', hint: 'Kill-chain board (notional)' },
  video: { label: 'Video', hint: 'FMV + ground recon + detections' },
  sim: { label: 'Sim', hint: 'Browser war-game overlay' },
  reports: { label: 'Reports', hint: 'Case files, briefs, dossiers' },
};

const LS_KEY = 'velocity.appView';

function readInitial(): AppId {
  try {
    const url = new URLSearchParams(window.location.search).get('app');
    if (url && (APP_IDS as readonly string[]).includes(url)) return url as AppId;
    const ls = localStorage.getItem(LS_KEY);
    if (ls && (APP_IDS as readonly string[]).includes(ls)) return ls as AppId;
  } catch {
    /* SSR / storage disabled */
  }
  return 'map';
}

function persist(app: AppId): void {
  try {
    localStorage.setItem(LS_KEY, app);
    const u = new URL(window.location.href);
    if (app === 'map') u.searchParams.delete('app');
    else u.searchParams.set('app', app);
    window.history.replaceState(null, '', u.toString());
  } catch {
    /* ignore */
  }
}

interface AppViewState {
  app: AppId;
  setApp: (app: AppId) => void;
}

export const useAppView = create<AppViewState>((set) => ({
  app: readInitial(),
  setApp: (app) => {
    persist(app);
    set({ app });
  },
}));
