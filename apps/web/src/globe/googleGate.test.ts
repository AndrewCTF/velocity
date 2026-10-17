// The gate that shows or hides the Google mesh also decides what happens to
// the globe under it and to the attribution strip, and the two sources need
// opposite answers. Pinned here because the difference is easy to "tidy" away:
//  - keyless mesh: the globe stays as a coarse backdrop, the strip stays hidden;
//  - licensed stream: the globe goes (its heights are ellipsoidal), and the
//    strip MUST show — Google's terms require attribution while it renders.
import { describe, expect, it, vi } from 'vitest';

// GlobeCanvas pulls in cesium-martini, whose worker factory needs
// URL.createObjectURL; nothing here touches terrain.
vi.mock('@macrostrat/cesium-martini', () => ({ MapboxTerrainProvider: class {} }));

import type * as Cesium from 'cesium';
import { applyGoogleGate } from './GlobeCanvas.js';
import { presetKnobs } from './qualityPresets.js';
import { useSettings } from '../state/settings.js';

function scene(heightM: number, canvas = { width: 1200, height: 800 }) {
  const credit = document.createElement('div');
  credit.style.display = 'none';
  const globe = { show: true, maximumScreenSpaceError: 2 };
  const viewer = {
    camera: { positionCartographic: { height: heightM } },
    canvas,
    cesiumWidget: { creditContainer: credit },
    scene: {
      msaaSamples: 1,
      postProcessStages: { fxaa: { enabled: true } },
      globe,
      requestRender: () => {},
    },
  } as unknown as Cesium.Viewer;
  // What the creation path hands the gate: a tileset that starts hidden.
  const tileset = { show: false, maximumScreenSpaceError: 24 } as unknown as Cesium.Cesium3DTileset;
  return { viewer, tileset, globe, credit };
}

describe('the Google mesh gate', () => {
  it('keeps the globe as a coarse backdrop under the keyless mesh, with no strip', () => {
    const s = scene(1500);
    applyGoogleGate(s.viewer, s.tileset, true, true);
    expect(s.tileset.show).toBe(true);
    expect(s.globe.show).toBe(true);
    expect(s.globe.maximumScreenSpaceError).toBe(16);
    expect(s.credit.style.display).toBe('none');
  });

  it('hides the globe and shows the attribution strip for the licensed stream', () => {
    const s = scene(1500);
    applyGoogleGate(s.viewer, s.tileset, true, false);
    expect(s.tileset.show).toBe(true);
    expect(s.globe.show).toBe(false);
    expect(s.credit.style.display).toBe('');
  });

  it('puts the globe back above the 30 km gate, for either source', () => {
    for (const keyless of [true, false]) {
      const s = scene(1500);
      applyGoogleGate(s.viewer, s.tileset, true, keyless);
      (s.viewer.camera.positionCartographic as { height: number }).height = 80_000;
      applyGoogleGate(s.viewer, s.tileset, true, keyless);
      expect(s.tileset.show).toBe(false);
      expect(s.globe.show).toBe(true);
      expect(s.credit.style.display).toBe('none');
      if (keyless) {
        const idle = presetKnobs(useSettings.getState().mapQuality).idleSSE;
        expect(s.globe.maximumScreenSpaceError).toBe(idle);
      }
    }
  });

  it('asks for less detail per pixel on a very large canvas, keyless only', () => {
    const big = scene(1500, { width: 3162, height: 1994 });
    applyGoogleGate(big.viewer, big.tileset, true, true);
    expect(big.tileset.maximumScreenSpaceError).toBeGreaterThan(36);
    expect(big.tileset.maximumScreenSpaceError).toBeLessThan(40);

    const small = scene(1500);
    applyGoogleGate(small.viewer, small.tileset, true, true);
    expect(small.tileset.maximumScreenSpaceError).toBe(24);

    const licensed = scene(1500, { width: 3162, height: 1994 });
    applyGoogleGate(licensed.viewer, licensed.tileset, true, false);
    expect(licensed.tileset.maximumScreenSpaceError).toBe(24);
  });
});
