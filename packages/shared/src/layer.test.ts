import { describe, it, expect } from 'vitest';
import { isLayerDescriptor, type LayerDescriptor } from './layer.js';

const valid: LayerDescriptor = {
  id: 'maritime.ais.aisstream',
  group: 'maritime',
  title: 'AIS — AISStream live',
  kind: 'websocket',
  auth: 'apikey',
  endpoint: 'wss://stream.aisstream.io/v0/stream',
  refresh: { mode: 'push' },
  time: { temporal: true },
  crs: 'EPSG:4326',
  license: 'AISStream beta',
  opacity: 1,
  visibleByDefault: true,
  emits: ['vessel'],
};

describe('isLayerDescriptor', () => {
  it('accepts a complete descriptor', () => {
    expect(isLayerDescriptor(valid)).toBe(true);
  });

  it('rejects null / non-object', () => {
    expect(isLayerDescriptor(null)).toBe(false);
    expect(isLayerDescriptor(undefined)).toBe(false);
    expect(isLayerDescriptor('layer')).toBe(false);
    expect(isLayerDescriptor(42)).toBe(false);
  });

  it('rejects descriptor missing required fields', () => {
    const noId = { ...valid } as Partial<LayerDescriptor>;
    delete noId.id;
    expect(isLayerDescriptor(noId)).toBe(false);

    const badOpacity = { ...valid, opacity: 'half' } as unknown;
    expect(isLayerDescriptor(badOpacity)).toBe(false);

    const noRefresh = { ...valid, refresh: null } as unknown;
    expect(isLayerDescriptor(noRefresh)).toBe(false);
  });

  it('preserves emits as a typed array', () => {
    expect(valid.emits).toEqual(['vessel']);
  });
});
