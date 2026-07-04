// Which dashboard shell renders at "/" — the dense "Professional" COP (default,
// the original App) or the approachable "Normal" console. Persisted so the
// operator's choice survives reloads. The map/globe stack is identical between
// them; only the surrounding chrome differs.
import { create } from 'zustand';

export type DashboardMode = 'normal' | 'professional';

const LS_KEY = 'velocity.dashboardMode';

function readMode(): DashboardMode {
  try {
    // Professional is the default; only an explicit 'normal' opts out.
    return localStorage.getItem(LS_KEY) === 'normal' ? 'normal' : 'professional';
  } catch {
    return 'professional';
  }
}

function persist(mode: DashboardMode): void {
  try {
    localStorage.setItem(LS_KEY, mode);
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}

interface DashboardModeState {
  mode: DashboardMode;
  setMode: (m: DashboardMode) => void;
  toggle: () => void;
}

export const useDashboardMode = create<DashboardModeState>((set) => ({
  mode: readMode(),
  setMode: (mode) => {
    persist(mode);
    set({ mode });
  },
  toggle: () =>
    set((s) => {
      const mode: DashboardMode = s.mode === 'normal' ? 'professional' : 'normal';
      persist(mode);
      return { mode };
    }),
}));
