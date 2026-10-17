import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import { acquireStats, setStatsViewer, useEntityStats } from './entityStats';

describe('entity stats walk', () => {
  it('counts every entity across the chunk boundaries it yields at', () => {
    // 1 234 contacts spans two yields of the resumable walk; the sync sample
    // must still drain it to the end and count each one once.
    const values = Array.from(
      { length: 1234 },
      (_, i) =>
        new Cesium.Entity({
          id: `a${i}`,
          position: Cesium.Cartesian3.fromDegrees(10, 50),
          properties: { kind: 'aircraft', icao24: `abc${i}` },
        }),
    );
    const viewer = {
      isDestroyed: () => false,
      clock: { currentTime: Cesium.JulianDate.now() },
      dataSources: {
        length: 1,
        get: () => ({ name: 'aviation.adsb.global', entities: { values } }),
      },
    } as unknown as Cesium.Viewer;
    setStatsViewer(viewer);
    const release = acquireStats();
    expect(useEntityStats.getState().counted).toBe(1234);
    release();
    setStatsViewer(null);
  });
});
