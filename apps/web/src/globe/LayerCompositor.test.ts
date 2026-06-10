import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LayerCompositor } from './LayerCompositor.js';
import { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds } from '../state/stores.js';
import type { LayerDescriptor } from '@osint/shared';

// We don't need a real Cesium viewer here — the compositor only touches
// viewer.dataSources.add/remove and viewer.scene.requestRender on the
// adapter side. We pass a stub.

const fakeViewer = (): unknown => ({
  dataSources: {
    add: vi.fn(async () => undefined),
    remove: vi.fn(() => true),
  },
  scene: { requestRender: vi.fn() },
});

const layer = (id: string, kind: LayerDescriptor['kind'] = 'geojson'): LayerDescriptor => ({
  id,
  group: 'hazards',
  title: id,
  kind,
  auth: 'none',
  endpoint: `/api/${id}`,
  refresh: { mode: 'pull', ttlSec: 60 },
  time: { temporal: false },
  crs: 'EPSG:4326',
  license: 'public',
  opacity: 1,
  visibleByDefault: true,
});

beforeEach(() => {
  useFeeds.setState({ feeds: {} });
  // stub fetch so PollGeoJsonAdapter doesn't hit network during attach
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 }),
  ) as unknown as typeof fetch;
});

describe('LayerCompositor', () => {
  it('starts an adapter for every enabled layer at start()', () => {
    const r = new LayerRegistry();
    r.register(layer('hazards.usgs.quakes'));
    r.register(layer('aviation.opensky.states'));
    const c = new LayerCompositor(r, fakeViewer() as never);
    c.start();
    // both layers should now show as amber with a "connecting" note
    const feeds = useFeeds.getState().feeds;
    expect(feeds['hazards.usgs.quakes']?.status).toBe('amber');
    expect(feeds['hazards.usgs.quakes']?.note).toBe('connecting');
    expect(feeds['aviation.opensky.states']?.status).toBe('amber');
    c.stop();
  });

  it('reacts to enable/disable events emitted after start()', () => {
    const r = new LayerRegistry();
    r.register(layer('hazards.usgs.quakes'));
    const c = new LayerCompositor(r, fakeViewer() as never);
    c.start();
    r.disable('hazards.usgs.quakes');
    expect(useFeeds.getState().feeds['hazards.usgs.quakes']?.status).toBe('unknown');
    r.enable('hazards.usgs.quakes');
    expect(useFeeds.getState().feeds['hazards.usgs.quakes']?.status).toBe('amber');
    c.stop();
  });

  it('skips unknown layer kinds gracefully', () => {
    const r = new LayerRegistry();
    r.register(layer('weird.thing', 'cog'));
    const c = new LayerCompositor(r, fakeViewer() as never);
    expect(() => c.start()).not.toThrow();
    // no adapter spawned → no feed-health entry
    expect(useFeeds.getState().feeds['weird.thing']).toBeUndefined();
    c.stop();
  });
});
