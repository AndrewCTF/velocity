import { describe, it, expect } from 'vitest';
import { deriveFacets, entityPassesFilter, ALT_BANDS } from './HistogramPanel.js';
import type { FilterClause } from '../state/stores.js';

// Pure-logic tests for the faceted-filter primitives shared by the histogram
// panel and PollGeoJsonAdapter. No Cesium viewer, no network — just the
// classify-and-match functions.

describe('deriveFacets', () => {
  it('classifies an airliner by ADS-B category and derives US flag + alt band', () => {
    const f = deriveFacets({
      kind: 'aircraft',
      icao24: 'a808c1', // A-block → US
      category: 'A3',
      baro_alt_m: 10_500,
    });
    expect(f.kind).toBe('aircraft');
    expect(f.aircraftCategory).toBe('airliner');
    expect(f.flag).toBe('US');
    expect(f.altBucket).toBe('fl080_120'); // 8–12 km
    expect(f.vesselType).toBeNull();
    expect(f.squawks).toEqual([]);
  });

  it('classifies a helicopter (A7) and a glider (B1)', () => {
    expect(deriveFacets({ kind: 'aircraft', icao24: 'x', category: 'A7' }).aircraftCategory).toBe(
      'helicopter',
    );
    expect(deriveFacets({ kind: 'aircraft', icao24: 'x', category: 'B1' }).aircraftCategory).toBe(
      'glider',
    );
  });

  it('rolls an emergency squawk into both its code and the synthetic bucket', () => {
    const f = deriveFacets({ kind: 'aircraft', icao24: 'x', squawk: '7700' });
    expect(f.squawks).toContain('7700');
    expect(f.squawks).toContain('emergency');
    expect(f.aircraftCategory).toBe('emergency'); // styles.ts reds it out
  });

  it('buckets a ground aircraft separately from airborne', () => {
    expect(deriveFacets({ kind: 'aircraft', icao24: 'x', on_ground: true }).altBucket).toBe(
      'ground',
    );
    expect(deriveFacets({ kind: 'aircraft', icao24: 'x' }).altBucket).toBe('alt_unknown');
  });

  it('classifies a vessel by ITU ship type and derives flag from MMSI MID', () => {
    const f = deriveFacets({ kind: 'vessel', mmsi: 366123456, shipType: 70 });
    expect(f.kind).toBe('vessel');
    expect(f.vesselType).toBe('cargo');
    expect(f.flag).toBe('US'); // MID 366 → US
    expect(f.aircraftCategory).toBeNull();
    expect(f.altBucket).toBeNull();
  });

  it('maps an unknown ICAO block / MID to "other", and a missing id to null', () => {
    expect(deriveFacets({ kind: 'aircraft', icao24: '000001' }).flag).toBe('other');
    expect(deriveFacets({ kind: 'vessel', mmsi: 999999999 }).flag).toBe('other');
    expect(deriveFacets({ kind: 'aircraft' }).flag).toBeNull();
  });

  it('treats non-contact entities as kind "other"', () => {
    expect(deriveFacets({ kind: 'jamming' }).kind).toBe('other');
    expect(deriveFacets({}).kind).toBe('other');
  });

  it('alt bands are contiguous and ordered', () => {
    for (let i = 1; i < ALT_BANDS.length; i++) {
      expect(ALT_BANDS[i]!.lo).toBe(ALT_BANDS[i - 1]!.hi);
    }
  });
});

describe('entityPassesFilter', () => {
  const airliner = { kind: 'aircraft', icao24: 'a808c1', category: 'A3', baro_alt_m: 10_500 };
  const heli = { kind: 'aircraft', icao24: '3c1234', category: 'A7', baro_alt_m: 500 }; // DE
  const cargo = { kind: 'vessel', mmsi: 211000001, shipType: 70 }; // DE

  it('passes everything when there are no clauses', () => {
    expect(entityPassesFilter(airliner, [])).toBe(true);
  });

  it('"only" keeps matching and drops non-matching within a facet', () => {
    const only: FilterClause[] = [{ facet: 'aircraftCategory', value: 'airliner', mode: 'only' }];
    expect(entityPassesFilter(airliner, only)).toBe(true);
    expect(entityPassesFilter(heli, only)).toBe(false);
    // A vessel has no aircraftCategory → fails an aircraft-only filter.
    expect(entityPassesFilter(cargo, only)).toBe(false);
  });

  it('two "only" clauses on the same facet OR together', () => {
    const only: FilterClause[] = [
      { facet: 'aircraftCategory', value: 'airliner', mode: 'only' },
      { facet: 'aircraftCategory', value: 'helicopter', mode: 'only' },
    ];
    expect(entityPassesFilter(airliner, only)).toBe(true);
    expect(entityPassesFilter(heli, only)).toBe(true);
    expect(entityPassesFilter(cargo, only)).toBe(false);
  });

  it('"only" clauses across facets AND together', () => {
    const clauses: FilterClause[] = [
      { facet: 'aircraftCategory', value: 'airliner', mode: 'only' },
      { facet: 'flag', value: 'US', mode: 'only' },
    ];
    expect(entityPassesFilter(airliner, clauses)).toBe(true); // airliner AND US
    // German airliner would fail the flag group:
    expect(
      entityPassesFilter({ kind: 'aircraft', icao24: '3c1234', category: 'A3' }, clauses),
    ).toBe(false);
  });

  it('"not" excludes matching contacts', () => {
    const not: FilterClause[] = [{ facet: 'aircraftCategory', value: 'helicopter', mode: 'not' }];
    expect(entityPassesFilter(heli, not)).toBe(false);
    expect(entityPassesFilter(airliner, not)).toBe(true);
  });

  it('a "not" exclude beats an "only" include for the same entity', () => {
    const clauses: FilterClause[] = [
      { facet: 'flag', value: 'DE', mode: 'only' },
      { facet: 'aircraftCategory', value: 'helicopter', mode: 'not' },
    ];
    // heli is DE (would pass the only) but is a helicopter (excluded) → fails.
    expect(entityPassesFilter(heli, clauses)).toBe(false);
  });

  it('filters vessels by flag derived from MMSI', () => {
    const onlyDE: FilterClause[] = [{ facet: 'flag', value: 'DE', mode: 'only' }];
    expect(entityPassesFilter(cargo, onlyDE)).toBe(true);
    expect(entityPassesFilter({ kind: 'vessel', mmsi: 366000001 }, onlyDE)).toBe(false);
  });
});
