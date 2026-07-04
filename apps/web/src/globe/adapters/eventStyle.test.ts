import { describe, it, expect } from 'vitest';
import { conflictSymbol, incidentSymbol, outageSymbol } from './eventStyle.js';

// The whole point of W3 is that an analyst reads WHAT happened from the glyph.
// Guard the dispatch: the operator's examples (bombing, shelling, clash, drone,
// jamming) must each land on a distinct, correct glyph — never the old generic
// blob. Keyword specificity ("drone strike" → drone, not strike) is the fragile
// bit, so pin it.
describe('conflictSymbol', () => {
  it('maps the operator examples to distinct glyphs', () => {
    expect(conflictSymbol('air strike on depot', '19', 3).glyph).toBe('airstrike');
    expect(conflictSymbol('heavy shelling reported', '19', 3).glyph).toBe('artillery');
    expect(conflictSymbol('armed clash near town', '19', 3).glyph).toBe('clash');
    expect(conflictSymbol('drone strike overnight', '19', 3).glyph).toBe('drone'); // drone before strike
    expect(conflictSymbol('IED detonation', '18', 1).glyph).toBe('blast');
  });

  it('falls back to CAMEO root when the label is unhelpful', () => {
    expect(conflictSymbol('event', '20', 1).glyph).toBe('blast'); // mass violence
    expect(conflictSymbol('event', '19', 1).glyph).toBe('clash');
    expect(conflictSymbol('event', '18', 1).glyph).toBe('gunfire');
    expect(conflictSymbol('event', '99', 1).glyph).toBe('clash'); // unknown root default
  });

  it('mass violence pulses and reads deep red', () => {
    const s = conflictSymbol('massacre', '20', 1);
    expect(s.pulse).toBe(true);
    expect(s.color).toBe('#dc2626');
  });
});

describe('incidentSymbol', () => {
  it('prefers narrative keyword, else the domain taxonomy', () => {
    expect(incidentSymbol(['military'], 'drone strike on port', 'high').glyph).toBe('drone');
    expect(incidentSymbol(['gps-jamming'], 'anomaly detected', 'low').glyph).toBe('jamming');
    expect(incidentSymbol(['dark-vessel'], 'vessel went dark', 'low').glyph).toBe('naval');
    expect(incidentSymbol([], 'something', 'low').glyph).toBe('incident'); // generic fallback
  });

  it('high threat pulses', () => {
    expect(incidentSymbol(['military'], 'x', 'high').pulse).toBe(true);
    expect(incidentSymbol(['military'], 'x', 'low').pulse).toBe(false);
  });
});

describe('outageSymbol', () => {
  it('is always the outage glyph, pulsing when severe', () => {
    expect(outageSymbol(80).glyph).toBe('outage');
    expect(outageSymbol(80).pulse).toBe(true);
    expect(outageSymbol(10).pulse).toBe(false);
  });
});
