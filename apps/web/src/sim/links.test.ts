import { describe, it, expect } from 'vitest';
import { PROFILES, evaluateLink } from './links.js';
import { ewAt, NO_EW } from './ew.js';
import { lineMasked } from './terrain.js';

describe('evaluateLink', () => {
  it('RF FPV is nominal in range with clear LOS and no EW', () => {
    const r = evaluateLink(PROFILES.fpv_rf!, 5, true, NO_EW);
    expect(r.state).toBe('nominal');
  });

  it('RF FPV is LOST when comms-jammed', () => {
    const r = evaluateLink(PROFILES.fpv_rf!, 5, true, { commsCut: true, gnssDenied: false });
    expect(r.state).toBe('lost');
  });

  it('RF FPV is LOST when terrain masks the line of sight', () => {
    const r = evaluateLink(PROFILES.fpv_rf!, 5, false, NO_EW);
    expect(r.state).toBe('lost');
  });

  it('fiber FPV is IMMUNE to comms jamming (within tether)', () => {
    const r = evaluateLink(PROFILES.fpv_fiber!, 15, false, { commsCut: true, gnssDenied: false });
    expect(r.state).toBe('nominal'); // unjammable + LOS not required
  });

  it('fiber FPV is LOST beyond the ~20 km tether', () => {
    const r = evaluateLink(PROFILES.fpv_fiber!, 25, false, NO_EW);
    expect(r.state).toBe('lost');
  });

  it('one-way-attack drone has no comms link to cut, but GPS jamming degrades it', () => {
    const clean = evaluateLink(PROFILES.owa_ins!, 999, false, { commsCut: true, gnssDenied: false });
    expect(clean.state).toBe('nominal'); // comms jam irrelevant
    const jammed = evaluateLink(PROFILES.owa_ins!, 999, false, { commsCut: true, gnssDenied: true });
    expect(jammed.state).toBe('degraded');
    expect(jammed.gnssDenied).toBe(true);
  });
});

describe('ewAt', () => {
  const comms = { id: 'c', lat: 0, lon: 0, radiusKm: 50, kind: 'comms' as const };
  const gnss = { id: 'g', lat: 0, lon: 0, radiusKm: 50, kind: 'gnss' as const };

  it('comms jammer cuts comms only, inside its radius', () => {
    expect(ewAt(0, 0, [comms])).toEqual({ commsCut: true, gnssDenied: false });
  });
  it('GNSS jammer denies GPS only', () => {
    expect(ewAt(0, 0, [gnss])).toEqual({ commsCut: false, gnssDenied: true });
  });
  it('no effect outside the radius', () => {
    expect(ewAt(10, 10, [comms, gnss])).toEqual(NO_EW);
  });
});

describe('lineMasked (terrain masking)', () => {
  it('a ridge above the sight line blocks it', () => {
    // flat 100 m endpoints, a 400 m peak in the middle
    expect(lineMasked(100, 100, [120, 400, 120])).toBe(true);
  });
  it('clear when the ground stays below the line', () => {
    expect(lineMasked(1000, 1000, [100, 200, 150])).toBe(false);
  });
});
