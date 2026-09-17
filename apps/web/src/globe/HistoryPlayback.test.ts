import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';

// Mock apiFetch at the transport boundary (repo eslint guard + established
// pattern, see lod1Layer.test.ts) so load() can be exercised against a canned
// /api/history/tracks response with no live backend.
vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';
import { installHistoryPlayback } from './HistoryPlayback.js';
import { chunkKeyForMs, chunkStartMs, nextChunk, CHUNK_MS } from './heatmapChunk.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

// Minimal viewer stub exposing only the surface HistoryPlayback.ts touches:
// dataSources.add/get/length (hideLive/restoreLive walk the collection),
// camera.computeViewRectangle (skip bbox filtering), clock (a plain bag of
// fields the module assigns to, PLUS a fake onTick event the chunk pipeline's
// ensureTickListener() subscribes to — see fireTick), scene.requestRender/
// maximumRenderTimeChange, isDestroyed. dataSources.add captures the real
// Cesium.CustomDataSource the module creates so the test can inspect the
// entities it built, without needing any export beyond installHistoryPlayback().
function fakeViewer(opts: { destroyed?: boolean } = {}): {
  viewer: Cesium.Viewer;
  getDs: () => Cesium.CustomDataSource;
  // Fires every registered onTick listener with the (mutated) viewer.clock,
  // then flushes the async chunk-load work it kicks off — a real Cesium
  // onTick handler runs synchronously but ours does `void (async () => ...)`.
  fireTick: () => Promise<void>;
} {
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
  const listeners: Array<(clock: unknown) => void> = [];
  const clock: Record<string, unknown> = {
    onTick: {
      addEventListener: (fn: (clock: unknown) => void) => {
        listeners.push(fn);
        return () => {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },
  };
  const viewer = {
    dataSources,
    camera: { computeViewRectangle: () => undefined },
    clock,
    scene: { requestRender: () => {}, maximumRenderTimeChange: 0 },
    isDestroyed: () => opts.destroyed ?? false,
  } as unknown as Cesium.Viewer;
  return {
    viewer,
    getDs: () => {
      if (!captured) throw new Error('history CustomDataSource was never added');
      return captured;
    },
    fireTick: async () => {
      for (const fn of [...listeners]) fn(viewer.clock);
      await new Promise((resolve) => setTimeout(resolve, 0));
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

describe('HistoryPlayback: chunk pipeline (loadAt) appends across a chunk boundary, never removeAll', () => {
  it('a tick that crosses into the next half hour appends to the SAME entity instead of rebuilding it', async () => {
    const { viewer, getDs, fireTick } = fakeViewer();

    const startMs = Date.UTC(2024, 5, 1, 12, 0, 0); // an exact UTC half-hour boundary
    const { day, index } = chunkKeyForMs(startMs);
    const nxt = nextChunk(day, index);
    const chunk1StartSec = chunkStartMs(day, index) / 1000;
    const chunk2StartSec = chunkStartMs(nxt.day, nxt.index) / 1000;

    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      // Very old oldest-recorded-day: every chunk this test touches is well
      // after it, so both chunks route to the own archive — this test is
      // about the append-not-rebuild behaviour, not source selection (that is
      // heatmapChunk.test.ts's job for the binary decode itself).
      if (u === '/api/history/stats') return jsonResponse({ shards: [{ day: '2020-01-01' }] });
      if (u.startsWith('/api/history/tracks')) {
        const fromTs = Number(new URL(u, 'http://local').searchParams.get('from_ts'));
        const isChunk2 = Math.abs(fromTs - chunk2StartSec) < 5;
        const lon = isChunk2 ? 40.0 : 35.0;
        return jsonResponse({
          tracks: [{ id: 'aircraft:ABC123', kind: 'aircraft', points: [[lon, 33.0, fromTs + 60, 90]] }],
        });
      }
      return jsonResponse({});
    });

    const controller = installHistoryPlayback(viewer);
    const endMs = startMs + 3 * 3600 * 1000;
    await controller.loadAt(startMs, endMs);

    const ds = getDs();
    const entityBefore = ds.entities.getById('hist:aircraft:ABC123');
    expect(entityBefore, 'entity missing after the first chunk').toBeDefined();
    expect(ds.entities.values.length).toBe(1);

    // Advance the clock into the next half hour and fire onTick, simulating
    // continuous playback crossing the chunk boundary.
    (viewer.clock as unknown as { currentTime: Cesium.JulianDate }).currentTime = Cesium.JulianDate.fromDate(
      new Date(chunk2StartSec * 1000 + 60_000),
    );
    await fireTick();

    const entityAfter = ds.entities.getById('hist:aircraft:ABC123');
    expect(entityAfter, 'the SAME entity must persist across the chunk boundary').toBe(entityBefore);
    expect(ds.entities.values.length, 'a chunk boundary must never removeAll()').toBe(1);

    const posAtChunk2 = entityAfter!.position!.getValue(
      Cesium.JulianDate.fromDate(new Date((chunk2StartSec + 60) * 1000)),
    )!;
    const [lon2] = lonLat(posAtChunk2);
    expect(lon2).toBeCloseTo(40.0, 3);

    const posAtChunk1 = entityAfter!.position!.getValue(
      Cesium.JulianDate.fromDate(new Date((chunk1StartSec + 60) * 1000)),
    )!;
    const [lon1] = lonLat(posAtChunk1);
    expect(lon1).toBeCloseTo(35.0, 3);
  });

  it('loadAt() resets the previous window — a fresh jump does removeAll, unlike a chunk-boundary tick', async () => {
    const { viewer, getDs } = fakeViewer();
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u === '/api/history/stats') return jsonResponse({ shards: [{ day: '2020-01-01' }] });
      if (u.startsWith('/api/history/tracks')) {
        return jsonResponse({
          tracks: [{ id: 'aircraft:OLD111', kind: 'aircraft', points: [[1.0, 1.0, 1_700_000_000, 0]] }],
        });
      }
      return jsonResponse({});
    });

    const controller = installHistoryPlayback(viewer);
    await controller.loadAt(1_700_000_000_000, 1_700_010_800_000);
    expect(getDs().entities.values.length).toBe(1);

    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u === '/api/history/stats') return jsonResponse({ shards: [{ day: '2020-01-01' }] });
      if (u.startsWith('/api/history/tracks')) {
        return jsonResponse({
          tracks: [{ id: 'aircraft:NEW222', kind: 'aircraft', points: [[2.0, 2.0, 1_800_000_000, 0]] }],
        });
      }
      return jsonResponse({});
    });

    await controller.loadAt(1_800_000_000_000, 1_800_010_800_000);
    const ds = getDs();
    expect(ds.entities.getById('hist:aircraft:OLD111'), 'a new loadAt() jump must clear the prior window').toBeUndefined();
    expect(ds.entities.getById('hist:aircraft:NEW222')).toBeDefined();
    expect(ds.entities.values.length).toBe(1);
  });
});

