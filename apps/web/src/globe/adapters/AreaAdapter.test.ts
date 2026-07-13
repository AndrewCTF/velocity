import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Cesium from 'cesium';

vi.mock('../../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../transport/http.js';
import { AreaAdapter, buildAreas } from './AreaAdapter.js';
import { resetEventShapeCache, shapeKey, cachedShape, SHAPE_MISS } from './eventShapes.js';
import type { AdapterCtx } from './types.js';

const mockedFetch = vi.mocked(apiFetch);

// radius_m uncertainty ellipse: a conflict/incident feature carrying a
// plausible-area radius (meters) renders a translucent ground ellipse on the
// SAME entity as its glyph billboard; absent/invalid/oversized radii render as
// a bare glyph. Drives the real buildAreas -> render path headlessly (Cesium
// entities are pure JS; the fake ctx only needs requestRender), mirroring the
// propertyBagRefresh.test.ts pattern of exercising adapter internals directly.

const NOW = Cesium.JulianDate.now();

function makeAdapter(): AreaAdapter {
  const ctx = {
    descriptor: { id: 'conflict.gdelt.live' },
    viewer: { scene: { requestRender: () => {} } },
    reportStatus: () => {},
  } as unknown as AdapterCtx;
  return new AreaAdapter({ ctx, endpoint: '/api/conflict/live', kind: 'conflict', intervalSec: 900 });
}

type Areas = ReturnType<typeof buildAreas>;
function render(adapter: AreaAdapter, areas: Areas): void {
  (adapter as unknown as { render(a: Areas): void }).render(areas);
}

function feat(lon: number, lat: number, props: Record<string, unknown>): Record<string, unknown> {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props };
}

function conflictJson(...feats: Record<string, unknown>[]): unknown {
  return { type: 'FeatureCollection', features: feats };
}

