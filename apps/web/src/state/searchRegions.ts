// Multi-region search scope (Gotham "Search Objects" A/B/C/D regions). Each of
// the four slots holds its OWN geometry — a centre + radius circle, definable by
// TYPING a coordinate/place or DRAWING on the map. The SearchObjectsSidebar unions
// the non-null circles into one bbox for the backend query, then re-filters the
// results to the exact circles client-side. Mirrors geoScope.ts's zustand style.
import { create } from 'zustand';

export type Slot = 'A' | 'B' | 'C' | 'D';

export interface Region {
  center: { lat: number; lon: number };
  radiusKm: number;
}

interface State {
  regions: Record<Slot, Region | null>;
  /** The slot a "draw" / typed-coordinate action targets. */
  active: Slot;
  setActive: (s: Slot) => void;
  setRegion: (s: Slot, r: Region | null) => void;
  clearAll: () => void;
}

export const SLOTS: readonly Slot[] = ['A', 'B', 'C', 'D'];

export const useSearchRegions = create<State>((set) => ({
  regions: { A: null, B: null, C: null, D: null },
  active: 'A',
  setActive: (active) => set({ active }),
  setRegion: (s, r) => set((st) => ({ regions: { ...st.regions, [s]: r } })),
  clearAll: () => set({ regions: { A: null, B: null, C: null, D: null } }),
}));

// DEV handle for live verification (mirrors __useGeoScope / __useSelection).
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useSearchRegions: typeof useSearchRegions }).__useSearchRegions =
    useSearchRegions;
}
