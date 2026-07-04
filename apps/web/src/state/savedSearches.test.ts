import { describe, it, expect } from 'vitest';
import { buildGrowthAlert, type SavedSearch } from './savedSearches.js';

const base: SavedSearch = { id: 'ss_0_all_', label: 'all', facets: { type: 'all' }, lastCount: -1, lastCheckedMs: 0 };

describe('buildGrowthAlert', () => {
  it('seeds silently on first observation (lastCount −1)', () => {
    expect(buildGrowthAlert(base, 100, 0, [])).toBeNull();
  });

  it('posts on growth after seeding', () => {
    const a = buildGrowthAlert({ ...base, lastCount: 100 }, 137, 0, []);
    expect(a).not.toBeNull();
    expect(a?.id).toBe('ss_0_all_:137');
    expect(a?.message).toContain('37 new');
  });

  it('does not post when the count is unchanged or shrinks', () => {
    expect(buildGrowthAlert({ ...base, lastCount: 100 }, 100, 0, [])).toBeNull();
    expect(buildGrowthAlert({ ...base, lastCount: 100 }, 90, 0, [])).toBeNull();
  });

  it('dedups against an already-buffered alert id', () => {
    expect(buildGrowthAlert({ ...base, lastCount: 100 }, 137, 0, ['ss_0_all_:137'])).toBeNull();
  });
});
