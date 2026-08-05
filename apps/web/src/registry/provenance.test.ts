import { describe, it, expect } from 'vitest';
import { defaultLayers } from './defaults.js';
import { LAYER_TIERS, TIER_ORDER, TIER_META, tierOf } from './provenance.js';

describe('provenance tiers', () => {
  it('covers every registered layer, with nothing left over', () => {
    const registered = new Set(defaultLayers.map((l) => l.id));
    const tagged = new Set(Object.keys(LAYER_TIERS));
    const untagged = [...registered].filter((id) => !tagged.has(id));
    const orphan = [...tagged].filter((id) => !registered.has(id));
    expect(untagged, 'layers with no provenance tier').toEqual([]);
    expect(orphan, 'tier entries naming no registered layer').toEqual([]);
  });

  it('only uses declared tiers, and every tier has copy', () => {
    for (const [id, tier] of Object.entries(LAYER_TIERS)) {
      expect(TIER_ORDER, `${id} has an unknown tier`).toContain(tier);
      expect(TIER_META[tier].label).toBeTruthy();
      expect(TIER_META[tier].blurb).toBeTruthy();
    }
  });

  it('never turns a claim on by default', () => {
    const onByDefault = defaultLayers.filter((l) => l.visibleByDefault).map((l) => l.id);
    const claims = onByDefault.filter((id) => tierOf(id) === 'claim');
    expect(claims, 'claim-tier layers are off by default').toEqual([]);
  });

  it('keeps sensor as the majority of the registry', () => {
    // Not decoration: if this ever inverts, the product has drifted back into
    // being a news reader with a map attached.
    const counts = Object.values(LAYER_TIERS).reduce<Record<string, number>>((a, t) => {
      a[t] = (a[t] ?? 0) + 1;
      return a;
    }, {});
    expect((counts['sensor'] ?? 0) + (counts['registry'] ?? 0)).toBeGreaterThan(
      (counts['claim'] ?? 0) * 3,
    );
  });
});
