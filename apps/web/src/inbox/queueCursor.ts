// Cursor arithmetic for a triage queue.
//
// Extracted from InboxPanel so the one rule that actually loses work is
// testable without mounting Cesium: after archiving a row, the cursor must NOT
// advance. The archived row disappears and the next one slides under the same
// index, so advancing as well skips an alert - which is how a triage queue
// silently drops items, and the whole reason to have a queue is that it does
// not.

/** Move the cursor by `delta`, clamped to the list. Never wraps: wrapping from
 *  the last row back to the first reads as a lost place, not a feature. */
export function moveCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor + delta));
}

/** Where the cursor sits after the row under it is removed.
 *
 *  Stays put, so the row that slid up is the one now selected. Only when the
 *  removed row was the last does it step back, so the cursor stays on a real
 *  row rather than pointing past the end.
 */
export function cursorAfterRemoval(cursor: number, lengthBefore: number): number {
  const lengthAfter = Math.max(0, lengthBefore - 1);
  if (lengthAfter === 0) return 0;
  return Math.min(cursor, lengthAfter - 1);
}

/** Clamp a cursor into a list that changed size underneath it (alerts arrive,
 *  expire, or a filter narrows the view). */
export function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}
