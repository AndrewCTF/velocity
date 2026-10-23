import { create } from "zustand";

// What the open situation puts in front of the map: the contacts it links
// (they keep their labels under Slate's quiet labelling) and its items as
// Gantt rows for the time dock. Published by slate/SlateSituations from the
// situations API; read by the globe's label gate and by TimeDock. Plus the
// contact under the pointer, which also earns a label.

export interface SituationRow {
  id: string;
  label: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms, or null when the item states no window (drawn as a tick). */
  end: number | null;
}

interface FocusState {
  linked: ReadonlySet<string>;
  rows: readonly SituationRow[];
  /** Epoch ms the Gantt's hour 0 is measured from (the situation's creation). */
  origin: number | null;
  hoverId: string | null;
  /** The action row the analyst picked (filled on the Gantt, outlined card). */
  pick: string | null;
  setPick: (id: string | null) => void;
  setSituation: (
    linked: ReadonlySet<string>,
    rows: readonly SituationRow[],
    origin: number | null,
  ) => void;
  setHover: (id: string | null) => void;
}

export const useSituationFocus = create<FocusState>((set) => ({
  linked: new Set(),
  rows: [],
  origin: null,
  hoverId: null,
  pick: null,
  setPick: (id) => set({ pick: id }),
  setSituation: (linked, rows, origin) => set({ linked, rows, origin }),
  setHover: (id) => set((s) => (s.hoverId === id ? s : { hoverId: id })),
}));
