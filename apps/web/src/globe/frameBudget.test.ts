import { describe, it, expect } from 'vitest';
import { frameBudgetRemaining, recordFrameSpend } from './frameBudget.js';

// The cooperative per-frame budget keys on the rAF timestamp: callbacks sharing a
// frame share a stamp and so share the ledger; a new stamp resets it. These are
// the invariants the pan-stutter fix relies on.
describe('frameBudget', () => {
  it('starts each new frame with the full budget', () => {
    const full = frameBudgetRemaining(1000);
    expect(full).toBeGreaterThan(0);
    // A different stamp = a new frame = ledger reset back to the same full budget.
    expect(frameBudgetRemaining(2000)).toBe(full);
  });

  it('subtracts spend within the same frame and floors at zero', () => {
    const stamp = 3000;
    const full = frameBudgetRemaining(stamp);
    recordFrameSpend(stamp, 4);
    expect(frameBudgetRemaining(stamp)).toBe(full - 4);
    // Overspending never goes negative.
    recordFrameSpend(stamp, full); // far more than what's left
    expect(frameBudgetRemaining(stamp)).toBe(0);
  });

  it('ignores spend charged against a stale (already-rolled-over) frame', () => {
    const full = frameBudgetRemaining(4000);
    // Roll to a new frame, then try to charge the OLD stamp — must be ignored.
    frameBudgetRemaining(5000);
    recordFrameSpend(4000, 8);
    expect(frameBudgetRemaining(5000)).toBe(full);
  });
});
