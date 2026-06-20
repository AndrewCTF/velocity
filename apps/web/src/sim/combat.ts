// Deterministic combat model for the war-game sim. Two public, well-understood
// methods, parameterised from the open-source catalog:
//
//  1. Saturation air-defence leakage — layered interception with finite salvo
//     capacity, so a large enough raid saturates the defence and leaks. Used for
//     drone/missile raids vs SAM.
//  2. Lanchester square law — classic force-on-force attrition for ground combat.
//
// Outputs are EXPECTED values (analyst estimates), not Monte-Carlo draws, so the
// result is reproducible and explainable. The AI reasoning layer (/api/sim/reason)
// turns these numbers into a narrative; it does not compute them.

import { getSystem } from './catalog.js';

// Max number of attacker agents the SimController renders as billboards. This is
// a PERFORMANCE bound on the icon count, NOT a cap on the math: a raid of 1000
// renders 200 real agents but resolveRaid still runs on the true 1000 so the
// leak/saturation reflects the full attacking mass. We never synthesize extra
// agents — we draw a representative real subset.
export const RENDER_AGENT_CAP = 200;

// Simultaneous engagements a single site/battery can run before it saturates.
// Open-source per-battery figures keyed by catalog id (see each system's notes):
//   s-400      — "engage up to 36 targets" simultaneously
//   thaad      — 6 TEL × 8 ready rounds = 48 interceptors at a battery
//   patriot/samp-t/iris-t — ~16 missiles in flight per battery
//   s-300/buk/nasams — ~12 engagement channels
//   iron-dome  — multi-launcher battery, ~20 simultaneous Tamir intercepts
//   pantsir    — point-defence: 4 simultaneous (12 missiles + guns)
//   avenger    — quad-pack Stinger launcher → 4
//   stinger    — MANPADS team → ~2
// Falls back to a range-banded estimate for any id not listed.
const SALVO_BY_ID: Record<string, number> = {
  thaad: 48,
  's-400': 36,
  's-300': 12,
  'samp-t': 16,
  'patriot-pac3': 16,
  'buk-m3': 12,
  nasams: 12,
  'iris-t-slm': 12,
  'iron-dome': 20,
  'pantsir-s1': 4,
  avenger: 4,
  stinger: 2,
};

// Per-site simultaneous-engagement capacity for a defender catalog id. The
// catalog carries no structured magazine field, so use an explicit table with a
// range-banded fallback (longer-range strategic SAMs field more channels).
export function salvoForDefender(id: string): number {
  const direct = SALVO_BY_ID[id];
  if (direct != null) return direct;
  const range = getSystem(id)?.specs.range_km ?? 0;
  if (range >= 150) return 24;
  if (range >= 60) return 12;
  if (range >= 20) return 6;
  return 3;
}

export interface DefenseLayer {
  id: string;
  name: string;
  /** single-shot intercept probability (0..1) */
  pk: number;
  /** number of batteries/sites */
  count: number;
  /** simultaneous engagements per site before it saturates */
  salvoPerSite: number;
}

export interface RaidResult {
  attackerCount: number;
  intercepted: number;
  leakers: number;
  /** expected successful strikes on the target (leakers × attacker hit prob) */
  damageUnits: number;
  leakRatePct: number;
  interceptRatePct: number;
  defenseCapacity: number;
}

// Layered interception. Each layer engages up to its capacity (count × salvo);
// anything beyond capacity passes through unengaged (saturation). Engaged
// attackers are intercepted at the layer's pk; survivors flow to the next layer.
export function resolveRaid(
  attackerCount: number,
  attackerPk: number,
  defenses: DefenseLayer[],
  coverFactor = 1,
): RaidResult {
  const n = Math.max(0, Math.floor(attackerCount));
  let surviving = n;
  let intercepted = 0;
  let capacity = 0;
  // coverFactor < 1 models terrain masking / nap-of-earth flight degrading the
  // defender's effective single-shot kill probability.
  const cover = clamp01(coverFactor);
  for (const d of defenses) {
    const cap = Math.max(0, d.count) * Math.max(0, d.salvoPerSite);
    capacity += cap;
    const engaged = Math.min(surviving, cap);
    const hit = engaged * clamp01(d.pk) * cover;
    intercepted += hit;
    surviving -= hit;
  }
  const leakers = Math.max(0, surviving);
  const damageUnits = leakers * clamp01(attackerPk);
  return {
    attackerCount: n,
    intercepted: round1(intercepted),
    leakers: round1(leakers),
    damageUnits: round1(damageUnits),
    leakRatePct: n > 0 ? round1((leakers / n) * 100) : 0,
    interceptRatePct: n > 0 ? round1((intercepted / n) * 100) : 0,
    defenseCapacity: capacity,
  };
}

export interface LanchesterResult {
  winner: 'red' | 'blue' | 'draw';
  redSurvivors: number;
  blueSurvivors: number;
  steps: number;
}

// Lanchester's square law: dRed/dt = -bluePower·blue, dBlue/dt = -redPower·red.
// Stepwise Euler integration until one side is eliminated (or maxSteps). Power
// terms fold in per-unit effectiveness (e.g. catalog pk_est).
export function lanchesterSquare(
  red0: number,
  blue0: number,
  redPower: number,
  bluePower: number,
  dt = 0.02,
  maxSteps = 5000,
): LanchesterResult {
  let red = Math.max(0, red0);
  let blue = Math.max(0, blue0);
  let steps = 0;
  while (red > 0.5 && blue > 0.5 && steps < maxSteps) {
    const dRed = bluePower * blue * dt;
    const dBlue = redPower * red * dt;
    red = Math.max(0, red - dRed);
    blue = Math.max(0, blue - dBlue);
    steps++;
  }
  const winner: 'red' | 'blue' | 'draw' =
    red > 0.5 && blue <= 0.5 ? 'red' : blue > 0.5 && red <= 0.5 ? 'blue' : 'draw';
  return { winner, redSurvivors: round1(red), blueSurvivors: round1(blue), steps };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
