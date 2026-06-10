import { describe, it, expect, vi } from 'vitest';
import { LayerRegistry, type RegistryEvent } from './LayerRegistry.js';
import type { LayerDescriptor } from '@osint/shared';

const makeLayer = (id: string, opts: Partial<LayerDescriptor> = {}): LayerDescriptor => ({
  id,
  group: 'maritime',
  title: id,
  kind: 'geojson',
  auth: 'none',
  endpoint: `/api/${id}`,
  refresh: { mode: 'pull', ttlSec: 30 },
  time: { temporal: false },
  crs: 'EPSG:4326',
  license: 'public',
  opacity: 1,
  visibleByDefault: true,
  emits: ['vessel'],
  ...opts,
});

describe('LayerRegistry', () => {
  it('registers and lists layers', () => {
    const r = new LayerRegistry();
    r.register(makeLayer('a'));
    r.register(makeLayer('b'));
    expect(r.list().map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('rejects duplicate ids', () => {
    const r = new LayerRegistry();
    r.register(makeLayer('a'));
    expect(() => r.register(makeLayer('a'))).toThrow(/duplicate id/);
  });

  it('rejects invalid descriptors at runtime', () => {
    const r = new LayerRegistry();
    expect(() => r.register({ id: 'x' } as unknown as LayerDescriptor)).toThrow(/invalid descriptor/);
  });

  it('honours visibleByDefault', () => {
    const r = new LayerRegistry();
    r.register(makeLayer('on', { visibleByDefault: true }));
    r.register(makeLayer('off', { visibleByDefault: false }));
    expect(r.isEnabled('on')).toBe(true);
    expect(r.isEnabled('off')).toBe(false);
  });

  it('enable/disable transitions emit events exactly once', () => {
    const r = new LayerRegistry();
    const listener = vi.fn<(e: RegistryEvent) => void>();
    r.subscribe(listener);
    r.register(makeLayer('a', { visibleByDefault: false }));
    r.enable('a');
    r.enable('a'); // no-op
    r.disable('a');
    r.disable('a'); // no-op
    const types = listener.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['register', 'enable', 'disable']);
  });

  it('setOpacity validates range', () => {
    const r = new LayerRegistry();
    r.register(makeLayer('a'));
    r.setOpacity('a', 0.5);
    expect(r.get('a')?.opacity).toBe(0.5);
    expect(() => r.setOpacity('a', -0.1)).toThrow(RangeError);
    expect(() => r.setOpacity('a', 1.1)).toThrow(RangeError);
    expect(() => r.setOpacity('a', Number.NaN)).toThrow(RangeError);
  });

  it('setTimeWindow updates the descriptor immutably', () => {
    const r = new LayerRegistry();
    r.register(makeLayer('a', { time: { temporal: true } }));
    const before = r.get('a');
    r.setTimeWindow('a', '2026-05-24T00:00:00Z', '2026-05-24T23:59:59Z');
    const after = r.get('a');
    expect(after).not.toBe(before); // new object
    expect(after?.time.from).toBe('2026-05-24T00:00:00Z');
    expect(after?.time.to).toBe('2026-05-24T23:59:59Z');
  });

  it('unsubscribe stops events', () => {
    const r = new LayerRegistry();
    const listener = vi.fn<(e: RegistryEvent) => void>();
    const off = r.subscribe(listener);
    r.register(makeLayer('a'));
    off();
    r.register(makeLayer('b'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('require throws for unknown ids', () => {
    const r = new LayerRegistry();
    expect(() => r.enable('nope')).toThrow(/unknown id/);
    expect(() => r.disable('nope')).toThrow(/unknown id/);
    expect(() => r.setOpacity('nope', 0.5)).toThrow(/unknown id/);
  });
});
