import * as Cesium from 'cesium';
import type { Chokepoint } from '../registry/chokepoints.js';

// Camera helpers. All slews respect prefers-reduced-motion via the duration arg
// passed by the caller (0 = instant set).

export function flyToChokepoint(viewer: Cesium.Viewer, c: Chokepoint, durationSec = 1.4): void {
  const [west, south, east, north] = c.bbox;
  const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);
  viewer.camera.flyTo({
    destination: rect,
    duration: durationSec,
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-55), // tilt for situational awareness
      roll: 0,
    },
  });
}

export function flyToPosition(
  viewer: Cesium.Viewer,
  lon: number,
  lat: number,
  altMeters = 350_000,
  durationSec = 0.8,
): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, altMeters),
    duration: durationSec,
  });
}

export function flyToGlobal(viewer: Cesium.Viewer, durationSec = 1.0): void {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(20, 35, 22_000_000),
    duration: durationSec,
    orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
  });
}
