import { describe, it, expect } from 'vitest';
import * as Cesium from 'cesium';
import { dict, isUnsafeKey } from './safeKeys.js';
import { refreshBagInPlace } from '../globe/adapters/PollGeoJsonAdapter.js';
import { detCounts } from '../ground/detectionOverlay.js';

describe('prototype-pollution guards (ASVS V15.3.6)', () => {
  it('a feed property named __proto__ or constructor cannot touch a PropertyBag', () => {
    const bag = new Cesium.PropertyBag({ callsign: 'AAL1' });
    const protoBefore = Object.getPrototypeOf(bag);
    // JSON.parse makes __proto__ an own key, exactly as a hostile feed would.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "callsign": "AAL2"}');
    refreshBagInPlace(bag, hostile as Record<string, unknown>);
    expect(Object.getPrototypeOf(bag)).toBe(protoBefore);
    expect((bag as unknown as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(bag.hasProperty('constructor')).toBe(false);
    expect(bag.getValue(Cesium.JulianDate.now()).callsign).toBe('AAL2');
  });

  it('tallies keyed by network strings count __proto__ and constructor as data', () => {
    const counts = detCounts([
      { cls: '__proto__' },
      { cls: 'constructor' },
      { cls: 'constructor' },
      { cls: 'car' },
    ] as never);
    // Compare entries: an object literal `{ __proto__: 1 }` would itself set a prototype.
    expect([...counts].sort()).toEqual([['__proto__', 1], ['car', 1], ['constructor', 2]]);
  });

  it('dict() has no prototype and isUnsafeKey names the three keys', () => {
    const d = dict<number>();
    d['__proto__'] = 1;
    expect(Object.getPrototypeOf(d)).toBeNull();
    expect(Object.keys(d)).toEqual(['__proto__']);
    expect(['__proto__', 'constructor', 'prototype'].every(isUnsafeKey)).toBe(true);
    expect(isUnsafeKey('callsign')).toBe(false);
  });
});
