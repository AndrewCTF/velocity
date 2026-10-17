import { describe, expect, it } from 'vitest';
import { readLoad } from './adaptiveGovernor';

describe('adaptive governor load reading', () => {
  it('does not read a 60 Hz display at idle as overloaded', () => {
    // Rendering every frame at 60 Hz: the gap IS the refresh interval.
    expect(readLoad(16.7, 60, 16.7)).toBe('restore');
  });

  it('keeps the calibrated 14 ms floor on a high-refresh display', () => {
    expect(readLoad(15, 66, 6.06)).toBe('shed');
    expect(readLoad(12, 83, 6.06)).toBe('hold');
    expect(readLoad(6.1, 164, 6.06)).toBe('restore');
  });

  it('sheds a 60 Hz display that has dropped well below refresh', () => {
    expect(readLoad(40, 25, 16.7)).toBe('shed');
  });

  it('ignores a stale reading while the scene idles', () => {
    // Clock paused: a handful of on-demand renders, EMA left over from a pan.
    expect(readLoad(80, 1, 16.7)).toBe('idle');
  });
});
