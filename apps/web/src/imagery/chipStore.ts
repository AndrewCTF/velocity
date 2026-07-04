// Focused-imagery "chip" focus — the tiny shared contract between the
// EntityPanel ("Load imagery here" button, the producer) and ChipLayer (the
// Cesium drape, the consumer). Deliberately a Zustand store, not local React
// state, because the producer (a card deep in the right-rail panel tree) and
// the consumer (a globe-side layer mounted next to the Cesium viewer) live in
// different subtrees and must not be parent/child-coupled.
//
// One focus at a time. `setFocus` replaces it; `clear` drops the drape.
//   - entityId: the selected entity the chip is framed on (a sim drone/swarm,
//     an aircraft, or a vessel). ChipLayer looks this entity up in the viewer
//     to (a) classify it (a `sim-swarm` roll-up re-derives its live AOI from
//     the entity's own ellipse + centroid) and (b) track drift for re-framing.
//   - lat/lon: the focus centre at the moment the button was pressed. Used as
//     the AOI centre for a normal entity; for a swarm it's only a seed (the
//     live centroid wins).
//   - radiusKm: AOI half-extent. EntityPanel passes 4 (a ~8 km box); the chip
//     endpoint clamps to [0.1, 100].

import { create } from 'zustand';

export interface ChipFocus {
  entityId: string | null;
  lat: number;
  lon: number;
  radiusKm: number;
}

interface ChipState {
  focus: ChipFocus | null;
  setFocus: (f: ChipFocus) => void;
  clear: () => void;
}

export const useChip = create<ChipState>((set) => ({
  focus: null,
  setFocus: (f) => set({ focus: f }),
  clear: () => set({ focus: null }),
}));

// DEV-only handle for debugging/introspection (mirrors __useSelection).
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useChip: typeof useChip }).__useChip = useChip;
}
