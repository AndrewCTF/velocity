/**
 * How many layers are live right now, so each can size itself against a shared
 * entity budget instead of an unconditional per-layer cap.
 *
 * Published by LayerCompositor (which owns spawn/kill) rather than read off
 * `window.__registry`, because that global only exists in DEV — a budget that
 * silently stopped binding in a production build would be worse than none.
 */

let active = 0;

/** Called by LayerCompositor whenever an adapter is spawned or killed. */
export function setActiveLayerCount(n: number): void {
  active = Math.max(0, n);
}

/** At least 1, so a caller can divide by it without guarding. */
export function activeLayerCount(): number {
  return Math.max(1, active);
}
