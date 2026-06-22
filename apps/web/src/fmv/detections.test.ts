// Unit tests for the FMV detection projection engine.
// All tests are purely geometric / arithmetic — no Cesium, no React, no DOM.

import { describe, it, expect } from 'vitest';
import { projectDetections, classCounts, footprintRadiusKm } from './detections.js';
import type { FocalDrone, DetectionCandidate } from './detections.js';

// ── helpers ──────────────────────────────────────────────────────────────────

// Place a candidate exactly `km` north of the focal drone.
function northOf(focal: FocalDrone, km: number, id: string, cls?: DetectionCandidate['cls']): DetectionCandidate {
  // 1° latitude ≈ 111.32 km
  const dLat = km / 111.32;
  const base: DetectionCandidate = { id, lat: focal.lat + dLat, lon: focal.lon };
  if (cls !== undefined) base.cls = cls;
  return base;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('footprintRadiusKm', () => {
  it('grows linearly with altitude', () => {
    const r1 = footprintRadiusKm(1000);
    const r2 = footprintRadiusKm(2000);
    expect(r2).toBeCloseTo(r1 * 2, 5);
  });

  it('is positive for any positive altitude', () => {
    expect(footprintRadiusKm(500)).toBeGreaterThan(0);
    expect(footprintRadiusKm(5000)).toBeGreaterThan(0);
  });
});

describe('projectDetections — two inside, one outside', () => {
  // Focal drone at 1000 m alt → footprint radius ≈ 0.466 km.
  const focal: FocalDrone = { lat: 35.0, lon: 36.0, altM: 1000, heading: 0 };
  const rKm = footprintRadiusKm(1000); // ~0.466 km

  // Two candidates well within the footprint (< rKm).
  const inside1 = northOf(focal, rKm * 0.2, 'agent:1', 'drone');
  const inside2 = northOf(focal, rKm * 0.5, 'agent:2', 'vehicle');
  // One candidate beyond the footprint edge (> rKm).
  const outside = northOf(focal, rKm * 1.5, 'agent:3', 'structure');

  const dets = projectDetections(focal, [inside1, inside2, outside]);

  it('returns exactly 2 detections', () => {
    expect(dets).toHaveLength(2);
  });

  it('detected ids match the inside candidates only', () => {
    const ids = dets.map((d) => d.id).sort();
    expect(ids).toEqual(['agent:1', 'agent:2'].sort());
  });

  it('outside candidate is not detected', () => {
    expect(dets.find((d) => d.id === 'agent:3')).toBeUndefined();
  });

  it('preserves classification', () => {
    const d1 = dets.find((d) => d.id === 'agent:1');
    const d2 = dets.find((d) => d.id === 'agent:2');
    expect(d1?.cls).toBe('drone');
    expect(d2?.cls).toBe('vehicle');
  });

  it('confidence is in [0, 1] for every detection', () => {
    for (const d of dets) {
      expect(d.conf).toBeGreaterThanOrEqual(0);
      expect(d.conf).toBeLessThanOrEqual(1);
    }
  });

  it('bbox values are in [0, 1] and have positive width/height', () => {
    for (const d of dets) {
      expect(d.bbox.x).toBeGreaterThanOrEqual(0);
      expect(d.bbox.y).toBeGreaterThanOrEqual(0);
      expect(d.bbox.x + d.bbox.w).toBeLessThanOrEqual(1);
      expect(d.bbox.y + d.bbox.h).toBeLessThanOrEqual(1);
      expect(d.bbox.w).toBeGreaterThan(0);
      expect(d.bbox.h).toBeGreaterThan(0);
    }
  });

  it('closer candidate has higher confidence than farther one', () => {
    const d1 = dets.find((d) => d.id === 'agent:1')!; // 20% of r → closer to centre
    const d2 = dets.find((d) => d.id === 'agent:2')!; // 50% of r → farther
    expect(d1.conf).toBeGreaterThan(d2.conf);
  });
});

describe('classCounts', () => {
  it('correct counts for correct class breakdown', () => {
    const dets = projectDetections(
      { lat: 35, lon: 36, altM: 2000, heading: 90 },
      [
        { id: 'a', lat: 35.001, lon: 36, cls: 'vehicle' },
        { id: 'b', lat: 35.002, lon: 36, cls: 'drone' },
        { id: 'c', lat: 35.003, lon: 36, cls: 'drone' },
      ],
    );
    // All three are within footprint at 2000 m (~0.93 km radius; 0.003° lat ≈ 0.33 km)
    const counts = classCounts(dets);
    expect(counts.vehicle).toBe(1);
    expect(counts.drone).toBe(2);
    expect(counts.aircraft).toBe(0);
    expect(counts.structure).toBe(0);
  });

  it('returns zeros for empty detections', () => {
    const counts = classCounts([]);
    expect(counts).toEqual({ vehicle: 0, aircraft: 0, structure: 0, drone: 0 });
  });

  it('defaults to vehicle when cls is undefined', () => {
    const focal: FocalDrone = { lat: 0, lon: 0, altM: 5000, heading: 0 };
    // Place candidate at focal's exact position so it's definitely inside.
    const dets = projectDetections(focal, [{ id: 'x', lat: 0, lon: 0 }]);
    expect(dets).toHaveLength(1);
    expect(dets[0]!.cls).toBe('vehicle');
    expect(classCounts(dets).vehicle).toBe(1);
  });
});

describe('determinism', () => {
  it('same inputs always produce the same detections', () => {
    const focal: FocalDrone = { lat: 33.5, lon: 44.2, altM: 1500, heading: 45 };
    const candidates: DetectionCandidate[] = [
      { id: 'u1', lat: 33.502, lon: 44.202, cls: 'vehicle' },
      { id: 'u2', lat: 33.498, lon: 44.198, cls: 'aircraft' },
    ];
    const a = projectDetections(focal, candidates, 42);
    const b = projectDetections(focal, candidates, 42);
    expect(a).toEqual(b);
  });

  it('different ticks produce slightly different confidence but same ids', () => {
    const focal: FocalDrone = { lat: 33.5, lon: 44.2, altM: 1500, heading: 45 };
    const candidates: DetectionCandidate[] = [{ id: 'u1', lat: 33.502, lon: 44.202 }];
    const a = projectDetections(focal, candidates, 10);
    const b = projectDetections(focal, candidates, 200);
    // Same entity detected in both ticks.
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
    // Bboxes are stable across ticks (only shimmer changes confidence).
    expect(a[0]!.bbox).toEqual(b[0]!.bbox);
  });
});
