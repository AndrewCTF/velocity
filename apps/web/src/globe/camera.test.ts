import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { globalAltitude, EARTH_RADIUS_M } from './camera.js';

// A viewer stand-in carrying only what globalAltitude reads.
function fakeViewer(width: number, height: number, fov = Cesium.Math.toRadians(60)) {
  return {
    camera: { frustum: { fov, aspectRatio: width / height } },
    canvas: { clientWidth: width, clientHeight: height, width, height },
  } as unknown as Cesium.Viewer;
}

/** Fraction of the frame's shorter axis the Earth's disk spans from `alt`. */
function diskFillAt(alt: number, width: number, height: number, fov = Cesium.Math.toRadians(60)) {
  const aspect = width / height;
  const fovy = aspect <= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) / aspect);
  const angularDiameter = 2 * Math.asin(EARTH_RADIUS_M / (EARTH_RADIUS_M + alt));
  return angularDiameter / fovy;
}

describe('globalAltitude', () => {
  it('frames the disk at the requested fill on a wide map', () => {
    const alt = globalAltitude(fakeViewer(1240, 940));
    expect(diskFillAt(alt, 1240, 940)).toBeCloseTo(0.9, 3);
  });

  it('holds the fill across aspect ratios, which a fixed altitude cannot', () => {
    const sizes: ReadonlyArray<readonly [number, number]> = [
      [1920, 1080],
      [1240, 940],
      [1024, 1280],
      [3840, 2160],
    ];
    for (const [w, h] of sizes) {
      expect(diskFillAt(globalAltitude(fakeViewer(w, h)), w, h)).toBeCloseTo(0.9, 3);
    }
  });

  it('is far lower than the 20 Mm it replaces, which framed the disk at 56%', () => {
    expect(diskFillAt(20_000_000, 1240, 940)).toBeLessThan(0.6);
    expect(globalAltitude(fakeViewer(1240, 940))).toBeLessThan(20_000_000);
  });

  it('falls back when the frustum is orthographic', () => {
    const ortho = { camera: { frustum: {} }, canvas: {} } as unknown as Cesium.Viewer;
    expect(globalAltitude(ortho)).toBe(11_000_000);
  });
});
