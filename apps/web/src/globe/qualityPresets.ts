// Map quality presets — one operator control (High / Balanced / Performance)
// that bundles every existing perf lever so a weak GPU (including a weak DESKTOP
// GPU, which the coarse isMobileDevice() heuristic never catches) can be dialed
// down without touching render machinery. This module is the SINGLE source of
// truth for the concrete knob values; GlobeCanvas + the adapters read it so a
// preset change is applied identically everywhere.
//
// What each knob does:
//  - pixelCap    → the MAX device-pixel multiplier the globe renders at (drives
//                  viewer.resolutionScale in GlobeCanvas). Lower = fewer pixels
//                  to fill = higher FPS, softer image. Mirrors renderPixelCap.
//  - idleSSE     → globe.maximumScreenSpaceError when the camera is still. HIGHER
//                  = coarser terrain/imagery = fewer tiles fetched + drawn (a real
//                  bandwidth + fill-rate win, not just resolution).
//  - motionSSE   → the same, applied WHILE the camera moves (already coarsened;
//                  the preset raises the floor further on weak GPUs).
//  - vesselCap   → world-view vessel decimation ceiling (stable djb2 subset).
//  - maxSats     → satellite count ceiling (per-sat SGP4 + billboard is heavy).
//  - layerCap    → generic per-layer render ceiling applied to NON-aircraft
//                  layers on DESKTOP under the Performance preset. Infinity = no
//                  cap. See the aircraft carve-out below.
//
// AIRCRAFT ARE DELIBERATELY EXEMPT from layerCap on desktop: the operator
// invariant requires the desktop world view to carry >= 8000 aircraft
// (CLAUDE.md, tests/test_invariants.py OSINT_LIVE_PROBE). Presets decimate
// vessels/satellites/other layers instead; a desktop that still can't cope with
// >= 8000 aircraft is exactly the case the low-end 2D suggestion targets. The
// separately-sanctioned mobile 2000 cap still applies on top of any preset.

export type MapQuality = 'high' | 'balanced' | 'performance';

export interface QualityKnobs {
  /** Max device-pixel multiplier (resolutionScale cap). */
  pixelCap: number;
  /** globe.maximumScreenSpaceError when the camera is still. */
  idleSSE: number;
  /** globe.maximumScreenSpaceError while the camera moves. */
  motionSSE: number;
  /** World-view vessel decimation ceiling. */
  vesselCap: number;
  /** Satellite count ceiling (before the mobile clamp). */
  maxSats: number;
  /** Per-layer render ceiling for NON-aircraft layers on desktop. Infinity = off. */
  layerCap: number;
}

// 'high' reproduces today's exact behavior so the default is a no-op change:
// pixelCap 2.0 (renderPixelCap default), idle SSE 2.0 / motion 3.2 (GlobeCanvas),
// vessel 6000 (VESSEL_WORLD_CAP), sats 4000 (SatelliteAdapter), no layer cap.
const PRESETS: Record<MapQuality, QualityKnobs> = {
  high: {
    pixelCap: 2.0,
    idleSSE: 2.0,
    motionSSE: 3.2,
    vesselCap: 6000,
    maxSats: 4000,
    layerCap: Number.POSITIVE_INFINITY,
  },
  balanced: {
    pixelCap: 1.5,
    idleSSE: 2.6,
    motionSSE: 3.6,
    vesselCap: 4000,
    maxSats: 2500,
    layerCap: Number.POSITIVE_INFINITY,
  },
  performance: {
    pixelCap: 1.0,
    idleSSE: 3.5,
    motionSSE: 4.5,
    vesselCap: 2000,
    maxSats: 1200,
    layerCap: 4000,
  },
};

/** Concrete knob values for a preset. Unknown/legacy values fall back to 'high'. */
export function presetKnobs(q: MapQuality | undefined | null): QualityKnobs {
  return PRESETS[(q ?? 'high') as MapQuality] ?? PRESETS.high;
}

export const MAP_QUALITIES: MapQuality[] = ['high', 'balanced', 'performance'];

export const QUALITY_LABELS: Record<MapQuality, { label: string; hint: string }> = {
  high: { label: 'High', hint: 'Sharpest — native pixels, full detail' },
  balanced: { label: 'Balanced', hint: 'Smoother — trims resolution & tiles' },
  performance: { label: 'Performance', hint: 'Fastest — for low-end GPUs' },
};
