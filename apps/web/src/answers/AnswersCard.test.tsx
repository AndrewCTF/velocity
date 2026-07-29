import { describe, it, expect } from 'vitest';
import { lagText } from './AnswersCard.js';

// The card's whole job is to show a verdict WITH its rule and its evidence age.
// The riskiest single value is the lag, because the backend sends null to mean
// "nothing was observed" and a client that renders that as "0s old" would turn
// "we have nothing" into "perfectly current" - the exact inversion the answers
// design exists to prevent (see app/intel/answers.py).

describe('lagText', () => {
  it('never renders a missing lag as fresh', () => {
    expect(lagText(null)).toBe('no evidence recorded');
    expect(lagText(null)).not.toContain('0');
  });

  it('coarsens with magnitude', () => {
    expect(lagText(5)).toBe('5s old');
    expect(lagText(90)).toBe('1m old');
    expect(lagText(7200)).toBe('2h old');
    expect(lagText(172_800)).toBe('2d old');
  });

  it('never renders a negative age', () => {
    expect(lagText(-5)).toBe('0s old');
  });
});
