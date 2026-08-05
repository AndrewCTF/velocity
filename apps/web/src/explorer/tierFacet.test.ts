import { describe, it, expect } from 'vitest';
import {
  buildHistograms,
  bucketLabel,
  deriveFacets,
  entityPassesFilter,
  newFacetTally,
  tallyFacets,
  tallyTier,
} from './facets.js';

// Provenance as a cross-filter facet. It is the one facet that describes the
// SOURCE rather than the object, and that difference is where it goes wrong.

describe('the provenance facet', () => {
  it('reads only the four declared tiers, and nothing else', () => {
    expect(deriveFacets({ kind: 'vessel', tier: 'sensor' }).tier).toBe('sensor');
    expect(deriveFacets({ kind: 'vessel', tier: 'claim' }).tier).toBe('claim');
    // An unknown tier is not a tier. Bucketing it as `sensor` would be the
    // laundering the whole model exists to prevent.
    expect(deriveFacets({ kind: 'vessel', tier: 'probably-fine' }).tier).toBeNull();
    expect(deriveFacets({ kind: 'vessel' }).tier).toBeNull();
    expect(deriveFacets({ kind: 'vessel', tier: 7 }).tier).toBeNull();
  });

  it('counts contacts the object facets never see', () => {
    // The defect this guards, twice over: the object tally gates on
    // aircraft/vessel, AND the walk skips any entity with an empty property bag,
    // which is every billboard-only feature. The GDELT conflict layer is exactly
    // that — 452 entities on screen, none of them counted — so the one histogram
    // that exists to expose claim-tier sources could not see the only claim-tier
    // source that was on. The tier comes from the DataSource, not the bag.
    const t = newFacetTally();
    tallyTier(t, 'sensor');
    tallyFacets(t, { kind: 'vessel', mmsi: 123456789 });
    tallyTier(t, 'claim');
    tallyTier(t, 'claim');
    expect(t.tier.get('sensor')).toBe(1);
    expect(t.tier.get('claim')).toBe(2);
    // ...while the object facets still ignore the scenery.
    expect(t.counted).toBe(1);
  });

  it('ignores an absent tier rather than bucketing it', () => {
    const t = newFacetTally();
    tallyTier(t, undefined);
    tallyTier(t, null);
    expect(t.tier.size).toBe(0);
  });

  it('orders the buckets by trust, not by count', () => {
    const t = newFacetTally();
    tallyTier(t, 'claim');
    tallyTier(t, 'claim');
    tallyTier(t, 'sensor');
    const h = buildHistograms(t).find((x) => x.facet === 'tier');
    expect(h?.buckets.map((b) => b.value)).toEqual(['sensor', 'claim']);
    expect(h?.buckets[0]?.label).toBe('T0 · Sensor');
    expect(bucketLabel('tier', 'filing')).toBe('T2 · Filing');
  });

  it('filters the map the same way any other facet does', () => {
    const only = [{ facet: 'tier' as const, value: 'sensor', mode: 'only' as const }];
    expect(entityPassesFilter({ kind: 'vessel', tier: 'sensor', mmsi: 1 }, only)).toBe(true);
    expect(entityPassesFilter({ kind: 'vessel', tier: 'claim', mmsi: 1 }, only)).toBe(false);
    // A contact with no tier cannot satisfy an "only sensor" clause: unknown
    // provenance is not sensor provenance.
    expect(entityPassesFilter({ kind: 'vessel', mmsi: 1 }, only)).toBe(false);
  });
});
