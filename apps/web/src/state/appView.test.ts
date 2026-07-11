import { describe, it, expect } from 'vitest';
import { APP_IDS, APP_GROUPS, type AppId } from './appView.js';

// Grouped top-bar switcher (docs/dashboard-workflows-plan.md §1): every app
// must be reachable from exactly one cluster, and clusters must never
// reference an id the shell doesn't know about.
describe('APP_GROUPS', () => {
  it('covers every AppId exactly once', () => {
    const counts = new Map<AppId, number>();
    for (const group of APP_GROUPS) {
      for (const id of group.apps) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    for (const id of APP_IDS) {
      expect(counts.get(id)).toBe(1);
    }
    // no extra ids beyond APP_IDS, and no id counted more than once
    expect(counts.size).toBe(APP_IDS.length);
  });

  it('only references known AppIds', () => {
    const known = new Set<string>(APP_IDS);
    for (const group of APP_GROUPS) {
      for (const id of group.apps) {
        expect(known.has(id)).toBe(true);
      }
    }
  });
});