describe('AreaAdapter radius_m uncertainty ellipse', () => {
  it('feature with radius_m gets an ellipse with matching semi axes + severity colour', () => {
    const adapter = makeAdapter();
    const areas = buildAreas(
      'conflict',
      conflictJson(feat(30.5, 50.5, { label: 'air strike', root: '19', mentions: 3, radius_m: 50_000 })),
    );
    expect(areas).toHaveLength(1);
    const a0 = areas[0]!;
    expect(a0.radiusM).toBe(50_000);
    render(adapter, areas);

    const ent = adapter.ds.entities.getById(a0.key);
    expect(ent).toBeDefined();
    expect(ent?.ellipse).toBeDefined();
    expect(ent?.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(50_000);
    expect(ent?.ellipse?.semiMinorAxis?.getValue(NOW)).toBe(50_000);
    // Static geometry only — requestRenderMode friendly, never a CallbackProperty.
    expect(ent?.ellipse?.semiMajorAxis).toBeInstanceOf(Cesium.ConstantProperty);
    // Translucent fill + stronger outline in the event's severity colour
    // ('air strike' -> C_STRIKE #ef4444, same colour the billboard glyph uses).
    const fill = (ent?.ellipse?.material as Cesium.ColorMaterialProperty).color?.getValue(NOW);
    expect(fill.alpha).toBeCloseTo(0.14, 5);
    const outline = ent?.ellipse?.outlineColor?.getValue(NOW);
    expect(outline.alpha).toBeCloseTo(0.5, 5);
    expect(fill.withAlpha(1).toCssHexString().toLowerCase()).toBe('#ef4444');
    // Ground-clamped like the jamming/TFR polygons (height 0 + TERRAIN classification).
    expect(ent?.ellipse?.height?.getValue(NOW)).toBe(0);
    expect(ent?.ellipse?.classificationType?.getValue(NOW)).toBe(Cesium.ClassificationType.TERRAIN);
    // The glyph billboard is untouched — ellipse is IN ADDITION to the pin.
    expect(ent?.billboard).toBeDefined();
  });

  it('feature without radius_m gets no ellipse (glyph billboard only)', () => {
    const adapter = makeAdapter();
    const areas = buildAreas(
      'conflict',
      conflictJson(feat(31.5, 51.5, { label: 'armed clash', root: '19', mentions: 2 })),
    );
    const a0 = areas[0]!;
    expect(a0.radiusM).toBeNull();
    render(adapter, areas);
    const ent = adapter.ds.entities.getById(a0.key);
    expect(ent).toBeDefined();
    expect(ent?.ellipse).toBeUndefined();
    expect(ent?.billboard).toBeDefined();
  });

  it('radius_m > 120000 (and other junk values) gets no ellipse', () => {
    const adapter = makeAdapter();
    const junk = [200_000, 0, -5, NaN, null, 'wat'];
    const areas = buildAreas(
      'conflict',
      conflictJson(
        ...junk.map((r, i) => feat(10 + i, 20, { label: 'shelling', root: '19', mentions: 1, radius_m: r })),
      ),
    );
    expect(areas).toHaveLength(junk.length);
    for (const a of areas) expect(a.radiusM).toBeNull();
    render(adapter, areas);
    for (const a of areas) {
      expect(adapter.ds.entities.getById(a.key)?.ellipse).toBeUndefined();
    }
  });

  it('incidents kind carries radius_m through to an ellipse too', () => {
    const ctx = {
      descriptor: { id: 'intel.incidents' },
      viewer: { scene: { requestRender: () => {} } },
      reportStatus: () => {},
    } as unknown as AdapterCtx;
    const adapter = new AreaAdapter({ ctx, endpoint: '/api/intel/incidents', kind: 'incidents', intervalSec: 60 });
    const areas = buildAreas('incidents', {
      incidents: [
        {
          centroid: { lon: 5, lat: 6 },
          threat_level: 'high',
          domains: ['military'],
          narrative: 'strike on depot',
          radius_m: 8_000,
        },
      ],
    });
    const a0 = areas[0]!;
    expect(a0.radiusM).toBe(8_000);
    render(adapter, areas);
    const ent = adapter.ds.entities.getById(a0.key);
    expect(ent?.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(8_000);
  });

  it('upsert path: a later poll updates, adds, or drops the ellipse in place', () => {
    const adapter = makeAdapter();
    const mk = (radius: unknown): Areas =>
      buildAreas(
        'conflict',
        conflictJson(feat(30.5, 50.5, { label: 'air strike', root: '19', mentions: 3, radius_m: radius })),
      );
    render(adapter, mk(50_000));
    const key = mk(50_000)[0]!.key;
    // radius change -> same entity, new axes (upsert-by-id, never remove+add).
    render(adapter, mk(12_000));
    expect(adapter.ds.entities.values).toHaveLength(1);
    expect(adapter.ds.entities.getById(key)?.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(12_000);
    // radius disappears -> ellipse dropped, glyph stays.
    render(adapter, mk(null));
    const ent = adapter.ds.entities.getById(key);
    expect(ent?.ellipse).toBeUndefined();
    expect(ent?.billboard).toBeDefined();
    // radius reappears -> ellipse restored on the same entity.
    render(adapter, mk(9_000));
    expect(adapter.ds.entities.getById(key)?.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(9_000);
  });
});

// Admin-shape resolution: features carrying iso3 + shape_level get their REAL
// admin polygon (POST /api/geo/event-shapes, mocked here) swapped in for the
// uncertainty ellipse on the SAME entity; miss / malformed geometry keeps the
// ellipse; the module-level cache prevents refetching a key within a session.

// Event at (30.5, 50.5) → server key with lat/lon rounded to 3 decimals.
const SHAPE_KEY = shapeKey({ iso3: 'UKR', level: 'adm1', lat: 50.5, lon: 30.5 });

function shapedAreas() {
  return buildAreas(
    'conflict',
    conflictJson(
      feat(30.5, 50.5, {
        label: 'air strike',
        root: '19',
        mentions: 3,
        radius_m: 50_000,
        iso3: 'UKR',
        shape_level: 'adm1',
      }),
    ),
  );
}

// A simplified admin1 square around the event point, with one hole.
const ADM1_GEOMETRY = {
  type: 'Polygon',
  coordinates: [
    [
      [30, 50],
      [31, 50],
      [31, 51],
      [30, 51],
      [30, 50],
    ],
    [
      [30.1, 50.1],
      [30.2, 50.1],
      [30.2, 50.2],
      [30.1, 50.2],
      [30.1, 50.1],
    ],
  ],
};

function shapeResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

describe('AreaAdapter admin-shape polygons (/api/geo/event-shapes)', () => {
  beforeEach(() => {
    resetEventShapeCache();
    mockedFetch.mockReset();
  });

  it('iso3+shape_level feature: ellipse is replaced by the admin polygon on the same entity', async () => {
    mockedFetch.mockResolvedValue(
      shapeResponse({
        shapes: [
          { keys: [SHAPE_KEY], id: 'UKR.13_1', name: 'Kyiv', level: 'adm1', iso3: 'UKR', geometry: ADM1_GEOMETRY },
        ],
        misses: [],
      }),
    );
    const adapter = makeAdapter();
    const areas = shapedAreas();
    expect(areas[0]!.iso3).toBe('UKR');
    expect(areas[0]!.shapeLevel).toBe('adm1');
    render(adapter, areas);
    const ent = adapter.ds.entities.getById(areas[0]!.key)!;
    // Circle fallback shows until the shape resolves.
    expect(ent.ellipse).toBeDefined();

    await vi.waitFor(() => expect(ent.polygon).toBeDefined());
    // POSTed the documented body shape to the right endpoint via apiFetch.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0]!;
    expect(url).toBe('/api/geo/event-shapes');
    expect(JSON.parse(String(init!.body))).toEqual({
      queries: [{ lat: 50.5, lon: 30.5, level: 'adm1', iso3: 'UKR' }],
    });
    // Ellipse removed; polygon carries the real ring (outer + hole), static.
    expect(ent.ellipse).toBeUndefined();
    const hier = ent.polygon!.hierarchy!.getValue(NOW) as Cesium.PolygonHierarchy;
    expect(hier.positions.length).toBeGreaterThan(2);
    expect(hier.holes).toHaveLength(1);
    expect(ent.polygon!.hierarchy).toBeInstanceOf(Cesium.ConstantProperty);
    // Same severity treatment as the ellipse: 0.14 fill / 0.5 outline, grounded.
    const fill = (ent.polygon!.material as Cesium.ColorMaterialProperty).color!.getValue(NOW);
    expect(fill.alpha).toBeCloseTo(0.14, 5);
    expect(fill.withAlpha(1).toCssHexString().toLowerCase()).toBe('#ef4444');
    expect(ent.polygon!.outlineColor!.getValue(NOW).alpha).toBeCloseTo(0.5, 5);
    expect(ent.polygon!.height!.getValue(NOW)).toBe(0);
    expect(ent.polygon!.classificationType!.getValue(NOW)).toBe(Cesium.ClassificationType.TERRAIN);
    // Billboard glyph untouched — the swap never recreates the entity.
    expect(ent.billboard).toBeDefined();
  });

  it('server miss: ellipse retained, polygon never applied, miss cached', async () => {
    mockedFetch.mockResolvedValue(shapeResponse({ shapes: [], misses: [SHAPE_KEY] }));
    const adapter = makeAdapter();
    const areas = shapedAreas();
    render(adapter, areas);
    await vi.waitFor(() => expect(cachedShape(SHAPE_KEY)).toBe(SHAPE_MISS));
    const ent = adapter.ds.entities.getById(areas[0]!.key)!;
    expect(ent.polygon).toBeUndefined();
    expect(ent.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(50_000);
    // A second pass never refetches a cached miss.
    render(adapter, shapedAreas());
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('malformed geometry: ellipse retained, no throw', async () => {
    mockedFetch.mockResolvedValue(
      shapeResponse({
        shapes: [
          { keys: [SHAPE_KEY], id: 'x', name: 'x', level: 'adm1', iso3: 'UKR', geometry: { type: 'Polygon', coordinates: 'garbage' } },
        ],
        misses: [],
      }),
    );
    const adapter = makeAdapter();
    const areas = shapedAreas();
    render(adapter, areas);
    await vi.waitFor(() => expect(cachedShape(SHAPE_KEY)).toBe(SHAPE_MISS));
    const ent = adapter.ds.entities.getById(areas[0]!.key)!;
    expect(ent.polygon).toBeUndefined();
    expect(ent.ellipse?.semiMajorAxis?.getValue(NOW)).toBe(50_000);
  });

  it('cache prevents duplicate fetches across render passes; polygon survives repolls', async () => {
    mockedFetch.mockResolvedValue(
      shapeResponse({
        shapes: [
          { keys: [SHAPE_KEY], id: 'UKR.13_1', name: 'Kyiv', level: 'adm1', iso3: 'UKR', geometry: ADM1_GEOMETRY },
        ],
        misses: [],
      }),
    );
    const adapter = makeAdapter();
    render(adapter, shapedAreas());
    const key = shapedAreas()[0]!.key;
    const ent = adapter.ds.entities.getById(key)!;
    await vi.waitFor(() => expect(ent.polygon).toBeDefined());
    const firstPolygon = ent.polygon;
    // Later poll, same feature: cache hit — no second fetch, polygon stays,
    // entity not recreated, ellipse not resurrected.
    render(adapter, shapedAreas());
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(adapter.ds.entities.values).toHaveLength(1);
    expect(adapter.ds.entities.getById(key)).toBe(ent);
    expect(ent.polygon).toBe(firstPolygon);
    expect(ent.ellipse).toBeUndefined();
    // A second adapter (fresh instance, same session) also hits the cache.
    const adapter2 = makeAdapter();
    render(adapter2, shapedAreas());
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(adapter2.ds.entities.getById(key)?.polygon).toBeDefined();
  });

  it('MultiPolygon: renders the part containing the event point', async () => {
    const far = [
      [
        [10, 10],
        [12, 10],
        [12, 12],
        [10, 12],
        [10, 10],
      ],
    ];
    mockedFetch.mockResolvedValue(
      shapeResponse({
        shapes: [
          {
            keys: [SHAPE_KEY],
            id: 'x',
            name: 'x',
            level: 'adm1',
            iso3: 'UKR',
            geometry: { type: 'MultiPolygon', coordinates: [far, ADM1_GEOMETRY.coordinates] },
          },
        ],
        misses: [],
      }),
    );
    const adapter = makeAdapter();
    const areas = shapedAreas();
    render(adapter, areas);
    const ent = adapter.ds.entities.getById(areas[0]!.key)!;
    await vi.waitFor(() => expect(ent.polygon).toBeDefined());
    const hier = ent.polygon!.hierarchy!.getValue(NOW) as Cesium.PolygonHierarchy;
    // The containing part (the square around 30.5,50.5), not the far one.
    const carto = Cesium.Cartographic.fromCartesian(hier.positions[0]!);
    expect(Cesium.Math.toDegrees(carto.longitude)).toBeCloseTo(30, 3);
    expect(Cesium.Math.toDegrees(carto.latitude)).toBeCloseTo(50, 3);
  });

  it('feature that moved on a later poll drops the stale polygon back to the ellipse and refetches', async () => {
    mockedFetch.mockResolvedValue(
      shapeResponse({
        shapes: [
          { keys: [SHAPE_KEY], id: 'x', name: 'x', level: 'adm1', iso3: 'UKR', geometry: ADM1_GEOMETRY },
        ],
        misses: [],
      }),
    );
    const adapter = makeAdapter();
    render(adapter, shapedAreas());
    const key = shapedAreas()[0]!.key;
    const ent = adapter.ds.entities.getById(key)!;
    await vi.waitFor(() => expect(ent.polygon).toBeDefined());
    // Same merge cell (0.1° rounding → same entity key), new exact coords →
    // new shape key → re-evaluated: polygon dropped, ellipse fallback returns,
    // and a fetch for the NEW key goes out.
    const moved = buildAreas(
      'conflict',
      conflictJson(
        feat(30.52, 50.52, {
          label: 'air strike',
          root: '19',
          mentions: 3,
          radius_m: 50_000,
          iso3: 'UKR',
          shape_level: 'adm1',
        }),
      ),
    );
    expect(moved[0]!.key).toBe(key);
    render(adapter, moved);
    expect(ent.polygon).toBeUndefined();
    expect(ent.ellipse).toBeDefined();
    await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(mockedFetch.mock.calls[1]![1]!.body));
    expect(body.queries[0]).toEqual({ lat: 50.52, lon: 30.52, level: 'adm1', iso3: 'UKR' });
  });
});
