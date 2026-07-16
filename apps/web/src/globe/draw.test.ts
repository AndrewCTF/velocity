import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { createDrawController, haversineKm, pointInRing } from './draw.js';

describe('haversineKm', () => {
  it('is zero for the same point', () => {
    expect(haversineKm({ lat: 10, lon: 20 }, { lat: 10, lon: 20 })).toBe(0);
  });

  it('matches the London→Paris great-circle (~343 km)', () => {
    const d = haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 });
    expect(d).toBeGreaterThan(330);
    expect(d).toBeLessThan(355);
  });

  it('1° of longitude at the equator is ~111 km', () => {
    const d = haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });
});

describe('pointInRing', () => {
  // A 10×10 square centred on the origin.
  const square = [
    { lat: -5, lon: -5 },
    { lat: -5, lon: 5 },
    { lat: 5, lon: 5 },
    { lat: 5, lon: -5 },
  ];

  it('is true for an interior point', () => {
    expect(pointInRing({ lat: 0, lon: 0 }, square)).toBe(true);
  });

  it('is false for an exterior point', () => {
    expect(pointInRing({ lat: 0, lon: 20 }, square)).toBe(false);
    expect(pointInRing({ lat: 20, lon: 0 }, square)).toBe(false);
  });

  it('handles a concave (arrow) polygon', () => {
    const arrow = [
      { lat: 0, lon: 0 },
      { lat: 10, lon: 5 },
      { lat: 0, lon: 2 },
      { lat: -10, lon: 5 },
    ];
    expect(pointInRing({ lat: 0, lon: 1 }, arrow)).toBe(true); // inside the notch base
    expect(pointInRing({ lat: 0, lon: 4 }, arrow)).toBe(false); // in the concave gap
  });
});

describe('createDrawController teardown', () => {
  // Minimal viewer stub exposing only what createDrawController touches (same
  // approach as HistoryPlayback.test.ts). `destroyed` flips to model the real
  // unmount order: GlobeCanvas destroys the viewer, then the toolbar's effect
  // cleanup still calls cancel() on the controller it captured.
  // destroy() drops the widget the `scene` getter reads through, exactly as
  // Cesium's Viewer.destroy() does — so an unguarded viewer.scene here throws
  // the same "Cannot read properties of undefined (reading 'scene')" the real
  // teardown threw. Without that, this stub would pass an unguarded clearDraft.
  function fakeViewer(): { viewer: Cesium.Viewer; destroy: () => void } {
    let widget: { scene: unknown } | undefined = {
      scene: { canvas: document.createElement('canvas'), requestRender: () => undefined },
    };
    const viewer = {
      dataSources: { add: () => undefined, remove: () => true },
      get scene() {
        return (widget as { scene: unknown }).scene;
      },
      isDestroyed: () => widget === undefined,
    } as unknown as Cesium.Viewer;
    return { viewer, destroy: () => (widget = undefined) };
  }

  it('cancel() after the viewer is destroyed does not throw', () => {
    const { viewer, destroy } = fakeViewer();
    const c = createDrawController(viewer);
    c.drawPolyline(() => undefined);
    destroy();
    expect(() => c.cancel()).not.toThrow();
  });

  it('dispose() after the viewer is destroyed does not throw', () => {
    const { viewer, destroy } = fakeViewer();
    const c = createDrawController(viewer);
    destroy();
    expect(() => c.dispose()).not.toThrow();
  });
});
