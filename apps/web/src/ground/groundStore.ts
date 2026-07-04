// Ground-recon AOI store — the shared contract between the right-click context
// menu / AOI selector (producers) and GroundReconPanel (consumer), mirroring
// useChip. Holds the active AOI, the nearby ground photos, and the desktop-CUDA
// detections per photo. One AOI at a time.

import { create } from 'zustand';
import type { GroundDetection, GroundPhotoFeature } from './types.js';

export interface GroundAoi {
  lat: number;
  lon: number;
  radiusKm: number;
}

interface GroundState {
  aoi: GroundAoi | null;
  photos: GroundPhotoFeature[];
  loading: boolean;
  error: string | null;
  note: string | null;
  selectedId: string | null;
  detections: Record<string, GroundDetection[]>;
  /** Bumped by openAt(); App.tsx uses it to bring the Ground tab forward
   *  (mirrors investigation.openSeq). refresh() does NOT bump it. */
  openSeq: number;
  /** Bumped by openAt() AND refresh(); the fetch effect depends on it. */
  fetchSeq: number;
  openAt: (aoi: GroundAoi) => void;
  refresh: () => void;
  clear: () => void;
  setPhotos: (photos: GroundPhotoFeature[], note: string | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  select: (id: string | null) => void;
  setDetections: (id: string, dets: GroundDetection[]) => void;
}

export const useGround = create<GroundState>((set) => ({
  aoi: null,
  photos: [],
  loading: false,
  error: null,
  note: null,
  selectedId: null,
  detections: {},
  openSeq: 0,
  fetchSeq: 0,
  openAt: (aoi) =>
    set((s) => ({
      aoi,
      photos: [],
      selectedId: null,
      detections: {},
      error: null,
      note: null,
      loading: true,
      openSeq: s.openSeq + 1,
      fetchSeq: s.fetchSeq + 1,
    })),
  refresh: () => set((s) => ({ fetchSeq: s.fetchSeq + 1, loading: true, error: null })),
  clear: () =>
    set({ aoi: null, photos: [], selectedId: null, detections: {}, error: null, note: null, loading: false }),
  setPhotos: (photos, note) => set({ photos, note, loading: false }),
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e, loading: false }),
  select: (id) => set({ selectedId: id }),
  setDetections: (id, dets) =>
    set((s) => ({ detections: { ...s.detections, [id]: dets } })),
}));

if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useGround: typeof useGround }).__useGround = useGround;
}
