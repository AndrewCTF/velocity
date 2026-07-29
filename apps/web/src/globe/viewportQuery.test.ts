import { describe, it, expect } from 'vitest';
import { paddedQuantizedBbox, snapTo } from './LayerCompositor.js';

// "It also take some time to load in data after I zoom out or move in."
//
// The bbox was computed to three decimals from the exact camera rectangle, so
// every pixel of camera movement produced a different URL. PollGeoJsonAdapter
// only skips a move-refresh when the URL it would request equals the one it
// already fetched, so that condition essentially never held and every nudge was
// a fresh request and a fresh wait. These pin both halves of the fix: the ring
// that means the next view is already loaded, and the grid that means small
// moves reproduce the same URL.

/** Parse the query string back into numbers so tests can reason in degrees. */
function parse(q: string): { S: number; N: number; W: number; E: number } {
  const p = new URLSearchParams(q);
  return {
    S: Number(p.get('lamin')),
    N: Number(p.get('lamax')),
    W: Number(p.get('lomin')),
    E: Number(p.get('lomax')),
  };
}

describe('snapTo', () => {
  it('only ever grows the box', () => {
    // Snapping to the NEAREST multiple would let an edge move inward and hide
    // contacts that were already loaded.
    expect(snapTo(10.4, 1, 'down')).toBe(10);
    expect(snapTo(10.6, 1, 'up')).toBe(11);
    expect(snapTo(-10.4, 1, 'down')).toBe(-11);
    expect(snapTo(-10.6, 1, 'up')).toBe(-10);
  });

  it('passes the value through on a degenerate step', () => {
    expect(snapTo(3.7, 0, 'up')).toBe(3.7);
    expect(snapTo(3.7, Number.NaN, 'down')).toBe(3.7);
  });
});

describe('paddedQuantizedBbox', () => {
  it('requests strictly more ground than the camera sees', () => {
    const b = parse(paddedQuantizedBbox(40, 50, -80, 20, 6000));
    expect(b.S).toBeLessThan(40);
    expect(b.N).toBeGreaterThan(50);
    expect(b.W).toBeLessThan(-80);
    expect(b.E).toBeGreaterThan(-60);
  });

  it('returns an identical URL for a small pan', () => {
    // The whole point. A pan of a fiftieth of the viewport must not re-fetch.
    const a = paddedQuantizedBbox(40, 50, -80, 20, 6000);
    const b = paddedQuantizedBbox(40.2, 50.2, -79.8, 20, 6000);
    expect(b).toBe(a);
  });

  it('still changes for a deliberate move', () => {
    // Quantising must not pin the view forever; half a screen is a real move.
    const a = paddedQuantizedBbox(40, 50, -80, 20, 6000);
    const b = paddedQuantizedBbox(45, 55, -70, 20, 6000);
    expect(b).not.toBe(a);
  });

  it('changes when the zoom level changes', () => {
    const wide = paddedQuantizedBbox(40, 50, -80, 20, 6000);
    const tight = paddedQuantizedBbox(44, 46, -72, 4, 6000);
    expect(tight).not.toBe(wide);
  });

  it('scales the grid with zoom so it stays useful up close', () => {
    // A fixed degree grid would be coarse in orbit and no help at city scale.
    // At a 0.4 degree span the padded box must stay small.
    const b = parse(paddedQuantizedBbox(44.8, 45.2, -73.2, 0.4, 6000));
    expect(b.N - b.S).toBeLessThan(2);
  });

  it('never exceeds the coordinate ranges the backend accepts', () => {
    const polar = parse(paddedQuantizedBbox(80, 89, -179, 350, 6000));
    expect(polar.S).toBeGreaterThanOrEqual(-90);
    expect(polar.N).toBeLessThanOrEqual(90);
    expect(polar.W).toBeGreaterThanOrEqual(-180);
    expect(polar.E).toBeLessThanOrEqual(180);
  });

  it('carries the caller limit through unchanged', () => {
    // The ring must not be able to enlarge the payload: a wider box with the
    // same cap returns a better-chosen set, never a bigger one.
    expect(paddedQuantizedBbox(40, 50, -80, 20, 1500)).toContain('limit=1500');
    expect(paddedQuantizedBbox(40, 50, -80, 20, 20000)).toContain('limit=20000');
  });
});
