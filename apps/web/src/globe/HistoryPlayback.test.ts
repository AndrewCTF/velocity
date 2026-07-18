import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

// Mock apiFetch at the transport boundary (repo eslint guard + established
// pattern, see lod1Layer.test.ts) so load() can be exercised against a canned
// /api/history/tracks response with no live backend.
vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';
import { installHistoryPlayback } from './HistoryPlayback.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

// Minimal viewer stub exposing only the surface HistoryPlayback.ts touches:
// dataSources.add/get/length (hideLive/restoreLive walk the collection),
// camera.computeViewRectangle (skip bbox filtering), clock (plain bag of
// fields the module assigns to), scene.requestRender/maximumRenderTimeChange,
// isDestroyed. dataSources.add captures the real Cesium.CustomDataSource the
// module creates so the test can inspect the entities it built, without
// needing any export beyond the existing installHistoryPlayback().
function fakeViewer(): { viewer: Cesium.Viewer; getDs: () => Cesium.CustomDataSource } {
  const sources: Cesium.DataSource[] = [];
  let captured: Cesium.CustomDataSource | undefined;
  const dataSources = {
    add: (ds: Cesium.DataSource) => {
      sources.push(ds);
      if (ds instanceof Cesium.CustomDataSource) captured = ds;
      return ds;
    },
    remove: () => true,
    get: (i: number) => sources[i],
    get length() {
      return sources.length;
    },
  };
  const viewer = {
    dataSources,
    camera: { computeViewRectangle: () => undefined },
    clock: {},
    scene: { requestRender: () => {}, maximumRenderTimeChange: 0 },
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer;
  return {
    viewer,
    getDs: () => {
      if (!captured) throw new Error('history CustomDataSource was never added');
      return captured;
    },
  };
}

function lonLat(pos: Cesium.Cartesian3): [number, number] {
  const c = Cesium.Cartographic.fromCartesian(pos);
  return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude)];
}

const WINDOW_SEC = 3600;

describe('HistoryPlayback: multi-domain replay renders interpolated ≥2-point tracks', () => {
  let t0: number;
  let t1: number;
  let tMid: number;

  beforeEach(() => {
    const now = Date.now() / 1000;
    t0 = now - WINDOW_SEC + 60; // just inside the window start
    t1 = now - 60; // just inside the window end
    tMid = (t0 + t1) / 2;
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(
      jsonResponse({
        tracks: [
          {
            id: 'aircraft:ABC123',
            kind: 'aircraft',
            points: [
              [35.0, 33.0, t0, 90],
              [36.0, 34.0, t1, 90],
            ],
          },
          {
            id: 'vessel:123456789',
            kind: 'vessel',
            points: [
              [10.0, 50.0, t0, 180],
              [11.0, 51.0, t1, 180],
            ],
          },
        ],
      }),
    );
  });

  it('loads both an aircraft and a vessel track with ≥2-point interpolated position samples', async () => {
    const { viewer, getDs } = fakeViewer();
    const controller = installHistoryPlayback(viewer);

    const info = await controller.load(WINDOW_SEC);
    expect(info).not.toBeNull();
    // Two tracks, two in-window fixes each — proves buildTrackEntity added
    // both fixes for both kinds, not just one (a 1-sample-per-track total
    // would be 2, not 4).
    expect(info!.tracks).toBe(2);
    expect(info!.points).toBe(4);

    const ds = getDs();
    const air = ds.entities.getById('hist:aircraft:ABC123');
    const sea = ds.entities.getById('hist:vessel:123456789');
    expect(air, 'aircraft replay entity missing').toBeDefined();
    expect(sea, 'vessel replay entity missing').toBeDefined();

    for (const [entity, [lon0, lat0], [lon1, lat1]] of [
      [air!, [35.0, 33.0], [36.0, 34.0]],
      [sea!, [10.0, 50.0], [11.0, 51.0]],
    ] as const) {
      const pos = entity.position;
      expect(pos, 'entity has no position property').toBeDefined();
      expect(pos).toBeInstanceOf(Cesium.SampledPositionProperty);

      // Endpoint samples round-trip to the recorded fixes — ≥2 real points.
      const [rl0, rl1] = lonLat(pos!.getValue(Cesium.JulianDate.fromDate(new Date(t0 * 1000)))!);
      expect(rl0).toBeCloseTo(lon0, 3);
      expect(rl1).toBeCloseTo(lat0, 3);
      const [rl2, rl3] = lonLat(pos!.getValue(Cesium.JulianDate.fromDate(new Date(t1 * 1000)))!);
      expect(rl2).toBeCloseTo(lon1, 3);
      expect(rl3).toBeCloseTo(lat1, 3);

      // path.trailTime is the exact window passed to load(), for both kinds.
      const trailTime = entity.path!.trailTime!.getValue(Cesium.JulianDate.now());
      expect(trailTime).toBe(WINDOW_SEC);
    }
  });

  it('re-entrant load then exit restores the live layers — two Pattern-of-life clicks must not blank the globe', async () => {
    const { viewer } = fakeViewer();
    // Two live layers already on the globe when replay starts.
    const live1 = { show: true } as unknown as Cesium.DataSource;
    const live2 = { show: true } as unknown as Cesium.DataSource;
    viewer.dataSources.add(live1);
    viewer.dataSources.add(live2);

    const controller = installHistoryPlayback(viewer);

    await controller.load(WINDOW_SEC); // first Pattern-of-life click
    expect(live1.show).toBe(false);
    expect(live2.show).toBe(false);

    // Second click with no "◼ exit" between — load() runs again while active.
    await controller.load(WINDOW_SEC, 'aircraft:ABC123');
    expect(live1.show).toBe(false); // still hidden during replay

    controller.clear(); // "◼ exit"
    // Pre-fix, the second load wiped the saved set and these stayed false — the
    // whole live globe blanked until a page reload.
    expect(live1.show).toBe(true);
    expect(live2.show).toBe(true);
  });

  it('interpolates a midpoint position for BOTH aircraft and vessel (glide, not teleport-hold) — the sanctioned replay motion (docs/decisions.md 2026-07-11)', async () => {
    const { viewer, getDs } = fakeViewer();
    const controller = installHistoryPlayback(viewer);
    await controller.load(WINDOW_SEC);

    const ds = getDs();
    for (const [id, [lon0, lat0], [lon1, lat1]] of [
      ['hist:aircraft:ABC123', [35.0, 33.0], [36.0, 34.0]],
      ['hist:vessel:123456789', [10.0, 50.0], [11.0, 51.0]],
    ] as const) {
      const entity = ds.entities.getById(id)!;
      const mid = entity.position!.getValue(Cesium.JulianDate.fromDate(new Date(tMid * 1000)))!;
      const [mlon, mlat] = lonLat(mid);

      // Interpolated: strictly between the two endpoints, equal to neither —
      // proves glide, not a held/teleport value.
      expect(mlon).toBeGreaterThan(Math.min(lon0, lon1));
      expect(mlon).toBeLessThan(Math.max(lon0, lon1));
      expect(mlat).toBeGreaterThan(Math.min(lat0, lat1));
      expect(mlat).toBeLessThan(Math.max(lat0, lat1));
    }
  });
});
