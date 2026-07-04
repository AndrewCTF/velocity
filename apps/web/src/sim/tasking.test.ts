import { describe, it, expect } from 'vitest';
import { passesOverAoi, skyView, coverageStats, type Window } from './tasking.js';

// Same known-good ISS TLE used by SatelliteAdapter.orbit.test.ts. Mean motion
// 15.51 rev/day → ~93 min period, 51.6° inclination. Over a 6h window an ISS
// orbit makes multiple passes near any observer within its inclination band.
const ISS_L1 = '1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992';
const ISS_L2 = '2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442';

// Mid-latitude observer (Madrid-ish, ~40.4N) — comfortably inside the ISS
// inclination band, so passes are guaranteed over 6h. Near the TLE epoch
// (2019-06-05) to keep SGP4 accurate.
const AOI = { lat: 40.4, lon: -3.7, altM: 600 };
const WIN: Window = {
  startMs: Date.UTC(2019, 5, 5, 12, 0, 0),
  endMs: Date.UTC(2019, 5, 5, 18, 0, 0), // +6h
};

describe('passesOverAoi', () => {
  it('finds at least one pass over a mid-latitude AOI in 6h', () => {
    const passes = passesOverAoi(ISS_L1, ISS_L2, AOI, WIN, 30, 10);
    expect(passes.length).toBeGreaterThanOrEqual(1);
  });

  it('each pass has a physically plausible max elevation (0 < el <= 90)', () => {
    const passes = passesOverAoi(ISS_L1, ISS_L2, AOI, WIN, 30, 10);
    for (const p of passes) {
      expect(p.maxElevDeg).toBeGreaterThan(0);
      expect(p.maxElevDeg).toBeLessThanOrEqual(90);
      expect(p.durationS).toBeGreaterThan(0);
      expect(p.endMs).toBeGreaterThanOrEqual(p.startMs);
    }
  });

  it('returns no passes for a garbage TLE instead of throwing', () => {
    expect(passesOverAoi('not', 'a tle', AOI, WIN)).toEqual([]);
  });
});

describe('skyView', () => {
  it('produces az/el samples above the horizon within the window', () => {
    const sky = skyView(ISS_L1, ISS_L2, AOI, WIN, 30);
    expect(sky.length).toBeGreaterThan(0);
    for (const s of sky) {
      expect(s.elDeg).toBeGreaterThanOrEqual(0);
      expect(s.elDeg).toBeLessThanOrEqual(90);
      expect(s.azDeg).toBeGreaterThanOrEqual(0);
      expect(s.azDeg).toBeLessThan(360);
    }
  });
});

describe('coverageStats', () => {
  it('reports finite, bounded stats for real passes', () => {
    const passes = passesOverAoi(ISS_L1, ISS_L2, AOI, WIN, 30, 10);
    const stats = coverageStats(passes, WIN);
    expect(Number.isFinite(stats.passCount)).toBe(true);
    expect(Number.isFinite(stats.avgRevisitMin)).toBe(true);
    expect(Number.isFinite(stats.maxGapMin)).toBe(true);
    expect(Number.isFinite(stats.coveragePct)).toBe(true);
    expect(stats.coveragePct).toBeGreaterThanOrEqual(0);
    expect(stats.coveragePct).toBeLessThanOrEqual(100);
    expect(stats.passCount).toBe(passes.length);
  });

  it('returns a full-window gap and zero coverage for no passes', () => {
    const stats = coverageStats([], WIN);
    expect(stats.passCount).toBe(0);
    expect(stats.coveragePct).toBe(0);
    expect(stats.maxGapMin).toBeCloseTo(360, 0); // 6h window
  });
});
