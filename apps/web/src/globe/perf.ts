// window.__perf — one-line perf truth for the operator + headless CPU probes.
//
// Why this exists: the render-governor / pan-smoothness / push-diet work (design
// §5) can only be judged against numbers. Headless Playwright can NOT read real
// GPU fps (software raster — CLAUDE.md lesson), but it CAN read these counters
// during a scripted pan, and the operator can read them on real hardware.
//
// ponytail: plain mutable singleton, not an event bus. Hot-path writers do integer
// bumps (perfOnRender) or a single field set; SysStats reads once/sec. No React,
// no allocation on the render path.

export interface PerfState {
  /** Actual Cesium scene renders in the last 1 s (distinct from rAF frames — under
   *  requestRenderMode a rAF can fire with no render). This is the governor metric. */
  rendersPerSec: number;
  /** EMA of the inter-render delta in ms (only ticks on real renders). */
  frameMsEMA: number;
  /** Duration of the last push application (drain of a poll/WS blob into the scene). */
  drainMsLast: number;
  /** PerformanceObserver longtasks over a rolling 60 s window. */
  longtasksPerMin: number;
  /** Cesium Label objects currently materialized (P1 lazy-label metric). */
  liveLabels: number;
  /** Prims mirrored per-frame (P1 animated-mirror LOD visibleSet size). */
  animatedPrims: number;
}

const state: PerfState = {
  rendersPerSec: 0,
  frameMsEMA: 0,
  drainMsLast: 0,
  longtasksPerMin: 0,
  liveLabels: 0,
  animatedPrims: 0,
};

// Always exposed (not DEV-gated): __perf is a diagnostic readout, cheap and
// harmless, and the operator's fps HUD reads it in a production build too.
if (typeof window !== 'undefined') {
  (window as unknown as { __perf: PerfState }).__perf = state;
}

// --- render rate + frame EMA ------------------------------------------------
let renderCount = 0;
let lastRenderAt = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlusher(): void {
  if (flushTimer != null || typeof window === 'undefined') return;
  flushTimer = setInterval(() => {
    state.rendersPerSec = renderCount;
    renderCount = 0;
    // Decay longtasks even when none fire so the readout falls back to 0.
    trimLongtasks(performance.now());
  }, 1000);
}

/** Call from viewer.scene.postRender — one call per real frame painted. */
export function perfOnRender(now: number): void {
  renderCount += 1;
  if (lastRenderAt > 0) {
    const dt = now - lastRenderAt;
    // EMA α=0.1; guard against the multi-second gap after an idle governor pause
    // dominating the average.
    if (dt < 1000) state.frameMsEMA = state.frameMsEMA === 0 ? dt : state.frameMsEMA * 0.9 + dt * 0.1;
  }
  lastRenderAt = now;
  ensureFlusher();
}

/** Record the wall-clock cost of applying one push (PollGeoJsonAdapter syncAll). */
export function perfSetDrain(ms: number): void {
  state.drainMsLast = Math.round(ms * 100) / 100;
}

export function perfSetLabels(n: number): void {
  state.liveLabels = n;
}

export function perfSetAnimated(n: number): void {
  state.animatedPrims = n;
}

// --- longtasks --------------------------------------------------------------
let longtasks: number[] = [];

function trimLongtasks(now: number): void {
  const cut = now - 60_000;
  const head = longtasks[0];
  if (head !== undefined && head < cut) longtasks = longtasks.filter((t) => t >= cut);
  state.longtasksPerMin = longtasks.length;
}

if (typeof PerformanceObserver !== 'undefined') {
  try {
    const po = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const e of list.getEntries()) longtasks.push(e.startTime);
      trimLongtasks(now);
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask entry type unsupported (Firefox/Safari) — leave the counter at 0.
  }
}

export function perfSnapshot(): PerfState {
  return { ...state };
}
