import { describe, it, expect } from 'vitest';
import { isObservation, type Observation } from './observation.js';

const valid: Observation = {
  id: 'opensky:abcd1234:1716552000000',
  source: 'opensky',
  t: 1_716_552_000_000,
  geom: { type: 'Point', coordinates: [-80.21, 25.83, 10500] },
  attrs: { icao24: 'abcd1234', callsign: 'TEST123', velocity: 230.1 },
  emitsKind: 'aircraft',
};

describe('isObservation', () => {
  it('accepts a complete observation', () => {
    expect(isObservation(valid)).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isObservation(null)).toBe(false);
    expect(isObservation({})).toBe(false);
    expect(isObservation({ ...valid, t: 'now' })).toBe(false);
    expect(isObservation({ ...valid, geom: null })).toBe(false);
    expect(isObservation({ ...valid, attrs: 'none' })).toBe(false);
  });
});
