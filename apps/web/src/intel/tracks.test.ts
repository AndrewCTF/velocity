import { describe, expect, it } from 'vitest';

import { tracks } from './tracks.js';

// The store is a module singleton; this file owns it exclusively.
const CAP = 40_000;

describe('tracks eviction', () => {
  it('bounds the map at the cap and evicts the stalest batch, keeping fresh rings', () => {
    // Fill to the cap with monotonically increasing observation times so
    // insertion order == staleness order.
    for (let i = 0; i < CAP; i++) {
      tracks.push(`e${i}`, { t: i * 1000, lon: 0, lat: 0, alt: 0 });
    }
    expect(tracks.size()).toBe(CAP);

    // One more NEW id triggers a batch evict, not a one-out-one-in swap.
    tracks.push('overflow', { t: CAP * 1000, lon: 0, lat: 0, alt: 0 });
    expect(tracks.size()).toBeLessThan(CAP);
    expect(tracks.size()).toBeGreaterThan(CAP * 0.85);

    // The stalest rings went first; the freshest and the newcomer survive.
    expect(tracks.points('e0')).toBe(0);
    expect(tracks.points(`e${CAP - 1}`)).toBe(1);
    expect(tracks.points('overflow')).toBe(1);
  });

  it('keeps a forced (selected-entity) ring alive through eviction when fresh', () => {
    // 'selected' has the newest fix, so a subsequent evict must not touch it.
    tracks.push('selected', { t: Date.now() + 10 ** 12, lon: 1, lat: 1, alt: 0 }, { force: true });
    const cur = tracks.size();
    for (let i = 0; i < CAP - cur + 1; i++) {
      tracks.push(`refill${i}`, { t: i * 1000, lon: 0, lat: 0, alt: 0 });
    }
    expect(tracks.points('selected')).toBe(1);
    expect(tracks.size()).toBeLessThanOrEqual(CAP);
  });
});
