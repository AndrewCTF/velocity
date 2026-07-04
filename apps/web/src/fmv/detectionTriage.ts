// FMV detection triage (design §8) — the operator confirms/dismisses AI detections
// and that feedback persists; confirmed detections accumulate into a "soak" density
// grid (the Soak Tool heatmap). The FMV feed is NOTIONAL (labelled — an exercise
// capability, like the war-game sim), so this triages notional detections; the same
// UI drives a real detector feed unchanged.
//
// ponytail: two id-sets + a coarse count grid. Feedback is session-scoped (the
// notional detection ids regenerate anyway); a real detector would key on a durable
// track id and POST the confirm/dismiss to the model-feedback endpoint.
import { create } from 'zustand';

const SOAK_CELLS = 24; // grid resolution across the frame (both axes)

function cellKey(x: number, y: number): string {
  const cx = Math.min(SOAK_CELLS - 1, Math.max(0, Math.floor(x * SOAK_CELLS)));
  const cy = Math.min(SOAK_CELLS - 1, Math.max(0, Math.floor(y * SOAK_CELLS)));
  return `${cx},${cy}`;
}

export interface SoakCell {
  cx: number;
  cy: number;
  n: number;
}

interface TriageState {
  confirmed: Set<string>;
  dismissed: Set<string>;
  soak: Map<string, number>;
  confirm: (id: string, cx: number, cy: number) => void;
  dismiss: (id: string) => void;
  reset: (id: string) => void;
  status: (id: string) => 'confirmed' | 'dismissed' | 'pending';
  soakCells: () => SoakCell[];
  clearSoak: () => void;
}

export const useDetectionTriage = create<TriageState>((set, get) => ({
  confirmed: new Set(),
  dismissed: new Set(),
  soak: new Map(),
  confirm: (id, cx, cy) =>
    set((s) => {
      const confirmed = new Set(s.confirmed).add(id);
      const dismissed = new Set(s.dismissed);
      dismissed.delete(id);
      // Accumulate the confirmed detection's bbox-centre into the soak grid.
      const soak = new Map(s.soak);
      const k = cellKey(cx, cy);
      soak.set(k, (soak.get(k) ?? 0) + 1);
      return { confirmed, dismissed, soak };
    }),
  dismiss: (id) =>
    set((s) => {
      const dismissed = new Set(s.dismissed).add(id);
      const confirmed = new Set(s.confirmed);
      confirmed.delete(id);
      return { confirmed, dismissed };
    }),
  reset: (id) =>
    set((s) => {
      const confirmed = new Set(s.confirmed);
      const dismissed = new Set(s.dismissed);
      confirmed.delete(id);
      dismissed.delete(id);
      return { confirmed, dismissed };
    }),
  status: (id) => (get().confirmed.has(id) ? 'confirmed' : get().dismissed.has(id) ? 'dismissed' : 'pending'),
  soakCells: () =>
    [...get().soak.entries()].map(([k, n]) => {
      const [cx, cy] = k.split(',').map(Number);
      return { cx: cx ?? 0, cy: cy ?? 0, n };
    }),
  clearSoak: () => set({ soak: new Map() }),
}));

export const SOAK_GRID = SOAK_CELLS;
