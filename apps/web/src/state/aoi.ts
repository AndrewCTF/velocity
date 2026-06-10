import { create } from 'zustand';
import type { Chokepoint } from '../registry/chokepoints.js';

interface AoiState {
  active: Chokepoint | null;
  setActive: (c: Chokepoint | null) => void;
}

export const useAoi = create<AoiState>((set) => ({
  active: null,
  setActive: (c) => set({ active: c }),
}));
