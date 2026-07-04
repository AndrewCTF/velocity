import { describe, it, expect, beforeEach } from 'vitest';
import { useInvestigation } from './investigationStore.js';

describe('graph history revisions', () => {
  beforeEach(() => {
    useInvestigation.getState().clear();
  });

  it('records revisions with author + timestamp', () => {
    useInvestigation.getState().record({ kind: 'root', label: 'seed a', nodeIds: ['a'] });
    useInvestigation.getState().record({ kind: 'expand', label: 'expand a (+2)', nodeIds: ['a', 'b', 'c'] });
    const revs = useInvestigation.getState().revisions;
    expect(revs).toHaveLength(2);
    expect(revs[1]!.nodeIds).toEqual(['a', 'b', 'c']);
    expect(revs[0]!.author).toBe('operator');
    expect(revs[0]!.ts).toBeGreaterThan(0);
  });

  it('scrub pointer set + cleared, and clear() wipes history', () => {
    useInvestigation.getState().record({ kind: 'root', label: 'seed', nodeIds: ['a'] });
    useInvestigation.getState().setViewRev(0);
    expect(useInvestigation.getState().viewRev).toBe(0);
    useInvestigation.getState().setViewRev(null);
    expect(useInvestigation.getState().viewRev).toBeNull();
    useInvestigation.getState().clear();
    expect(useInvestigation.getState().revisions).toHaveLength(0);
  });

  it('caps revisions at 200 (drop oldest)', () => {
    for (let i = 0; i < 210; i++) {
      useInvestigation.getState().record({ kind: 'expand', label: `r${i}`, nodeIds: ['a'] });
    }
    const revs = useInvestigation.getState().revisions;
    expect(revs).toHaveLength(200);
    expect(revs[0]!.label).toBe('r10');
  });
});
