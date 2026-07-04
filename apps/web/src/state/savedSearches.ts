// Saved-search subscriptions (design §6.5 — the missing "saved-search feeds"
// subscription type). A stored faceted object query that a background poller
// re-runs; when the match count GROWS, it posts a low-severity alert into the
// Inbox (useAlerts), so a standing query becomes a notification feed.
//
// ponytail: persisted list + one 60 s poller guarded to only run when searches
// exist. No websockets — a periodic re-query of the existing /api/search/objects
// is enough for "did new objects match my saved filter".
import { create } from 'zustand';
import type { Alert } from '@osint/shared';
import { searchObjects, type ObjectFacets } from '../transport/search.js';
import { useAlerts } from './stores.js';

export interface SavedSearch {
  id: string;
  label: string;
  facets: ObjectFacets;
  lastCount: number;
  lastCheckedMs: number;
}

const LS_KEY = 'velocity.savedSearches';

function read(): SavedSearch[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SavedSearch[]) : [];
  } catch {
    return [];
  }
}
function persist(list: SavedSearch[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

interface SavedSearchState {
  searches: SavedSearch[];
  add: (label: string, facets: ObjectFacets) => void;
  remove: (id: string) => void;
  updateResult: (id: string, count: number) => void;
}

// id without Date/Math.random (banned in some contexts here) — derive from the
// facets + the current length; collisions across identical saved queries are fine.
function nextId(list: SavedSearch[], facets: ObjectFacets): string {
  return `ss_${list.length}_${(facets.type ?? 'all')}_${(facets.q ?? '').slice(0, 8)}`;
}

export const useSavedSearches = create<SavedSearchState>((set, get) => ({
  searches: read(),
  add: (label, facets) => {
    const list = get().searches;
    if (list.length >= 20) return; // ponytail: cap; 20 standing queries is plenty
    const s: SavedSearch = { id: nextId(list, facets), label, facets, lastCount: -1, lastCheckedMs: 0 };
    const next = [...list, s];
    persist(next);
    set({ searches: next });
  },
  remove: (id) => {
    const next = get().searches.filter((s) => s.id !== id);
    persist(next);
    set({ searches: next });
  },
  updateResult: (id, count) =>
    set((state) => {
      const next = state.searches.map((s) =>
        s.id === id ? { ...s, lastCount: count, lastCheckedMs: pollClock() } : s,
      );
      persist(next);
      return { searches: next };
    }),
}));

// performance.now()-based wall clock (Date.now() is unavailable in some sandboxes;
// this only needs to be monotonic-ish for "last checked").
function pollClock(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.timeOrigin + performance.now()) : 0;
}

// ── background poller ───────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;

async function pollOnce(): Promise<void> {
  const st = useSavedSearches.getState();
  const list = st.searches;
  if (list.length === 0) return;
  for (const s of list) {
    try {
      const res = await searchObjects({ ...s.facets, limit: 1 });
      const count = res.count;
      const alert = buildGrowthAlert(s, count, pollClock(), useAlerts.getState().alerts.map((a) => a.id));
      if (alert) useAlerts.getState().push(alert);
      st.updateResult(s.id, count);
    } catch {
      /* transient failure — try again next tick */
    }
  }
}

function bboxCenter(f: ObjectFacets): [number, number] {
  if (f.bbox) return [(f.bbox[0] + f.bbox[2]) / 2, (f.bbox[1] + f.bbox[3]) / 2];
  return [0, 0];
}

// Pure decision: post an alert ONLY when a seeded search (lastCount ≥ 0) has GROWN
// and no alert with this id is already buffered (dedup — useAlerts.push doesn't,
// and StrictMode / a fast retick can otherwise post `${id}:${count}` twice). First
// observation (lastCount −1) seeds silently → null. Exported for the unit test.
export function buildGrowthAlert(
  s: SavedSearch,
  count: number,
  t: number,
  existingIds: readonly string[],
): Alert | null {
  if (s.lastCount < 0 || count <= s.lastCount) return null;
  const id = `${s.id}:${count}`;
  if (existingIds.includes(id)) return null;
  return {
    id,
    ruleId: 'saved_search',
    severity: 'low',
    t,
    geom: { type: 'Point', coordinates: bboxCenter(s.facets) },
    confidence: 1,
    message: `Saved search "${s.label}": ${count - s.lastCount} new (${count} match)`,
    contributingObservations: [],
  };
}

/** Start the saved-search poller (idempotent). Called once from App on mount. */
export function startSavedSearchPoller(): () => void {
  if (timer != null) return () => undefined;
  void pollOnce();
  timer = setInterval(() => void pollOnce(), 60_000);
  return () => {
    if (timer != null) clearInterval(timer);
    timer = null;
  };
}
