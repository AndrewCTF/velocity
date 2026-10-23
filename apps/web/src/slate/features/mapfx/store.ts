import { create } from "zustand";

// What the object panel and the projection action draw on the map. Read by
// MapFx (the SVG layer projected through the Cesium camera).

export interface LatLon {
  lat: number;
  lon: number;
}

/** A contact inside the ring; `id` lets its glow follow the live map icon. */
export interface RingContact extends LatLon {
  id?: string;
}

/** G17: the selection ring the DETECTED ACTIVITY count is taken inside, and
 *  a glow on each live contact within it. */
export const useRingFx = create<{
  ring: { center: LatLon; km: number; glows: RingContact[] } | null;
  set: (r: { center: LatLon; km: number; glows: RingContact[] } | null) => void;
}>((set) => ({ ring: null, set: (ring) => set({ ring }) }));

/** G26/G27: reachable-range rings and the course fan from a vessel's last real
 *  fix and reported speed and course. A "where could it be" projection, never
 *  drawn as motion (apps/web/CLAUDE.md, no synthesis on the motion path). */
export interface Projection {
  id: string;
  name: string;
  fix: LatLon;
  speedKn: number;
  cog: number | null;
}
export const useProjectFx = create<{
  p: Projection | null;
  /** Running = the progress toast is up while the rings draw outward. */
  running: boolean;
  /** Rings drawn so far (the fan follows the last ring). */
  drawn: number;
  set: (p: Projection | null) => void;
  setRunning: (r: boolean) => void;
  setDrawn: (n: number) => void;
}>((set) => ({
  p: null,
  running: false,
  drawn: 0,
  set: (p) => set({ p, drawn: 0, running: false }),
  setRunning: (running) => set({ running }),
  setDrawn: (drawn) => set({ drawn }),
}));

/** Ring hours for the reachable-range rings (the copy draws eight). */
export const RING_HOURS = [1, 2, 3, 4.5, 6, 8, 10, 12] as const;
/** The copy's ring strokes, innermost first: width and opacity. */
export const RING_STYLE: ReadonlyArray<[number, number]> = [
  [3.6, 0.9],
  [3.2, 0.85],
  [2.6, 0.75],
  [2.0, 0.65],
  [1.5, 0.55],
  [1.3, 0.48],
  [1.1, 0.42],
  [1.0, 0.37],
];
/** The course fan reaches the +6 h point and widens to +/- FAN_DEG. */
export const FAN_HOURS = 6;
export const FAN_DEG = 12;
