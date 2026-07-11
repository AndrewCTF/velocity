import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

// Mock apiFetch at the transport boundary (repo eslint guard) so loadLod1Bbox
// can be exercised with a canned FeatureCollection and no live backend.
vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';
import { loadLod1Bbox, clearLod1 } from './lod1Layer.js';

const mockedFetch = vi.mocked(apiFetch);

// A single square building footprint near Beirut with a 20 m height property.
const FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { height: 20 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [35.5, 33.88],
            [35.5006, 33.88],
            [35.5006, 33.8806],
            [35.5, 33.8806],
            [35.5, 33.88],
          ],
        ],
      },
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

// Minimal viewer stub exposing only the surface lod1Layer touches. `getHeight`
// is a caller-supplied function so a test can change what terrain reports over
// time; `fireTileDrain()` invokes the registered tileLoadProgressEvent handler
// with 0 (queue drained) to simulate a fresh LOD streaming in.
function fakeViewer(opts: { terrain: boolean; getHeight: () => number | undefined }): {
  viewer: Cesium.Viewer;
  added: Cesium.GeoJsonDataSource[];
  fireTileDrain: () => void;
} {
  const added: Cesium.GeoJsonDataSource[] = [];
  let listener: ((queued: number) => void) | null = null;
  const viewer = {
    terrainProvider: opts.terrain
      ? ({} as Cesium.TerrainProvider)
      : new Cesium.EllipsoidTerrainProvider(),
    scene: {
      globe: {
        getHeight: opts.getHeight,
        tileLoadProgressEvent: {
          addEventListener: (cb: (q: number) => void) => {
            listener = cb;
            return () => {
              listener = null;
            };
          },
        },
      },
      requestRender: () => {},
    },
    dataSources: {
      add: async (ds: Cesium.GeoJsonDataSource) => {
        added.push(ds);
        return ds;
      },
      remove: () => true,
    },
  } as unknown as Cesium.Viewer;
  return { viewer, added, fireTileDrain: () => listener?.(0) };
}

function baseAndTop(ds: Cesium.GeoJsonDataSource): { base: number; top: number } {
  const e = ds.entities.values[0]!;
  const now = Cesium.JulianDate.now();
  return {
    base: e.polygon!.height!.getValue(now) as number,
    top: e.polygon!.extrudedHeight!.getValue(now) as number,
  };
}

describe('lod1 terrain clamp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(jsonResponse(FC));
  });

  it('pins the building base to the terrain height beneath it (3d-sat)', async () => {
    const { viewer, added } = fakeViewer({ terrain: true, getHeight: () => 137 });
    const count = await loadLod1Bbox(viewer, [35.49, 33.87, 35.51, 33.89]);
    expect(count).toBe(1);
    // The immediate apply() inside the (synchronous) clamp runs during the
    // awaited extrude(), so the base is on terrain by the time loadLod1Bbox
    // resolves.
    const { base, top } = baseAndTop(added[0]!);
    expect(base).toBe(137); // base lifted onto terrain, not left at sea level 0
    expect(top).toBe(157); // base + 20 m building height
  });

  it('leaves the base at 0 on the flat ellipsoid (2d-dark)', async () => {
    const { viewer, added } = fakeViewer({ terrain: false, getHeight: () => 137 });
    await loadLod1Bbox(viewer, [35.49, 33.87, 35.51, 33.89]);
    const { base, top } = baseAndTop(added[0]!);
    expect(base).toBe(0); // ellipsoid: height 0 already IS the ground
    expect(top).toBe(20);
  });

  // Regression for the coast bug found by live probing over Beirut: getHeight
  // resolves to a coarse ~-330 m first and only refines to the true land height
  // as finer terrain tiles stream in. The clamp must SUPERSEDE the coarse value
  // on the next tile drain, not latch it.
  it('re-clamps to the refined terrain height when a finer tile streams in', async () => {
    let terrain: number | undefined = -330; // coarse coastal tile first
    const { viewer, added, fireTileDrain } = fakeViewer({ terrain: true, getHeight: () => terrain });
    await loadLod1Bbox(viewer, [35.49, 33.87, 35.51, 33.89]);
    expect(baseAndTop(added[0]!).base).toBe(-330); // latched the only tile so far

    terrain = 38; // finer land tile arrives
    fireTileDrain();
    expect(baseAndTop(added[0]!).base).toBe(38); // superseded, now on the ground
    expect(baseAndTop(added[0]!).top).toBe(58);
  });

  it('stops re-clamping once the layer is cleared', async () => {
    let terrain: number | undefined = 50;
    const { viewer, added, fireTileDrain } = fakeViewer({ terrain: true, getHeight: () => terrain });
    await loadLod1Bbox(viewer, [35.49, 33.87, 35.51, 33.89]);
    expect(baseAndTop(added[0]!).base).toBe(50);

    clearLod1(viewer); // detaches `current`
    terrain = 999; // a later drain must NOT touch the removed layer
    fireTileDrain();
    expect(baseAndTop(added[0]!).base).toBe(50); // unchanged after clear
  });
});
