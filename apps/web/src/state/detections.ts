// Imagery-CV detections store — the geo-referenced YOLO detections returned by
// GET /api/imagery/detect for an AOI. Client-only, in-memory (unlike captures,
// these are a transient analysis result, not a persistent observation). Rendered
// on the globe by globe/DetectLayer.ts as a static, upsert-by-id point layer.
import { create } from 'zustand';

export interface Detection {
  id: string; // `detect:<layer>:<date>:<i>`
  lat: number;
  lon: number;
  cls: string;
  conf: number;
  source: string;
  date: string;
}

interface DetectState {
  detections: Detection[];
  note: string; // honest status when imagery / sidecar unavailable
  pending: boolean;
  /** Replace the current detection set (one AOI run). */
  set: (dets: Detection[], note?: string) => void;
  setPending: (v: boolean) => void;
  clear: () => void;
}

export const useDetections = create<DetectState>((set) => ({
  detections: [],
  note: '',
  pending: false,
  set: (dets, note = '') => set({ detections: dets, note, pending: false }),
  setPending: (v) => set({ pending: v }),
  clear: () => set({ detections: [], note: '', pending: false }),
}));

// Feature shape returned by /api/imagery/detect.
interface DetectFeature {
  id: string;
  geometry: { coordinates: [number, number] };
  properties: { cls?: string; conf?: number; source?: string; date?: string };
}

/** Map a detect FeatureCollection into store Detection records. */
export function featuresToDetections(features: DetectFeature[]): Detection[] {
  return features.map((f) => ({
    id: f.id,
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    cls: f.properties.cls ?? 'object',
    conf: f.properties.conf ?? 0,
    source: f.properties.source ?? 'yolo',
    date: f.properties.date ?? '',
  }));
}
