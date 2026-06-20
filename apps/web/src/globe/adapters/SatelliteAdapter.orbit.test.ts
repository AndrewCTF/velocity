import { describe, it, expect } from 'vitest';
import { twoline2satrec } from 'satellite.js';
import { sampleOrbit } from './SatelliteAdapter.js';

// Known-good ISS TLE (satellite.js README example). Mean motion 15.51 rev/day →
// ~93 min period → ~410 km altitude.
const ISS_L1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const ISS_L2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';

// Near the TLE epoch (2019-06-05) so SGP4 stays accurate.
const START_MS = Date.UTC(2019, 5, 5, 12, 0, 0);

function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

describe('sampleOrbit', () => {
  const rec = twoline2satrec(ISS_L1, ISS_L2);

  it('returns window/step + 1 samples for a healthy satellite', () => {
    const samples = sampleOrbit(rec, START_MS, 60, 600); // 10 steps → 11 fixes
    expect(samples.length).toBe(11);
  });

  it('reports altitude in METERS (~410 km, catches a km/m unit regression)', () => {
    const [first] = sampleOrbit(rec, START_MS, 60, 60);
    expect(first).toBeDefined();
    expect(first!.alt).toBeGreaterThan(380_000);
    expect(first!.alt).toBeLessThan(460_000);
  });

  it('actually moves between samples (real orbital motion)', () => {
    const samples = sampleOrbit(rec, START_MS, 60, 120);
    expect(samples.length).toBeGreaterThanOrEqual(2);
    // ISS ground speed ~7.6 km/s → ~456 km per 60 s step.
    expect(haversineKm(samples[0]!, samples[1]!)).toBeGreaterThan(50);
  });
});
