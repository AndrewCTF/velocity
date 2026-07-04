import { describe, it, expect } from 'vitest';
import { parseLatLon } from './SimulationOverlay.js';

describe('parseLatLon', () => {
  it('reads the two fields separately', () => {
    expect(parseLatLon('51.9', '4.4')).toEqual({ lat: 51.9, lon: 4.4 });
  });

  it('splits a pasted "lat, lon" pair in the lat field', () => {
    expect(parseLatLon('51.9,4.4', '')).toEqual({ lat: 51.9, lon: 4.4 });
    expect(parseLatLon('51.9, 4.4', 'ignored')).toEqual({ lat: 51.9, lon: 4.4 });
  });

  it('trims whitespace and accepts negatives', () => {
    expect(parseLatLon('  -33.9 ', ' 18.4 ')).toEqual({ lat: -33.9, lon: 18.4 });
  });

  it('rejects blank, non-numeric and out-of-range input', () => {
    expect(parseLatLon('', '4.4')).toBeNull();
    expect(parseLatLon('abc', '4.4')).toBeNull();
    expect(parseLatLon('91', '4.4')).toBeNull(); // lat > 90
    expect(parseLatLon('45', '181')).toBeNull(); // lon > 180
  });
});
