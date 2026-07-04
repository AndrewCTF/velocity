import { describe, it, expect, beforeEach } from 'vitest';
import { useControl, importGeoJSON, DEFAULT_FACTIONS } from './controlStore.js';
import { makeHatchCanvas } from '../globe/hatch.js';

describe('controlStore.importGeoJSON', () => {
  beforeEach(() => {
    useControl.setState({ factions: [...DEFAULT_FACTIONS], zones: [], lines: [] });
  });

  it('parses polygons into zones and lines into front lines', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { faction: 'Blue', status: 'controlled', label: 'SECTOR A' },
          geometry: { type: 'Polygon', coordinates: [[[30, 50], [31, 50], [31, 51], [30, 51], [30, 50]]] },
        },
        {
          type: 'Feature',
          properties: { status: 'contested', label: 'FLOT' },
          geometry: { type: 'LineString', coordinates: [[30.5, 50], [30.6, 50.5], [30.7, 51]] },
        },
      ],
    };
    const r = importGeoJSON(JSON.stringify(fc));
    expect(r.zones).toBe(1);
    expect(r.lines).toBe(1);

    const s = useControl.getState();
    expect(s.zones[0]!.label).toBe('SECTOR A');
    expect(s.zones[0]!.status).toBe('controlled');
    expect(s.zones[0]!.ring.length).toBe(5);
    expect(s.lines[0]!.status).toBe('contested');
    expect(s.lines[0]!.coords.length).toBe(3);
  });

  it('creates a faction on the fly for an unknown side', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { faction: 'Wagner' },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        },
      ],
    };
    importGeoJSON(JSON.stringify(fc));
    const facs = useControl.getState().factions;
    expect(facs.some((f) => f.name === 'Wagner')).toBe(true);
  });

  it('reports an error on invalid JSON without throwing', () => {
    const r = importGeoJSON('{not json');
    expect(r.zones).toBe(0);
    expect(r.errors[0]).toContain('invalid JSON');
  });

  it('skips a polygon with too few points', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } }],
    };
    const r = importGeoJSON(JSON.stringify(fc));
    expect(r.zones).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('makeHatchCanvas', () => {
  it('produces a sized canvas (dimensions set even when 2d ctx is unavailable in jsdom)', () => {
    const c = makeHatchCanvas('#38bdf8', false, 12);
    expect(c.width).toBe(12);
    expect(c.height).toBe(12);
  });
});
