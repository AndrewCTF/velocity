import { describe, it, expect } from 'vitest';
import { LayerRegistry } from './LayerRegistry.js';
import { defaultLayers, registerDefaults } from './defaults.js';

describe('default layers', () => {
  it('registers all defaults exactly once', () => {
    const r = new LayerRegistry();
    registerDefaults(r);
    expect(r.list().map((l) => l.id).sort()).toEqual(
      defaultLayers.map((l) => l.id).sort(),
    );
  });

  it('is idempotent — second call does not throw', () => {
    const r = new LayerRegistry();
    registerDefaults(r);
    expect(() => registerDefaults(r)).not.toThrow();
    expect(r.list()).toHaveLength(defaultLayers.length);
  });

  it('enables every visibleByDefault layer at boot', () => {
    const r = new LayerRegistry();
    registerDefaults(r);
    for (const l of defaultLayers) {
      expect(r.isEnabled(l.id)).toBe(l.visibleByDefault);
    }
  });

  it('ships at least four visible-by-default layers — operator sees data on first paint', () => {
    const visible = defaultLayers.filter((l) => l.visibleByDefault);
    expect(visible.length).toBeGreaterThanOrEqual(4);
  });

  it('exposes the four Phase 1 sources expected by the plan', () => {
    const ids = defaultLayers.map((l) => l.id);
    expect(ids).toContain('hazards.usgs.quakes');
    expect(ids).toContain('aviation.opensky.states');
    expect(ids).toContain('hazards.nasa.firms');
    expect(ids).toContain('maritime.aisstream');
  });

  it('points every default at a same-origin backend route', () => {
    // Per plan §locked-decisions #3, no third-party host should leak into the
    // browser. Endpoints are either a relative path against our own proxy, or a
    // client-rendered sentinel (e.g. `notional://` for the MIL-STD-2525 COP,
    // which is drawn from a local store and never fetched) — neither leaks a
    // third-party host.
    for (const l of defaultLayers) {
      const ok = l.endpoint.startsWith('/') || l.endpoint.startsWith('notional://');
      expect(ok, `${l.id} endpoint=${l.endpoint}`).toBe(true);
    }
  });
});
