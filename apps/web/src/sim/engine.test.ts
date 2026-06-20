import { describe, it, expect } from 'vitest';
import { buildPlan, sampleUnit, haversineKm, destPoint, bearingDeg } from './engine.js';
import { resolveRaid, salvoForDefender, RENDER_AGENT_CAP } from './combat.js';
import type { Scenario } from './types.js';

const KYIV = { lat: 50.45, lon: 30.52 };
const ODESA = { lat: 46.48, lon: 30.73 };

describe('geo helpers', () => {
  it('destPoint then haversine recovers the distance', () => {
    const p = destPoint(KYIV, 90, 100);
    expect(haversineKm(KYIV, p)).toBeCloseTo(100, 0);
  });
  it('bearing due north is ~0/360', () => {
    const b = bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(Math.min(b, 360 - b)).toBeLessThan(1);
  });
});

describe('buildPlan: drone-swarm', () => {
  const scenario: Scenario = {
    kind: 'drone-swarm',
    swarm: { launch: KYIV, target: ODESA, count: 10, speedKph: 185, altM: 1500, spreadKm: 8, linkKey: 'fpv_fiber' },
  };

  it('produces one link-equipped agent per drone (no static units)', () => {
    const plan = buildPlan(scenario);
    expect(plan.agents).toHaveLength(10);
    expect(plan.units).toHaveLength(0);
    expect(plan.station).toEqual(KYIV);
    expect(plan.durationSec).toBeGreaterThan(0);
    for (const a of plan.agents!) {
      expect(a.profile.type).toBe('fiber'); // linkKey honoured
      expect(a.speedMps).toBeGreaterThan(0);
      expect(a.cruiseAltM).toBe(1500);
    }
  });

  it('carries EW + nap-of-earth flags through to the plan', () => {
    const plan = buildPlan({
      ...scenario,
      napOfEarth: true,
      jammers: [{ id: 'j', lat: 48, lon: 30.6, radiusKm: 40, kind: 'gnss' }],
    });
    expect(plan.napOfEarth).toBe(true);
    expect(plan.jammers).toHaveLength(1);
  });

  it('is deterministic — same scenario yields identical dispersion', () => {
    const a = buildPlan(scenario);
    const b = buildPlan(scenario);
    expect(b.agents![0]!.launch).toEqual(a.agents![0]!.launch);
    expect(b.agents!.at(-1)!.target).toEqual(a.agents!.at(-1)!.target);
  });
});

describe('buildPlan: drone-landing', () => {
  it('descends a single unit from start altitude to the pad', () => {
    const scenario: Scenario = {
      kind: 'drone-landing',
      landing: { start: KYIV, pad: ODESA, startAltM: 2000, speedKph: 120 },
    };
    const plan = buildPlan(scenario);
    expect(plan.units).toHaveLength(1);
    const f = plan.units[0]!.fixes;
    expect(f[0]!.alt).toBe(2000);
    expect(f.at(-1)!.alt).toBe(0);
  });
});

describe('sampleUnit', () => {
  const fixes = [
    { tSec: 0, lat: 0, lon: 0, alt: 1000 },
    { tSec: 100, lat: 0, lon: 1, alt: 0 },
  ];
  it('holds the first fix before the start', () => {
    expect(sampleUnit(fixes, -5)).toMatchObject({ lat: 0, lon: 0, alt: 1000 });
  });
  it('holds the last fix after the end', () => {
    expect(sampleUnit(fixes, 999)).toMatchObject({ lon: 1, alt: 0 });
  });
  it('interpolates linearly at the midpoint', () => {
    const s = sampleUnit(fixes, 50);
    expect(s.lon).toBeCloseTo(0.5, 5);
    expect(s.alt).toBeCloseTo(500, 5);
  });
});

