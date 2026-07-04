// Captures store — every YOLO detection "capture" (a public-cam frame or a
// ground-pano) becomes a persistent, dedup'd map observation. Client-only,
// localStorage-persisted (same spirit as annotations), rendered on the globe by
// globe/CaptureLayer.ts as a static, upsert-by-id point layer (very cheap).
//
// Dedup: the id is derived from source+srcId, so re-detecting the SAME cam/pano
// UPDATES its one entity (fresh counts + time) instead of piling up. Capped so
// localStorage + the entity set stay bounded.
import { create } from 'zustand';
import type { GroundDetection } from '../ground/types.js';

export interface Capture {
  id: string; // `capture:<source>:<srcId>`
  source: 'cam' | 'pano';
  srcId: string;
  camId?: string; // live re-fetch thumbnail (cam snapshot proxy)
  photoUrl?: string; // ground-pano proxied image url
  lat: number;
  lon: number;
  label: string; // human name (cam/pano name)
  dets: GroundDetection[];
  capturedAt: number; // epoch ms
}

const LS_KEY = 'velocity.captures';
const CAP = 200; // ponytail: LRU-ish cap; bump + switch to PrimitiveEntityLayer if this ever needs thousands

function read(): Capture[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const list = raw ? (JSON.parse(raw) as Capture[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(list: Capture[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode — in-memory only */
  }
}

interface CaptureState {
  captures: Capture[];
  /** Upsert a capture (dedup by source+srcId). Returns the entity id. */
  pin: (c: Omit<Capture, 'id' | 'capturedAt'> & { capturedAt?: number }) => string;
  remove: (id: string) => void;
  clear: () => void;
}

export const useCaptures = create<CaptureState>((set) => ({
  captures: read(),
  pin: (c) => {
    const id = `capture:${c.source}:${c.srcId}`;
    const capturedAt = c.capturedAt ?? Date.now();
    set((s) => {
      // move-to-end upsert so the newest stays inside the LRU cap
      const rest = s.captures.filter((x) => x.id !== id);
      const next = [...rest, { ...c, id, capturedAt }].slice(-CAP);
      persist(next);
      return { captures: next };
    });
    return id;
  },
  remove: (id) =>
    set((s) => {
      const next = s.captures.filter((x) => x.id !== id);
      persist(next);
      return { captures: next };
    }),
  clear: () => {
    persist([]);
    return set({ captures: [] });
  },
}));
