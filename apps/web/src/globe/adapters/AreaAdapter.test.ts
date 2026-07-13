import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { AreaAdapter, buildAreas } from './AreaAdapter.js';
import type { AdapterCtx } from './types.js';

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
