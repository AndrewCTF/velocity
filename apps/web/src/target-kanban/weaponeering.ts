// Weaponeering solutions (Gotham target-detail "Weaponeering solutions" parity).
//
// Given a target, rank candidate effectors from the open-source system catalog
// (apps/web/src/sim/catalog.ts) and, for each, estimate the count needed to reach
// a desired probability of effect from the system's single-shot Pk. This is a
// NOTIONAL, open-source analytical estimate — NOT a real JMEM / weaponeering
// product. The UI labels it as such.

import { CATALOG, type CatalogItem, type SystemCategory } from '../sim/catalog.js';

export interface WeaponeeringSolution {
  system: CatalogItem;
  pk: number; // single-shot probability of kill estimate (0..1), from the catalog
  count: number; // recommended effectors to reach `desiredPe`
  pe: number; // achieved probability of effect with `count` shots (0..1)
  costUsd: number; // count * unit cost when known (0 if unknown)
  recommended: boolean; // top-ranked solution
}

// Effector classes by target type. Air targets are engaged by air defence (SAM);
// surface/ground/sea targets by strike systems. A deliberate, legible mapping —
// the catalog carries no full target-effectiveness matrix.
const AIR_EFFECTORS: SystemCategory[] = ['sam'];
const SURFACE_EFFECTORS: SystemCategory[] = ['loitering_munition', 'drone', 'fighter'];

function isAirTarget(kind?: string, entityId?: string): boolean {
  const k = (kind ?? '').toLowerCase();
  if (k.includes('aircraft') || k.includes('air')) return true;
  return (entityId ?? '').startsWith('aircraft:');
}

// Smallest n with 1-(1-pk)^n >= desiredPe. Guards pk<=0 (never effective) and
// pk>=1 (one shot). Clamped so a near-zero pk can't return a runaway count.
export function roundsForEffect(pk: number, desiredPe = 0.9): number {
  if (pk >= 1) return 1;
  if (pk <= 0) return 99;
  const n = Math.ceil(Math.log(1 - desiredPe) / Math.log(1 - pk));
  return Math.min(99, Math.max(1, n));
}

export function probabilityOfEffect(pk: number, count: number): number {
  if (pk <= 0 || count <= 0) return 0;
  return 1 - Math.pow(1 - Math.min(pk, 1), count);
}

export function weaponeeringSolutions(
  opts: { kind?: string | undefined; entityId?: string | undefined; desiredPe?: number } = {},
): WeaponeeringSolution[] {
  const desiredPe = opts.desiredPe ?? 0.9;
  const cats = isAirTarget(opts.kind, opts.entityId) ? AIR_EFFECTORS : SURFACE_EFFECTORS;
  const sols = CATALOG.filter(
    (c) => cats.includes(c.category) && (c.specs.pk_est ?? 0) > 0,
  ).map((system): WeaponeeringSolution => {
    const pk = system.specs.pk_est ?? 0;
    const count = roundsForEffect(pk, desiredPe);
    return {
      system,
      pk,
      count,
      pe: probabilityOfEffect(pk, count),
      costUsd: (system.specs.cost_usd ?? 0) * count,
      recommended: false,
    };
  });
  // Rank: highest single-shot Pk first, then cheapest path to effect.
  sols.sort((a, b) => b.pk - a.pk || a.costUsd - b.costUsd);
  if (sols.length > 0) sols[0]!.recommended = true;
  return sols;
}
