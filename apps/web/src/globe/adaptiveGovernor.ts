// Adaptive layer governor — sheds low-priority layers when frame cost is high,
// restores them when it drops. Works at the DATA SOURCE level (disable whole
// layers via the registry) because per-entity budgets don't move frame time
// (measured 2026-07-29, docs/decisions.md: entity count fell 24%, renderMs
// unchanged — cost is per collection/visualizer, not per entity).
//
// The governor tracks which layers IT shed separately from user toggles, so a
// user re-enabling a layer mid-pressure overrides the governor for that layer.

import type { LayerRegistry } from '../registry/LayerRegistry';
import { perfSnapshot } from './perf';

// ponytail: thresholds calibrated from the RAM benchmark (2026-08-08).
// 14ms = 83% of a 60Hz frame; 10ms = comfortable headroom.
const SHED_MS = 14;
const RESTORE_MS = 10;
const POLL_MS = 2000;
const CONSECUTIVE = 3;

// Shed order by group prefix. Lower = shed first. Groups not listed (aviation,
// maritime) are never shed — the ≥8000 aircraft world-view invariant and
// vessel coverage are not negotiable.
// ponytail: a flat map beats a per-layer field on the shared contract — no
// migration, no annotation of 100 descriptors.
const GROUP_SHED_ORDER: [string, number][] = [
  ['infra.', 0],
  ['places.', 0],
  ['reference.', 1],
  ['signals.', 1],
  ['rf.', 1],
  ['news.', 2],
  ['cyber.', 2],
  ['env.', 3],
  ['hazards.', 4],
  ['seismic.', 5],
  ['space.', 6],
  ['conflict.', 7],
];

function shedOrder(id: string): number | null {
  for (const [prefix, order] of GROUP_SHED_ORDER) {
    if (id.startsWith(prefix)) return order;
  }
  return null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let registry: LayerRegistry | null = null;
const shedSet = new Set<string>();
let overCount = 0;
let underCount = 0;

function tick(): void {
  if (!registry) return;
  const { frameMsEMA } = perfSnapshot();
  if (frameMsEMA <= 0) return;

  if (frameMsEMA > SHED_MS) {
    overCount++;
    underCount = 0;
    if (overCount >= CONSECUTIVE) {
      overCount = 0;
      shed();
    }
  } else if (frameMsEMA < RESTORE_MS) {
    underCount++;
    overCount = 0;
    if (underCount >= CONSECUTIVE) {
      underCount = 0;
      restore();
    }
  } else {
    overCount = 0;
    underCount = 0;
  }
}

function shed(): void {
  if (!registry) return;
  // Find the lowest-order enabled sheddable layer
  let best: { id: string; order: number } | null = null;
  for (const d of registry.list()) {
    if (!registry.isEnabled(d.id)) continue;
    if (shedSet.has(d.id)) continue;
    const order = shedOrder(d.id);
    if (order === null) continue;
    if (!best || order < best.order) best = { id: d.id, order };
  }
  if (!best) return;
  shedSet.add(best.id);
  registry.disable(best.id);
}

function restore(): void {
  if (!registry || shedSet.size === 0) return;
  // Restore the highest-order shed layer (most important of what we shed)
  let best: { id: string; order: number } | null = null;
  for (const id of shedSet) {
    const order = shedOrder(id) ?? 99;
    if (!best || order > best.order) best = { id, order };
  }
  if (!best) return;
  shedSet.delete(best.id);
  registry.enable(best.id);
}

export function startAdaptiveGovernor(reg: LayerRegistry): void {
  registry = reg;
  shedSet.clear();
  overCount = 0;
  underCount = 0;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, POLL_MS);
}

export function stopAdaptiveGovernor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Restore everything we shed
  if (registry) {
    for (const id of shedSet) {
      registry.enable(id);
    }
  }
  shedSet.clear();
  registry = null;
}

export function isGovernorShed(id: string): boolean {
  return shedSet.has(id);
}

export function governorShedCount(): number {
  return shedSet.size;
}
