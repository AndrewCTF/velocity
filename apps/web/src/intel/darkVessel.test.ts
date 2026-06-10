import { describe, it, expect } from 'vitest';
import { DarkVesselTracker, inBbox } from './darkVessel.js';
import type { Chokepoint } from '../registry/chokepoints.js';

const hormuz: Chokepoint = {
  id: 'hormuz',
  name: 'Strait of Hormuz',
  category: 'maritime',
  region: 'Persian Gulf',
  bbox: [55.6, 25.5, 57.4, 27.2],
  center: [56.5, 26.4],
  altKm: 350,
  significance: 'test',
};

describe('inBbox', () => {
  it('correctly identifies points in a bbox', () => {
    expect(inBbox(hormuz.bbox, 56.5, 26.4)).toBe(true);
    expect(inBbox(hormuz.bbox, 56.5, 28)).toBe(false);
    expect(inBbox(hormuz.bbox, 50, 26.4)).toBe(false);
  });
});

describe('DarkVesselTracker', () => {
  it('flags vessels whose last fix is older than the gap threshold but within lookback', () => {
    const t = new DarkVesselTracker();
    const now = Date.now();
    t.observe({ mmsi: '111', lat: 26.4, lon: 56.5, t: now - 90 * 60 * 1000, name: 'GHOST' }); // 90m ago
    t.observe({ mmsi: '222', lat: 26.4, lon: 56.5, t: now - 5 * 60 * 1000, name: 'LIVE' }); // 5m ago
    const cands = t.candidates([hormuz], { now });
    expect(cands.map((c) => c.mmsi)).toEqual(['111']);
  });

  it('drops vessels outside all active AOIs', () => {
    const t = new DarkVesselTracker();
    const now = Date.now();
    t.observe({ mmsi: '111', lat: 0, lon: 0, t: now - 90 * 60 * 1000 });
    expect(t.candidates([hormuz], { now })).toEqual([]);
  });

  it('with no AOIs, returns global candidates', () => {
    const t = new DarkVesselTracker();
    const now = Date.now();
    t.observe({ mmsi: '111', lat: 0, lon: 0, t: now - 90 * 60 * 1000 });
    expect(t.candidates([], { now })).toHaveLength(1);
  });

  it('expires very old fixes via prune', () => {
    const t = new DarkVesselTracker();
    const now = Date.now();
    t.observe({ mmsi: '111', lat: 26.4, lon: 56.5, t: now - 24 * 60 * 60 * 1000 });
    t.prune(60 * 60 * 1000);
    expect(t.size()).toBe(0);
  });

  it('skips fixes that are TOO old to be candidates anymore', () => {
    const t = new DarkVesselTracker();
    const now = Date.now();
    // 6 hours ago — well past gap+lookback
    t.observe({ mmsi: '111', lat: 26.4, lon: 56.5, t: now - 6 * 60 * 60 * 1000 });
    expect(t.candidates([hormuz], { now })).toHaveLength(0);
  });
});
