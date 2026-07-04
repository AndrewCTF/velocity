import { describe, it, expect } from 'vitest';
import { destinationPoint, haversineKm, reachableRing } from './projection.js';

describe('projection great-circle math', () => {
  it('destinationPoint lands ~distKm away at the right bearing', () => {
    // 100 km due north from the equator → ~0.9° lat, same lon.
    const p = destinationPoint(0, 0, 0, 100);
    expect(p.lon).toBeCloseTo(0, 5);
    expect(haversineKm(0, 0, p.lat, p.lon)).toBeCloseTo(100, 1);
  });

  it('reachableRing points are all ~radiusKm from centre', () => {
    const flat = reachableRing(26.5, 56.3, 200, 24);
    for (let i = 0; i < flat.length; i += 2) {
      const d = haversineKm(26.5, 56.3, flat[i + 1]!, flat[i]!);
      expect(d).toBeCloseTo(200, 0);
    }
  });
});
