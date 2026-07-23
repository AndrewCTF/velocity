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

import { useSim } from './stores.js';

export type AppId =
  | 'map'
  | 'ai'
  | 'explorer'
  | 'graph'
  | 'investigate'
  | 'targeting'
  | 'video'
  | 'sim'
  | 'reports'
  | 'foundry'
  | 'workflows'
  | 'city'
  | 'country'
  | 'markets';

export const APP_IDS: readonly AppId[] = [
  'map',
  'ai',
  'explorer',
  'graph',
  'investigate',
  'targeting',
  'video',
  'sim',
  'reports',
  'foundry',
  'workflows',
  'city',
  'country',
  'markets',
];

// chrome: 'globe' keeps the right inspector rail + timeline footer (apps designed
// around the shared map context); 'full' hands the app the whole band — the shell
// collapses the footer row and hides the right rail while it is active.
export const APP_META: Record<AppId, { label: string; hint: string; chrome: 'globe' | 'full' }> = {
  map: { label: 'Map', hint: 'Live geospatial COP (globe)', chrome: 'globe' },
  ai: {
    label: 'AI',
    hint: 'Analyst agent, automated watch & alerts, local models, all in one place',
    chrome: 'full',
  },
  explorer: { label: 'Explorer', hint: 'Filter / aggregate the live object store', chrome: 'globe' },
  graph: { label: 'Graph', hint: 'Link analysis + search-around', chrome: 'globe' },
  investigate: {
    label: 'Investigate',
    hint: 'Digital OSINT: domains, people, usernames, companies',
    chrome: 'globe',
  },
  targeting: { label: 'Targeting', hint: 'Kill-chain board (notional)', chrome: 'globe' },
  video: { label: 'Video', hint: 'FMV + ground recon + detections', chrome: 'globe' },
  sim: { label: 'Sim', hint: 'Browser war-game overlay', chrome: 'globe' },
  reports: { label: 'Reports', hint: 'Case files, briefs, dossiers', chrome: 'globe' },
  foundry: {
    label: 'Foundry',
    hint: 'BYO data: datasets, pipelines, builds, ontology binding',
    chrome: 'full',
  },
  workflows: {
    label: 'Workflows',
    hint: 'User-programmable analysis pipelines (Python/SQL/LLM blocks)',
    chrome: 'full',
  },
  city: {
    label: 'City 3D',
    hint: 'Gaussian-splat 3D scenes',
    chrome: 'full',
  },
  country: {
    label: 'Country',
    hint: 'World Bank + UN statistics · OSINT resources',
    chrome: 'full',
  },
  markets: {
    label: 'Markets',
    hint: 'Indices, commodities, FX, crypto · stress index · predictions',
    chrome: 'full',
  },
};

// Grouped clusters for the top-bar app switcher (design §6.1 overhaul): the
// flat segmented control got too wide once Foundry/Workflows/City landed, so
// the switcher renders these as labeled clusters instead. Order here is
// render order; every AppId must appear in exactly one group (enforced by
// appView.test.ts).
export const APP_GROUPS: readonly { id: string; label: string; apps: readonly AppId[] }[] = [
  { id: 'live', label: 'Live', apps: ['map', 'sim'] },
  { id: 'ai', label: 'AI', apps: ['ai'] },
  {
    id: 'analyze',
    label: 'Analyze',
    apps: ['explorer', 'graph', 'investigate', 'targeting', 'video', 'country', 'markets'],
  },
  { id: 'data', label: 'Data', apps: ['foundry', 'workflows'] },
  { id: 'product', label: 'Product', apps: ['reports'] },
  { id: '3d', label: '3D', apps: ['city'] },
];

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
    // Sim renders as an overlay gated by useSim.active (AppSurface returns null
    // for 'sim'), so switching to the Sim tab must open the overlay — and
    // leaving it must close it — or the tab looks dead.
    useSim.getState().setActive(app === 'sim');
  },
}));
