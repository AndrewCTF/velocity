import { describe, it, expect } from 'vitest';
import {
  FRESH_POS_S,
  agoText,
  isStale,
  positionAgeS,
  staleLabelSuffix,
  withStaleness,
} from './freshness.js';

describe('positionAgeS', () => {
  it('reads a numeric age', () => {
    expect(positionAgeS({ seen_pos_s: 42 })).toBe(42);
  });

  it('returns null rather than guessing when the feed did not say', () => {
    // An unknown age is not evidence of staleness. Defaulting to 0 would be the
    // same lie the backend fix removed, in the other direction.
    expect(positionAgeS({})).toBeNull();
    expect(positionAgeS({ seen_pos_s: 'soon' })).toBeNull();
    expect(positionAgeS({ seen_pos_s: Number.NaN })).toBeNull();
    expect(positionAgeS({ seen_pos_s: -1 })).toBeNull();
  });
});

describe('isStale', () => {
  it('trusts the backend verdict over the local threshold', () => {
    // The backend knows which tier served the fix and what its refresh interval
    // means; a cached tier can be legitimately older than FRESH_POS_S.
    expect(isStale({ stale: false, seen_pos_s: 9999 })).toBe(false);
    expect(isStale({ stale: true, seen_pos_s: 1 })).toBe(true);
  });

  it('falls back to the age threshold when no verdict is present', () => {
    expect(isStale({ seen_pos_s: FRESH_POS_S + 1 })).toBe(true);
    expect(isStale({ seen_pos_s: FRESH_POS_S - 1 })).toBe(false);
  });

  it('treats an unknown age as live', () => {
    expect(isStale({})).toBe(false);
  });
});

describe('agoText', () => {
  it('coarsens with magnitude', () => {
    expect(agoText(5)).toBe('5s');
    expect(agoText(59)).toBe('59s');
    expect(agoText(60)).toBe('1m');
    expect(agoText(3599)).toBe('59m');
    expect(agoText(3600)).toBe('1h');
    expect(agoText(6 * 3600)).toBe('6h');
    expect(agoText(86_400)).toBe('1d');
  });

  it('never renders a negative age', () => {
    expect(agoText(-10)).toBe('0s');
  });
});

describe('label suffix', () => {
  it('is absent for a live contact', () => {
    expect(staleLabelSuffix({ seen_pos_s: 3 })).toBeNull();
    expect(withStaleness('DAL123', { seen_pos_s: 3 })).toBe('DAL123');
  });

  it('names the real age for a stale contact', () => {
    expect(withStaleness('DAL123', { stale: true, seen_pos_s: 6 * 3600 })).toBe(
      'DAL123 · 6h ago',
    );
  });

  it('separates with the middot, never an em dash', () => {
    // docs/decisions.md#dashboard-copy-one-voice-no-em-dashes-2026-07-15
    const label = withStaleness('DAL123', { stale: true, seen_pos_s: 300 }) ?? '';
    expect(label).toContain(' · ');
    expect(label).not.toContain('—');
    expect(label).not.toContain('–');
  });

  it('passes a null identifier through unchanged', () => {
    expect(withStaleness(null, { stale: true, seen_pos_s: 300 })).toBeNull();
  });
});
