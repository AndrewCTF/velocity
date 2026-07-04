import { describe, it, expect } from 'vitest';
import {
  roundsForEffect,
  probabilityOfEffect,
  weaponeeringSolutions,
} from './weaponeering.js';

describe('roundsForEffect', () => {
  it('needs more shots as pk drops, to reach the desired Pe', () => {
    // pk=0.9 → one shot already ≥0.9; pk=0.5 → ceil(log(0.1)/log(0.5))=4
    expect(roundsForEffect(0.9, 0.9)).toBe(1);
    expect(roundsForEffect(0.5, 0.9)).toBe(4);
    expect(roundsForEffect(0.3, 0.9)).toBe(7);
  });
  it('guards degenerate pk', () => {
    expect(roundsForEffect(1, 0.9)).toBe(1);
    expect(roundsForEffect(0, 0.9)).toBe(99);
    expect(roundsForEffect(-1, 0.9)).toBe(99);
  });
  it('the recommended count actually reaches the desired Pe', () => {
    for (const pk of [0.2, 0.45, 0.6, 0.8]) {
      const n = roundsForEffect(pk, 0.9);
      expect(probabilityOfEffect(pk, n)).toBeGreaterThanOrEqual(0.9);
      expect(probabilityOfEffect(pk, n - 1)).toBeLessThan(0.9);
    }
  });
});

describe('weaponeeringSolutions', () => {
  it('ranks by Pk, marks exactly one recommended, all non-empty', () => {
    const sols = weaponeeringSolutions({ entityId: 'vessel:abc' });
    expect(sols.length).toBeGreaterThan(0);
    expect(sols.filter((s) => s.recommended)).toHaveLength(1);
    expect(sols[0]!.recommended).toBe(true);
    for (let i = 1; i < sols.length; i++) {
      expect(sols[i - 1]!.pk).toBeGreaterThanOrEqual(sols[i]!.pk);
    }
  });
  it('picks SAM effectors for an air target, strike systems otherwise', () => {
    const air = weaponeeringSolutions({ entityId: 'aircraft:abc', kind: 'aircraft' });
    expect(air.every((s) => s.system.category === 'sam')).toBe(true);

    const surface = weaponeeringSolutions({ entityId: 'sim:tank', kind: 'sim' });
    expect(surface.every((s) => s.system.category !== 'sam')).toBe(true);
    expect(surface.length).toBeGreaterThan(0);
  });
});
