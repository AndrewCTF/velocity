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
// frameMsEMA is the gap BETWEEN renders, so it can never fall below the
// display's refresh interval. Against fixed 14 ms a 60 Hz screen (16.7 ms a
// frame) read as overloaded at idle, shed a layer every 6 s and never restored
// one. The fixed numbers stay as the floor (the calibrated behaviour on the
// 144-165 Hz panels they were measured on); a slower display scales them: shed
// below ~62 % of refresh, restore above ~83 %.
const SHED_VSYNC = 1.6;
const RESTORE_VSYNC = 1.2;
// Fewer renders than this in the last second = the clock is paused and the
// scene idles under requestRenderMode; frameMsEMA is then a stale reading of
// the last camera move, not a load signal.
const MIN_RENDERS_PER_SEC = 5;
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
let vsyncMs = 1000 / 60;

export type GovernorReading = 'shed' | 'restore' | 'hold' | 'idle';

export function readLoad(
  frameMsEMA: number,
  rendersPerSec: number,
  refreshMs: number,
): GovernorReading {
  if (frameMsEMA <= 0 || rendersPerSec < MIN_RENDERS_PER_SEC) return 'idle';
  if (frameMsEMA > Math.max(SHED_MS, refreshMs * SHED_VSYNC)) return 'shed';
  if (frameMsEMA < Math.max(RESTORE_MS, refreshMs * RESTORE_VSYNC)) return 'restore';
  return 'hold';
}

// Median of 30 animation-frame gaps. Hidden tab = no rAF = keep the 60 Hz default.
function measureVsync(): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const gaps: number[] = [];
  let last = 0;
  const step = (t: number): void => {
    if (last > 0) gaps.push(t - last);
    last = t;
    if (gaps.length < 30) {
      requestAnimationFrame(step);
      return;
    }
    gaps.sort((a, b) => a - b);
    const mid = gaps[gaps.length >> 1];
    if (mid !== undefined && mid > 2 && mid < 100) vsyncMs = mid;
  };
  requestAnimationFrame(step);
}

function tick(): void {
  if (!registry) return;
  const { frameMsEMA, rendersPerSec } = perfSnapshot();
  const reading = readLoad(frameMsEMA, rendersPerSec, vsyncMs);
  if (reading === 'idle') {
    overCount = 0;
    underCount = 0;
    return;
  }

  if (reading === 'shed') {
    overCount++;
    underCount = 0;
    if (overCount >= CONSECUTIVE) {
      overCount = 0;
      shed();
    }
  } else if (reading === 'restore') {
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
  measureVsync();
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
