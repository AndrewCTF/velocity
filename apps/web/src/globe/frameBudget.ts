// ── Cooperative per-frame main-thread budget ────────────────────────────────
//
// The globe's batched-drain adapters (ADS-B + vessel upsert drains, satellite
// SGP4 pump) each own their OWN requestAnimationFrame loop and each time-slice
// to ~6 ms. Independently that's fine, but two can land in the SAME frame and
// each spend their slice — 6 + 6 (+ a 5 ms sat pump) overruns the 16.7 ms frame
// and the browser drops it. During a world-view pan that reads as a micro-stutter.
//
// This is a tiny shared ledger keyed on the rAF timestamp. Every callback rAF
// runs within one frame receives the SAME DOMHighResTimeStamp, so an adapter can
// ask "how much of this frame's cooperative budget is left?" and shrink its slice
// when another adapter already drained this frame. No central scheduler, no
// restructuring of each adapter's loop — they stay independent and just consult
// the ledger. If a caller can't supply the frame stamp it simply sees the full
// budget (degrades to today's behaviour).
//
// ponytail: a counter + a stamp. Not a frame scheduler. Upgrade to a real
// priority queue only if a third heavy drain ever needs ordering guarantees.

const FRAME_BUDGET_MS = 12; // leave ~4 ms of the 16.7 ms frame for Cesium's own render

let lastStamp = -1;
let spent = 0;

// Remaining cooperative budget for the frame identified by `stamp`. The first
// caller in a new frame resets the ledger and sees the full budget.
export function frameBudgetRemaining(stamp: number): number {
  if (stamp !== lastStamp) {
    lastStamp = stamp;
    spent = 0;
  }
  return Math.max(0, FRAME_BUDGET_MS - spent);
}

// Charge `ms` of work against the frame identified by `stamp`. Ignored if the
// frame already rolled over (stale stamp) so we never under-count the new frame.
export function recordFrameSpend(stamp: number, ms: number): void {
  if (stamp === lastStamp && ms > 0) spent += ms;
}
