// Right-side globe toolbar state (design §6.1 grammar) — the active map tool and
// the live readouts the tools produce. One tool active at a time; 'pan' is the
// resting state (normal globe navigation + click-to-select). The measure/area
// tools drive the shared DrawController (globe/draw.ts) and publish their result
// here so the floating toolbar can show a live distance / bounds readout without
// prop-drilling. Mirrors the geoScope / annotations store pattern.
import { create } from 'zustand';

export type MapTool = 'pan' | 'measure' | 'area' | 'annotate' | 'move';

export interface MeasureResult {
  /** Cumulative great-circle length of the drawn polyline, kilometres. */
  distanceKm: number;
  /** Vertices placed so far (live count). */
  points: number;
  /** True while still drawing (cursor segment included), false once committed. */
  live: boolean;
}

export interface AreaResult {
  north: number;
  south: number;
  east: number;
  west: number;
  /** Approximate area of the box, square kilometres. */
  areaKm2: number;
  /** Box centre — feeds "search objects here". */
  center: { lat: number; lon: number };
  /** Half-diagonal in km — the radius used when scoping a nearby search. */
  radiusKm: number;
}

interface MapToolsState {
  tool: MapTool;
  setTool: (t: MapTool) => void;
  measure: MeasureResult | null;
  setMeasure: (m: MeasureResult | null) => void;
  area: AreaResult | null;
  setArea: (a: AreaResult | null) => void;
}

export const useMapTools = create<MapToolsState>((set) => ({
  tool: 'pan',
  setTool: (tool) => set({ tool }),
  measure: null,
  setMeasure: (measure) => set({ measure }),
  area: null,
  setArea: (area) => set({ area }),
}));

// DEV handle for live verification (mirrors __useSelection / __useGeoScope).
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useMapTools: typeof useMapTools }).__useMapTools = useMapTools;
}
