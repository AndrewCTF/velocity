// Guards for the map-quality preset table. A failure means a preset regressed
// into a non-monotonic or invariant-violating state — fix qualityPresets.ts.
import { describe, expect, it } from 'vitest';
import { MAP_QUALITIES, presetKnobs, type MapQuality } from './qualityPresets';

describe('map quality presets', () => {
  it('resolves knobs for every quality (and legacy/undefined → high)', () => {
    for (const q of MAP_QUALITIES) expect(presetKnobs(q)).toBeDefined();
    const high = presetKnobs('high');
    expect(presetKnobs(undefined)).toEqual(high);
    expect(presetKnobs('legacy' as MapQuality)).toEqual(high);
  });

  it('is monotonic: lighter presets never render heavier', () => {
    const h = presetKnobs('high');
    const b = presetKnobs('balanced');
    const p = presetKnobs('performance');
    // Fewer pixels / entities as quality drops.
    expect(b.pixelCap).toBeLessThanOrEqual(h.pixelCap);
    expect(p.pixelCap).toBeLessThanOrEqual(b.pixelCap);
    expect(b.vesselCap).toBeLessThanOrEqual(h.vesselCap);
    expect(p.vesselCap).toBeLessThanOrEqual(b.vesselCap);
    expect(b.maxSats).toBeLessThanOrEqual(h.maxSats);
    expect(p.maxSats).toBeLessThanOrEqual(b.maxSats);
    expect(p.layerCap).toBeLessThanOrEqual(b.layerCap);
    // Coarser screen-space error (fewer tiles) as quality drops.
    expect(b.idleSSE).toBeGreaterThanOrEqual(h.idleSSE);
    expect(p.idleSSE).toBeGreaterThanOrEqual(b.idleSSE);
    expect(b.motionSSE).toBeGreaterThanOrEqual(h.motionSSE);
    expect(p.motionSSE).toBeGreaterThanOrEqual(b.motionSSE);
  });

  it("'high' reproduces today's hardcoded defaults (no-op default)", () => {
    const h = presetKnobs('high');
    expect(h.pixelCap).toBe(2.0); // renderPixelCap default
    expect(h.idleSSE).toBe(2.0); // GlobeCanvas IDLE_SSE
    expect(h.motionSSE).toBe(3.2); // GlobeCanvas MOTION_SSE
    expect(h.vesselCap).toBe(6000); // VESSEL_WORLD_CAP
    expect(h.maxSats).toBe(4000); // SatelliteAdapter desktop MAX_SATS
    expect(h.layerCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('exposes no aircraft cap — desktop aircraft world view stays >= 8000', () => {
    // The knob interface intentionally has NO aircraft field. layerCap applies
    // to non-aircraft layers only (see qualityPresets.ts + PollGeoJsonAdapter).
    // This documents the operator invariant so a future edit that adds an
    // aircraft cap here trips the review.
    for (const q of MAP_QUALITIES) {
      expect(presetKnobs(q)).not.toHaveProperty('aircraftCap');
    }
  });
});
