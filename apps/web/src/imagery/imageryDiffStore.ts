import { create } from 'zustand';

// Floating before/after imagery-diff popup state. Opened from the map context
// menu ("Imagery diff here") with a clicked AOI; the inline <ImageryDiff> is also
// reused directly in the Situation Media tab.

interface ImageryDiffState {
  open: boolean;
  aoi: { lat: number; lon: number } | null;
  openAt: (aoi: { lat: number; lon: number }) => void;
  close: () => void;
}

export const useImageryDiff = create<ImageryDiffState>((set) => ({
  open: false,
  aoi: null,
  openAt: (aoi) => set({ open: true, aoi }),
  close: () => set({ open: false }),
}));
