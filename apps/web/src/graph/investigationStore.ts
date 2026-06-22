// Investigation-graph focus — the small shared contract between the producer
// (the EntityPanel "Search around" button, deep in the right-rail tree) and the
// consumers (the InvestigationCanvas that draws the graph, and App.tsx which
// flips the right rail to the Investigation tab). A dedicated Zustand store, not
// local React state and NOT state/stores.ts, because the producer and the
// consumers live in sibling subtrees that must not be parent/child-coupled —
// exactly the rationale chipStore.ts documents for the focused-imagery chip.
//
//   - rootId: the canonical entity id the graph is currently centred on
//     (aircraft:<icao24> / vessel:<mmsi> / incident:<uuid> / sim:<id> / …). The
//     canvas seeds its first /api/ontology/search-around fetch from this.
//   - openSeq: bumped every time "Search around" is pressed. App.tsx watches it
//     to bring the Investigation tab forward; re-pressing the SAME entity still
//     re-opens the tab (the id alone wouldn't change), which is why this is a
//     monotonic counter rather than a boolean.

import { create } from 'zustand';

interface InvestigationState {
  rootId: string | null;
  openSeq: number;
  // Centre the graph on `id` AND request the Investigation tab be brought
  // forward (bumps openSeq). Called by the EntityPanel button.
  searchAround: (id: string) => void;
  // Centre the graph on `id` WITHOUT requesting a tab switch — used by in-canvas
  // navigation (e.g. "make this node the new root") so it doesn't fight the tab.
  setRoot: (id: string) => void;
  clear: () => void;
}

export const useInvestigation = create<InvestigationState>((set) => ({
  rootId: null,
  openSeq: 0,
  searchAround: (id) => set((s) => ({ rootId: id, openSeq: s.openSeq + 1 })),
  setRoot: (id) => set({ rootId: id }),
  clear: () => set({ rootId: null }),
}));

// DEV-only handle for debugging/introspection (mirrors __useSelection / __useChip).
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useInvestigation: typeof useInvestigation }).__useInvestigation =
    useInvestigation;
}