describe('buildPlan: attack — render cap vs math count (Bug 1)', () => {
  const attack = (attackerCount: number, defenderId = 's-400'): Scenario => ({
    kind: 'attack',
    attack: { attackerId: 'shahed-136', attackerCount, defenderId, defenderCount: 2, launch: KYIV, target: ODESA },
  });

  it('renders <=RENDER_AGENT_CAP agents but sizes impact from the TRUE count', () => {
    const big = buildPlan(attack(1000));
    // Render bound: never draw more than the cap (no synthesized extras either).
    expect(big.agents!.length).toBeLessThanOrEqual(RENDER_AGENT_CAP);
    expect(big.agents!.length).toBe(RENDER_AGENT_CAP);

    // The saturation math must reflect the full 1000-strong mass, not the 200
    // rendered. Reproduce buildAttack's resolveRaid on the true count and assert
    // the plan's impact severity/radius were derived from it.
    const sites = 2;
    const raid = resolveRaid(
      1000,
      0.6, // shahed-136 pk_est
      [{ id: 's-400', name: 'S-400', pk: 0.85, count: sites, salvoPerSite: salvoForDefender('s-400') }],
      1,
    );
    const expectedSeverity = Math.min(1, raid.leakers / 1000 + 0.15);
    const expectedRadius = Math.min(40, 2 + raid.leakers * 0.6);
    expect(big.impact!.severity).toBeCloseTo(expectedSeverity, 5);
    expect(big.impact!.radiusKm).toBeCloseTo(expectedRadius, 5);
    // 1000 attackers vs 2 S-400 sites (72 engagements) overwhelmingly leak.
    expect(raid.leakers).toBeGreaterThan(900);
  });

  it('a 1000-raid leaks far more than a 200-raid (math is not clamped at 200)', () => {
    const r200 = resolveRaid(200, 0.6, [{ id: 's-400', name: 'S-400', pk: 0.85, count: 2, salvoPerSite: salvoForDefender('s-400') }], 1);
    const r1000 = resolveRaid(1000, 0.6, [{ id: 's-400', name: 'S-400', pk: 0.85, count: 2, salvoPerSite: salvoForDefender('s-400') }], 1);
    // Same finite capacity, 5× the mass → ~5× the leakers (capacity subtracted once).
    expect(r1000.leakers).toBeGreaterThan(r200.leakers * 4);
  });

  it('small raids are rendered 1:1 (cap does not affect them)', () => {
    const small = buildPlan(attack(12));
    expect(small.agents!.length).toBe(12);
  });
});

describe('salvoForDefender (Bug 2): per-site capacity differs by defender', () => {
  it('returns the documented per-battery figure for known systems', () => {
    expect(salvoForDefender('thaad')).toBe(48);
    expect(salvoForDefender('s-400')).toBe(36);
    expect(salvoForDefender('stinger')).toBe(2);
  });

  it('falls back to a positive range-banded estimate for unknown ids', () => {
    expect(salvoForDefender('not-a-real-system')).toBeGreaterThan(0);
  });

  it('a THAAD-defended raid intercepts strictly more than a Stinger-defended one', () => {
    const thaad = resolveRaid(60, 0.6, [{ id: 'thaad', name: 'THAAD', pk: 0.85, count: 1, salvoPerSite: salvoForDefender('thaad') }], 1);
    const stinger = resolveRaid(60, 0.6, [{ id: 'stinger', name: 'Stinger', pk: 0.65, count: 1, salvoPerSite: salvoForDefender('stinger') }], 1);
    expect(thaad.intercepted).toBeGreaterThan(stinger.intercepted);
    expect(thaad.leakers).toBeLessThan(stinger.leakers);
    expect(thaad.defenseCapacity).toBe(48);
    expect(stinger.defenseCapacity).toBe(2);
  });

  it('the attack plan wires the defender salvo into defenseCapacity end-to-end', () => {
    // Single site → defenseCapacity == that defender's per-site salvo.
    const planThaad = buildPlan({
      kind: 'attack',
      attack: { attackerId: 'shahed-136', attackerCount: 100, defenderId: 'thaad', defenderCount: 1, launch: KYIV, target: ODESA },
    });
    // Re-derive the raid the engine ran to confirm capacity used the table.
    const raid = resolveRaid(100, 0.6, [{ id: 'thaad', name: 'THAAD', pk: 0.85, count: 1, salvoPerSite: salvoForDefender('thaad') }], 1);
    expect(raid.defenseCapacity).toBe(48);
    // The plan's impact must track that raid's leakers.
    expect(planThaad.impact!.radiusKm).toBeCloseTo(Math.min(40, 2 + raid.leakers * 0.6), 5);
  });
});
