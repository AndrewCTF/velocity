import { describe, it, expect } from 'vitest';
import { timeOf, fmtHeading, fmtAge, freshFrac } from './SelectionPanel.js';

// The four readouts in the Selection panel that turn a raw feed number into
// something an operator reads rather than parses. Each one exists because the
// raw form was wrong on screen: a float epoch where a time belongs, a bare "5"
// where a bearing belongs, "7057 s" where a duration belongs, and a linear age
// ramp that drew two minutes stale and two hours stale identically.

describe('Selection readouts', () => {
  it('accepts an epoch in seconds, in milliseconds, or as ISO text', () => {
    expect(timeOf(1_700_000_000)).toBe(timeOf(1_700_000_000_000));
    expect(timeOf('2026-08-02T07:14:35Z')).toBe('07:14:35 Z');
    expect(timeOf(null)).toBeNull();
    expect(timeOf('not a time')).toBeNull();
  });

  it('writes a bearing as three digits, with 360 as 000', () => {
    expect(fmtHeading(5)).toBe('005°');
    expect(fmtHeading(360)).toBe('000°');
    expect(fmtHeading(94.5)).toBe('095°');
    expect(fmtHeading(null)).toBeNull();
  });

  it('scales an age to the largest unit that still reads exactly', () => {
    expect(fmtAge(42)).toBe('42 s');
    expect(fmtAge(600)).toBe('10 min');
    expect(fmtAge(7057)).toBe('1 h 58 min');
  });

  it('drains the freshness bar monotonically, and never past its ends', () => {
    expect(freshFrac(0)).toBe(1);
    expect(freshFrac(60)).toBeGreaterThan(freshFrac(600));
    expect(freshFrac(600)).toBeGreaterThan(freshFrac(7200));
    expect(freshFrac(7200)).toBe(0);
    expect(freshFrac(999_999)).toBe(0);
  });
});
