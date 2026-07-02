import { describe, it, expect } from 'vitest';
import { haversineKm, pointInRing } from './draw.js';

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
  });

  it('matches the London→Paris great-circle (~343 km)', () => {
    const d = haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(355);
  });

  it('1° of longitude at the equator is ~111 km', () => {
    const d = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('pointInRing', () => {
  // A 10×10 square centred on the origin.
  const square = [
    { lat: -5, lon: -5 },
    { lat: -5, lon: 5 },
    { lat: 5, lon: 5 },
    { lat: 5, lon: -5 },
  ];

  it('is true for an interior point', () => {
    expect(pointInRing({ lat: 0, lon: 0 }, square)).toBe(true);
  });

  it('is false for an exterior point', () => {
    expect(pointInRing({ lat: 0, lon: 20 }, square)).toBe(false);
    expect(pointInRing({ lat: 20, lon: 0 }, square)).toBe(false);
  });

  it('handles a concave (arrow) polygon', () => {
    const arrow = [
      { lat: 0, lon: 0 },
      { lat: 10, lon: 5 },
      { lat: 0, lon: 2 },
      { lat: -10, lon: 5 },
    ];
    expect(pointInRing({ lat: 0, lon: 1 }, arrow)).toBe(true); // inside the notch base
    expect(pointInRing({ lat: 0, lon: 4 }, arrow)).toBe(false); // in the concave gap
  });
});
