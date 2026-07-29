import { describe, it, expect } from 'vitest';
import { countGaps, coverageSummary } from './CoverageStrip.js';

// A coverage strip exists to say what you DID NOT record. Zero-count hours used
// to render as nothing at all, which is visually identical to the strip's own
// background, so a period we were down looked the same as a period with no bar.
// That lets an operator read "quiet" where the truth is "unknown", which is the
// same failure as a stale contact looking live.

const b = (t: number, count: number) => ({ t, count });

describe('countGaps', () => {
  it('counts hours with nothing recorded', () => {
    expect(countGaps([b(1, 5), b(2, 0), b(3, 7), b(4, 0)])).toBe(2);
    expect(countGaps([b(1, 5)])).toBe(0);
    expect(countGaps([])).toBe(0);
  });
});

describe('coverageSummary', () => {
  it('distinguishes not-recorded from quiet, in words', () => {
    const s = coverageSummary([b(1, 5), b(2, 0)]);
    expect(s).toContain('1 of 2 hours');
    expect(s).toContain('unknown rather than quiet');
  });

  it('says so plainly when coverage is continuous', () => {
    expect(coverageSummary([b(1, 5), b(2, 3)])).toContain('continuous');
  });

  it('handles an empty archive without implying coverage', () => {
    const s = coverageSummary([]);
    expect(s).toContain('nothing recorded');
    expect(s).not.toContain('continuous');
  });
});
