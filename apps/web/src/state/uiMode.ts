// UI workspace mode — which analytical surface is open over the globe.
//
// Tasking / Targeting / FMV are full WORKSPACES, not peer context tabs. They're
// invoked from the command bar (like the 3D/SIM toggles) and take over a large
// surface: Targeting as a full-width bottom dock, Tasking as a left instrument
// dock, FMV as a centered sensor window. The right rail keeps the four CONTEXT
// tabs (Selection/Alerts/Intel/News). One mode at a time; null = none.
import { create } from 'zustand';

export type UiMode = 'tasking' | 'targeting' | 'fmv' | 'cop' | null;

interface UiModeState {
  mode: UiMode;
  setMode: (m: UiMode) => void;
  toggle: (m: NonNullable<UiMode>) => void;
}

export const useUiMode = create<UiModeState>((set) => ({
  mode: null,
  setMode: (mode) => set({ mode }),
  toggle: (m) => set((s) => ({ mode: s.mode === m ? null : m })),
}));
