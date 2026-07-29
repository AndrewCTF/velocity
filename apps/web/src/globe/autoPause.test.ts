import { describe, it, expect } from 'vitest';
import { dedupeMarks, markCrossed, type PauseMark } from './autoPause.js';

// Auto-pause is what separates a scrub from a briefing: the replay stops AT the
// moments that matter instead of making you find them (Palantir's "Auto pause
// at", docs/palantir-reference-2026-07.md §11.2).
//
// The rule has to survive a fast clock. At 3600x one frame advances the replay
// by a minute, so equality never fires and a "within N seconds" window fires on
// every frame. Crossing detection is the primitive these tests pin.

const m = (t: number, label = 'e'): PauseMark => ({ t, label });

describe('markCrossed', () => {
  it('fires when the interval contains a mark', () => {
    expect(markCrossed(100, 200, [m(150)])?.t).toBe(150);
  });

  it('does not fire when the interval misses it', () => {
    expect(markCrossed(100, 140, [m(150)])).toBeNull();
    expect(markCrossed(160, 200, [m(150)])).toBeNull();
  });

  it('fires exactly once across consecutive ticks', () => {
    // Half-open (prev, now]: the tick that reaches the mark fires, the next
    // starts after it. Firing twice would freeze the replay on one event.
    expect(markCrossed(100, 150, [m(150)])?.t).toBe(150);
    expect(markCrossed(150, 200, [m(150)])).toBeNull();
  });

  it('survives a very fast clock, where a tick spans minutes', () => {
    expect(markCrossed(0, 3600, [m(1800)])?.t).toBe(1800);
  });

  it('stops at the FIRST mark reached when a jump spans several', () => {
    // Skipping past two events to land on a third is how a briefing loses its
    // middle.
    expect(markCrossed(0, 1000, [m(800), m(200), m(500)])?.t).toBe(200);
  });

  it('is direction-aware, so scrubbing backwards also stops', () => {
    const hit = markCrossed(1000, 0, [m(200), m(800)]);
    expect(hit?.t).toBe(800); // the first one reached going backwards
  });

  it('ignores a still clock and non-finite input', () => {
    expect(markCrossed(100, 100, [m(100)])).toBeNull();
    expect(markCrossed(Number.NaN, 100, [m(50)])).toBeNull();
    expect(markCrossed(0, Number.POSITIVE_INFINITY, [m(50)])).toBeNull();
  });

  it('is safe with no marks', () => {
    expect(markCrossed(0, 100, [])).toBeNull();
  });
});

describe('dedupeMarks', () => {
  it('collapses a burst into one moment', () => {
    // Nine correlated alerts in eight seconds is one event. Stopping nine times
    // makes the operator switch the feature off, which is worse than not having it.
    const burst = [m(100), m(102), m(105), m(108)];
    expect(dedupeMarks(burst, 30)).toHaveLength(1);
  });

  it('keeps genuinely separate moments', () => {
    expect(dedupeMarks([m(100), m(400), m(900)], 30)).toHaveLength(3);
  });

  it('sorts and drops non-finite marks', () => {
    const out = dedupeMarks([m(500), m(100), { t: Number.NaN, label: 'x' }], 30);
    expect(out.map((x) => x.t)).toEqual([100, 500]);
  });
});
