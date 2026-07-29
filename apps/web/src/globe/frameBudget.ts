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

// Sizing this from the MEASURED render cost (16.7 - renderMsEMA) was tried on
// 2026-07-29 and reverted. It is a positive feedback loop: a slower render
// shrinks the drain budget, so drains span more frames, so the main thread stays
// busy longer, so the render gets slower still. Measured renderMs p95 90.9 and
// 49.4 ms against 35.8 with the flat budget.
//
// The stated "~4 ms for Cesium's own render" is still wrong — the render actually
// costs 9.8 ms at 1080p and 12.7 ms at 4K — but a flat budget is stable and an
// adaptive one is not. Fixing the overrun properly means making the render
// cheaper, not rationing the drain against it.
const FRAME_BUDGET_MS = 12;

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
