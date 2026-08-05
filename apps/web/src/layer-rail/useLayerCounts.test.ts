import { describe, it, expect } from 'vitest';
import { rowCount, rowState } from './useLayerCounts.js';

// A layer that is OFF, a layer that answered zero, and a layer that has never
// answered are three different facts, and the rail used to render all three as
// the same grey nothing across 58 of 64 rows. `rowState` is where the
// distinction lives, so it is where it is guarded: the browser check cannot own
// this, because which state a given row is in depends on what an upstream did in
// the last ten seconds (tools/perf/console_frame_check.mjs).
//
// The key fact this rests on: a Cesium DataSource exists only once the
// compositor has spawned AND fetched the layer, so a MISSING key means pending
// and a key of 0 means the source answered with nothing.

describe('rowState', () => {
  it('is off when the row is disabled, whatever the counts say', () => {
    expect(rowState({ a: 12 }, ['a'], false)).toEqual({ state: 'off' });
    expect(rowState({}, ['a'], false)).toEqual({ state: 'off' });
  });

  it('is pending when no mapped layer has answered yet', () => {
    expect(rowState({}, ['a', 'b'], true)).toEqual({ state: 'pending' });
    expect(rowState({ other: 5 }, ['a'], true)).toEqual({ state: 'pending' });
  });

  it('is empty when the source answered with nothing', () => {
    // The distinction rowCount cannot make: this and `pending` both sum to 0.
    expect(rowState({ a: 0 }, ['a'], true)).toEqual({ state: 'empty' });
    expect(rowCount({ a: 0 }, ['a'])).toBe(rowCount({}, ['a']));
  });

  it('is live with the summed count across every layer the row maps to', () => {
    expect(rowState({ a: 3, b: 4 }, ['a', 'b'], true)).toEqual({ state: 'live', n: 7 });
  });

  it('counts a partially answered row from what answered, not from zero', () => {
    // One of two sources is up. That is `live 5`, not `pending` and not `5 of ?`.
    expect(rowState({ a: 5 }, ['a', 'b'], true)).toEqual({ state: 'live', n: 5 });
  });

  it('never returns the same state for empty and pending', () => {
    const empty = rowState({ a: 0 }, ['a'], true);
    const pending = rowState({}, ['a'], true);
    expect(empty.state).not.toBe(pending.state);
  });
});
