// Detached / floating panels (design §6.1) — lets a docked panel (a left-rail
// flyout, the inspector, the sim controls) be popped out of its dock into a
// free-floating window the operator can drag anywhere over the globe. The store
// only tracks WHICH panels are floating and WHERE; the panel content is rendered
// by whoever owns it (LeftIconRail, App, …) so there is no content duplication.
import { create } from 'zustand';

export interface FloatingRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_RECT: FloatingRect = { x: 120, y: 96, w: 320, h: 460 };

interface FloatingState {
  /** panel id → its window rect. Presence in the map === "detached". */
  panels: Record<string, FloatingRect>;
  detach: (id: string, rect?: Partial<FloatingRect>) => void;
  redock: (id: string) => void;
  setRect: (id: string, rect: Partial<FloatingRect>) => void;
}

// Cascade fresh windows so two detached panels don't land exactly on top of each
// other. Deterministic (count-based), so it stays test-friendly.
function cascade(count: number): FloatingRect {
  const step = 28 * (count % 6);
  return { ...DEFAULT_RECT, x: DEFAULT_RECT.x + step, y: DEFAULT_RECT.y + step };
}

export const useFloatingPanels = create<FloatingState>((set) => ({
  panels: {},
  detach: (id, rect) =>
    set((s) => {
      if (s.panels[id]) return s; // already floating — no-op
      const base = cascade(Object.keys(s.panels).length);
      return { panels: { ...s.panels, [id]: { ...base, ...rect } } };
    }),
  redock: (id) =>
    set((s) => {
      if (!s.panels[id]) return s;
      const next = { ...s.panels };
      delete next[id];
      return { panels: next };
    }),
  setRect: (id, rect) =>
    set((s) => {
      const cur = s.panels[id];
      if (!cur) return s;
      return { panels: { ...s.panels, [id]: { ...cur, ...rect } } };
    }),
}));

export function isDetached(id: string): boolean {
  return Boolean(useFloatingPanels.getState().panels[id]);
}

if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useFloatingPanels: typeof useFloatingPanels }).__useFloatingPanels = useFloatingPanels;
}
