import { describe, it, expect } from 'vitest';
import { resolveRaid, lanchesterSquare, type DefenseLayer } from './combat.js';

describe('resolveRaid', () => {
  it('with no defences, every striker leaks', () => {
    const r = resolveRaid(20, 0.5, []);
    expect(r.leakers).toBe(20);
    expect(r.intercepted).toBe(0);
    expect(r.leakRatePct).toBe(100);
    expect(r.damageUnits).toBe(10); // 20 leakers × 0.5 hit prob
  });

  it('a small high-pk defence intercepts within capacity', () => {
    const def: DefenseLayer = { id: 'p', name: 'P', pk: 0.8, count: 1, salvoPerSite: 4 };
    const r = resolveRaid(4, 0.6, [def]);
    // capacity 4, all engaged, 0.8 intercept → 3.2 intercepted, 0.8 leak
    expect(r.defenseCapacity).toBe(4);
    expect(r.intercepted).toBeCloseTo(3.2, 1);
    expect(r.leakers).toBeCloseTo(0.8, 1);
  });

  it('saturation: a large raid overwhelms finite capacity', () => {
    const def: DefenseLayer = { id: 's', name: 'S', pk: 0.9, count: 1, salvoPerSite: 4 };
    const r = resolveRaid(40, 0.6, [def]);
    // only 4 engaged (3.6 killed); 36 pass unengaged + 0.4 survivors
    expect(r.leakers).toBeGreaterThan(35);
    expect(r.leakRatePct).toBeGreaterThan(85);
  });
});

describe('lanchesterSquare', () => {
  it('the numerically + qualitatively superior force wins', () => {
    const res = lanchesterSquare(100, 50, 1, 1);
    expect(res.winner).toBe('red');
    expect(res.redSurvivors).toBeGreaterThan(0);
    expect(res.blueSurvivors).toBeLessThanOrEqual(0.5);
  });

  it('equal forces and power roughly annihilate (draw)', () => {
    const res = lanchesterSquare(50, 50, 1, 1);
    expect(res.winner).toBe('draw');
  });
});
