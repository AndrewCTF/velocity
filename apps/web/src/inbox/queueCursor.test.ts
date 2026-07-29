import { describe, it, expect } from 'vitest';
import { clampCursor, cursorAfterRemoval, moveCursor } from './queueCursor.js';

describe('moveCursor', () => {
  it('clamps rather than wrapping', () => {
    // Wrapping from the last row to the first reads as a lost place.
    expect(moveCursor(0, -1, 5)).toBe(0);
    expect(moveCursor(4, 1, 5)).toBe(4);
    expect(moveCursor(2, 1, 5)).toBe(3);
    expect(moveCursor(2, -1, 5)).toBe(1);
  });

  it('is safe on an empty queue', () => {
    expect(moveCursor(3, 1, 0)).toBe(0);
  });
});

describe('cursorAfterRemoval', () => {
  it('stays put so the row that slid up is selected', () => {
    // THE rule. Advancing after an archive skips the alert that took the
    // archived row's place, which is how a triage queue loses items.
    expect(cursorAfterRemoval(2, 5)).toBe(2);
    expect(cursorAfterRemoval(0, 5)).toBe(0);
  });

  it('steps back when the last row was removed', () => {
    expect(cursorAfterRemoval(4, 5)).toBe(3);
  });

  it('lands on zero when the queue empties', () => {
    expect(cursorAfterRemoval(0, 1)).toBe(0);
  });
});

describe('clampCursor', () => {
  it('keeps the cursor on a real row as the list changes size', () => {
    expect(clampCursor(9, 3)).toBe(2);
    expect(clampCursor(1, 3)).toBe(1);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(5, 0)).toBe(0);
  });
});
