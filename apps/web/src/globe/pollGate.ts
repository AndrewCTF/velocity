// Shared back-pressure for layer polling.
//
// Every adapter owned its own 200 ms move-settle debounce, so a single camera
// settle released all sixteen move-refreshing layers at the same instant. With
// the nine generated infra.* layers sharing one endpoint that is nine identical
// requests to the same route, plus the aircraft, vessel and reference layers,
// all landing together. Measured 2026-07-27 with every toggle on: the browser
// issued 282 /api requests a minute, 3.3x what the layer TTLs predict, and 144
// of them in 74 seconds went to /api/places/infrastructure alone.
//
// Two rules, both from how Palantir's Gaia handles the same problem (see
// docs/palantir-reference-2026-07.md §7: send the minimum, only when someone is
// watching, and throttle by count rather than hoping):
//
//   1. ONE settle timer for the whole map, not one per layer.
//   2. A concurrency cap on what it releases, in priority order, so the layers
//      the operator is actually looking at go first.
//
// Deliberately not a request queue for scheduled polls: those are already
// spread across the TTL grid and gating them would make freshness worse.

const SETTLE_MS = 300;
const MAX_CONCURRENT = 4;
const BATCH_GAP_MS = 250;

type Job = { priority: number; run: () => void };

let settleTimer: number | null = null;
let pending: Job[] = [];
let inFlight = 0;

/** Lower runs first. Aircraft and vessels before reference/facility data. */
export function movePriority(layerId: string): number {
  if (layerId.startsWith('aviation.')) return 0;
  if (layerId.startsWith('maritime.')) return 1;
  if (layerId.startsWith('places.')) return 3;
  if (layerId.startsWith('infra.') || layerId.startsWith('military.')) return 4;
  return 2;
}

// The adapters' refresh() is fire-and-forget, so there is no completion to wait
// on. Releasing on a microtask therefore capped nothing — every queued layer
// still fired inside the same frame. Release in TIMED batches instead: the cap
// is per batch, and the next batch waits BATCH_GAP_MS. That genuinely spreads a
// settle burst across the second after it, which is what the backend needs.
function pump(): void {
  if (inFlight > 0 || pending.length === 0) return;
  const batch = pending.splice(0, MAX_CONCURRENT);
  inFlight = batch.length;
  for (const job of batch) {
    try {
      job.run();
    } catch {
      /* one layer's refresh must not strand the rest of the batch */
    }
  }
  window.setTimeout(() => {
    inFlight = 0;
    pump();
  }, BATCH_GAP_MS);
}

/**
 * Register a layer's intent to re-poll after the camera settles.
 *
 * Calls arriving inside the settle window collapse into one release, and a
 * later camera move cancels the pending release entirely — a user still
 * dragging should not be spending requests on viewports they have left.
 */
export function onMoveSettle(layerId: string, run: () => void): void {
  pending = pending.filter((j) => j.run !== run);
  pending.push({ priority: movePriority(layerId), run });
  if (settleTimer != null) window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settleTimer = null;
    pending.sort((a, b) => a.priority - b.priority);
    pump();
  }, SETTLE_MS);
}

/** Drop a layer's pending release (adapter detach). */
export function cancelMoveSettle(run: () => void): void {
  pending = pending.filter((j) => j.run !== run);
}

/** Test/diagnostic view of the gate. */
export function gateState(): { pending: number; inFlight: number; armed: boolean } {
  return { pending: pending.length, inFlight, armed: settleTimer != null };
}

if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __pollGate: typeof gateState }).__pollGate = gateState;
}
