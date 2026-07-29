import { describe, it, expect } from 'vitest';
import { degradedText } from './DegradedBanner.js';

// The wording IS the feature. A blank layer that is really a config problem was
// the biggest single complaint on the highest-scoring launch in this space
// (docs/research-last30days-2026-07-29.md §5.1), and the fix is only worth
// anything if the sentence says what is affected AND that nothing is broken.

const p = (capability: string) => ({ capability, state: 'not-configured', detail: 'd', fix: 'K=...' });

describe('degradedText', () => {
  it('says nothing when nothing is unconfigured', () => {
    expect(degradedText([])).toBeNull();
  });

  it('names the capability when there are few', () => {
    expect(degradedText([p('OpenSky authenticated breadth')])).toContain(
      'OpenSky authenticated breadth',
    );
    expect(degradedText([p('A'), p('B')])).toContain('A and B');
  });

  it('counts them when naming them would run off the line', () => {
    const t = degradedText([p('A'), p('B'), p('C')]) ?? '';
    expect(t).toContain('3 optional sources');
    expect(t).not.toContain('A and B');
  });

  it('always says the console still runs', () => {
    // Everything reported here is optional. A line that reads as a fault would
    // be lying about the severity, which is its own kind of failing silently.
    const t = degradedText([p('A')]) ?? '';
    expect(t).toContain('runs without them');
  });

  it('never reads as an error', () => {
    const t = (degradedText([p('A')]) ?? '').toLowerCase();
    for (const word of ['error', 'failed', 'broken', 'warning']) {
      expect(t).not.toContain(word);
    }
  });
});
