// The console's colour scheme. Applied as `data-theme` on <html>; every scheme
// is a complete token override in theme/tokens.css, so the whole chrome flips
// while the Cesium globe canvas (not token-coloured) is unaffected. Persisted so
// the operator's choice survives reloads.
//
// This used to be a two-value light/dark flag. It is now the scheme id from
// theme/schemes.ts — `dark` and `light` keep their names, so a persisted value
// written by the old store still resolves.
import { create } from 'zustand';

import { isSchemeId, SCHEMES, type SchemeId } from '../theme/schemes.js';

/** @deprecated The old two-value name. Kept as an alias so callers that only
 *  care that this is "the theme" do not have to churn. */
export type ThemeMode = SchemeId;

const LS_KEY = 'velocity.theme';

function read(): SchemeId {
  try {
    const v = localStorage.getItem(LS_KEY);
    return isSchemeId(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(mode: SchemeId): void {
  try {
    document.documentElement.dataset.theme = mode;
  } catch {
    /* no document (tests/SSR) */
  }
}

function persist(mode: SchemeId): void {
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
  mode: SchemeId;
  setMode: (m: SchemeId) => void;
  /** Steps to the next scheme in the list. Bound to the View menu's cycle item
   *  so a scheme can be sampled without opening a picker. */
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
      const i = SCHEMES.findIndex((x) => x.id === s.mode);
      const next = SCHEMES[(i + 1) % SCHEMES.length];
      // Non-null by construction: SCHEMES is never empty.
      const mode = (next as (typeof SCHEMES)[number]).id;
      persist(mode);
      apply(mode);
      return { mode };
    }),
}));
