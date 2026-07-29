import { describe, it, expect } from 'vitest';
import { stepSpeed } from './Timeline.js';

// The replay transport was the operator's first reported defect ("the control
// for replay is really hard and unintuitive, I cannot drag select move and
// control easily"). The pointer gestures themselves are not asserted here:
// synthetic drag in jsdom does not reproduce real pointer capture, and a test
// that passes on a fake gesture would be worse than no test. What IS pinned is
// the pure stepping the keyboard bindings depend on.

describe('stepSpeed', () => {
  it('walks the ladder in both directions', () => {
    expect(stepSpeed(1, 1)).toBe(10);
    expect(stepSpeed(10, 1)).toBe(60);
    expect(stepSpeed(60, -1)).toBe(10);
    expect(stepSpeed(10, -1)).toBe(1);
  });

  it('clamps at both ends rather than wrapping', () => {
    // Wrapping from 3600x back to 1x on one keypress is the kind of surprise
    // that makes a transport feel broken.
    expect(stepSpeed(1, -1)).toBe(1);
    expect(stepSpeed(3600, 1)).toBe(3600);
  });

  it('recovers from a speed that is not on the ladder', () => {
    // Never return undefined into setMultiplier, whatever the store holds.
    expect(stepSpeed(42, 1)).toBe(10);
    expect(stepSpeed(42, -1)).toBe(1);
    expect(Number.isFinite(stepSpeed(Number.NaN, 1))).toBe(true);
  });
});
