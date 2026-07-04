// Light / dark theme for the chrome. Applied as `data-theme` on <html>; the
// light palette is a token override scoped to the Normal dashboard's `.nrm`
// root (see theme/tokens.css), so the globe canvas and the Professional COP are
// unaffected. Persisted so the operator's choice survives reloads.
import { create } from 'zustand';

export type ThemeMode = 'dark' | 'light';

const LS_KEY = 'velocity.theme';

function read(): ThemeMode {
  try {
    return localStorage.getItem(LS_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(mode: ThemeMode): void {
  try {
    document.documentElement.dataset.theme = mode;
  } catch {
    /* no document (tests/SSR) */
  }
}

function persist(mode: ThemeMode): void {
  try {
    localStorage.setItem(LS_KEY, mode);
  } catch {
    /* storage disabled */
  }
}

// Call once at boot (main.tsx) so the persisted theme is on the root before paint.
export function applyStoredTheme(): void {
  apply(read());
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set) => ({
  mode: read(),
  setMode: (mode) => {
    persist(mode);
    apply(mode);
    set({ mode });
  },
  toggle: () =>
    set((s) => {
      const mode: ThemeMode = s.mode === 'dark' ? 'light' : 'dark';
      persist(mode);
      apply(mode);
      return { mode };
    }),
}));
