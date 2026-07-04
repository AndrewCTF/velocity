// Geo search-around scope (design §6.4) — a radius around a map point that the
// Explorer app filters its object query to. Set from the map right-click menu
// ("Search objects nearby"); the app switches to Explorer and scopes the live
// object search to the circle. seq bumps on each set so listeners (App → switch
// to Explorer) fire even when the same point is re-picked.
import { create } from 'zustand';

export interface GeoScope {
  lat: number;
  lon: number;
  radiusKm: number;
  label?: string;
}

interface GeoScopeState {
  scope: GeoScope | null;
  seq: number;
  setScope: (s: GeoScope | null) => void;
}

export const useGeoScope = create<GeoScopeState>((set) => ({
  scope: null,
  seq: 0,
  setScope: (scope) => set((s) => ({ scope, seq: s.seq + 1 })),
}));

// DEV handle for live verification (mirrors __useSelection).
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useGeoScope: typeof useGeoScope }).__useGeoScope = useGeoScope;
}