describe('HistoryPlayback: replay source routing reads stats.oldest_ts, not stats.shards (W3-1)', () => {
  // Timescale's history.stats() answers with `shards: []` (sharding is a
  // SQLite-only workaround) plus `oldest_ts` = MIN(t) as epoch seconds.
  // Resolving the own-archive floor from `shards` alone read every half hour
  // as "own archive", so the upstream (tar1090 heatmap) replay path never ran
  // on the backend this branch adds — the picker still offered 2024 days.
  const oldestMs = Date.UTC(2026, 0, 2, 12, 0, 0); // an exact UTC half hour
  const HALF_HOUR_MS = CHUNK_MS;

  /** One separator + one position row (32 bytes), the tar1090 heatmap shape
   *  heatmapChunk.ts decodes: hex `abcdef` at 33N/35E, timestamped at tsMs. */
  function upstreamChunk(tsMs: number): Response {
    const w = new Int32Array(8);
    w[0] = 0x0e7f7c9d; // separator marker
    w[1] = Math.floor(tsMs / 2 ** 32); // slice epoch ms, high word
    w[2] = tsMs % 2 ** 32; // slice epoch ms, low word
    w[3] = 30_000; // slice interval ms
    w[4] = 0x00abcdef; // hex
    w[5] = Math.round(33.0 * 1e6); // lat
    w[6] = Math.round(35.0 * 1e6); // lon
    w[7] = 0; // alt/gs
    return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => w.buffer } as unknown as Response;
  }

  function mockTimescaleStats(calls: string[]): void {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      calls.push(u);
      if (u === '/api/history/stats') {
        return jsonResponse({ backend: 'timescale', oldest_ts: oldestMs / 1000, shards: [] });
      }
      if (u.startsWith('/api/history/upstream/chunk')) return upstreamChunk(oldestMs - HALF_HOUR_MS);
      if (u.startsWith('/api/history/tracks')) return jsonResponse({ tracks: [] });
      return jsonResponse({});
    });
  }

  it('a half hour BEFORE oldest_ts fetches the upstream chunk and leaves aircraft out of the own fetch', async () => {
    const calls: string[] = [];
    mockTimescaleStats(calls);

    const { viewer, getDs } = fakeViewer();
    const controller = installHistoryPlayback(viewer);
    const info = await controller.loadAt(oldestMs - HALF_HOUR_MS, oldestMs);

    const upstream = calls.filter((u) => u.startsWith('/api/history/upstream/chunk'));
    expect(upstream, 'the upstream chunk was never requested').toHaveLength(1);
    expect(upstream[0]).toContain('index=');
    // Vessels are always the own archive; the own fetch must not also ask for
    // aircraft on a chunk whose aircraft come from upstream.
    expect(calls.some((u) => u.startsWith('/api/history/tracks') && u.includes('kind=vessel'))).toBe(true);
    expect(info?.source).toBe('upstream');
    expect(getDs().entities.getById('hist:aircraft:abcdef'), 'decoded upstream aircraft missing').toBeDefined();
  });

  it('a half hour starting AT oldest_ts stays on the own archive with no upstream call', async () => {
    const calls: string[] = [];
    mockTimescaleStats(calls);

    const { viewer } = fakeViewer();
    const controller = installHistoryPlayback(viewer);
    const info = await controller.loadAt(oldestMs, oldestMs + HALF_HOUR_MS);

    expect(calls.some((u) => u.startsWith('/api/history/tracks'))).toBe(true);
    expect(calls.filter((u) => u.startsWith('/api/history/upstream/chunk'))).toHaveLength(0);
    expect(info?.source).toBe('none');
  });
});

describe('HistoryPlayback: destroy() tears down the decode Worker (W3-3)', () => {
  // Stand-in for the DOM Worker so `createHeatmapDecoder()` takes its real
  // (non-jsdom-fallback) branch and its terminate() becomes observable.
  class FakeWorker {
    static instances: FakeWorker[] = [];
    terminated = false;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(): void {}
    terminate(): void {
      this.terminated = true;
    }
  }

  beforeEach(() => {
    FakeWorker.instances = [];
    mockedFetch.mockReset();
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('terminates the Worker when the viewer is ALREADY destroyed (HMR teardown / ErrorBoundary)', () => {
    // destroy() bails early on a destroyed viewer so it never touches the
    // viewer's data sources; pre-fix that early return also skipped
    // decoder.terminate(), so the Worker thread and its bundled module graph
    // outlived the component on exactly the teardown path it exists for.
    const { viewer } = fakeViewer({ destroyed: true });
    const controller = installHistoryPlayback(viewer);
    expect(FakeWorker.instances).toHaveLength(1);

    controller.destroy();

    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('still terminates the Worker on the ordinary teardown path', () => {
    const { viewer } = fakeViewer();
    const controller = installHistoryPlayback(viewer);

    controller.destroy();

    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });
});
