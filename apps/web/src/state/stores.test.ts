import { describe, it, expect, beforeEach } from 'vitest';
import {
  useFeeds,
  useSelection,
  useTime,
  useAlerts,
  useFilters,
  useImagery,
  matchesFilterClauses,
  type FilterClause,
  type FilterFacet,
} from './stores.js';
import type { Alert } from '@osint/shared';

beforeEach(() => {
  useFeeds.setState({ feeds: {} });
  useSelection.setState({ selectedEntityId: null });
  useTime.setState({ playing: false, multiplier: 1, currentTime: 0, sceneMode: '3D' });
  useAlerts.setState({ alerts: [] });
  useFilters.setState({ clauses: [], epoch: 0 });
});

describe('useFeeds', () => {
  it('upserts a feed and preserves siblings', () => {
    useFeeds.getState().setFeed({ id: 'opensky', label: 'ADS-B', status: 'green' });
    useFeeds.getState().setFeed({ id: 'aisstream', label: 'AIS', status: 'amber' });
    useFeeds.getState().setFeed({ id: 'opensky', label: 'ADS-B', status: 'red' });
    const f = useFeeds.getState().feeds;
    expect(f['opensky']?.status).toBe('red');
    expect(f['aisstream']?.status).toBe('amber');
  });
});

describe('useTime', () => {
  it('togglePlay flips', () => {
    expect(useTime.getState().playing).toBe(false);
    useTime.getState().togglePlay();
    expect(useTime.getState().playing).toBe(true);
  });

  it('multiplier rejects out-of-range', () => {
    expect(() => useTime.getState().setMultiplier(0)).toThrow(RangeError);
    expect(() => useTime.getState().setMultiplier(3601)).toThrow(RangeError);
    useTime.getState().setMultiplier(600);
    expect(useTime.getState().multiplier).toBe(600);
  });
});

describe('useAlerts', () => {
  const make = (id: string): Alert => ({
    id,
    ruleId: 'ais_gap_sar',
    severity: 'high',
    t: Date.now(),
    geom: { type: 'Point', coordinates: [0, 0] },
    confidence: 0.8,
    message: 'dark vessel candidate',
    contributingObservations: [],
  });

  it('pushes newest-first', () => {
    useAlerts.getState().push(make('a'));
    useAlerts.getState().push(make('b'));
    expect(useAlerts.getState().alerts.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('caps the ring buffer', () => {
    for (let i = 0; i < 600; i++) useAlerts.getState().push(make(`a${i}`));
    expect(useAlerts.getState().alerts.length).toBe(500);
  });
});

describe('useSelection', () => {
  it('select / clear', () => {
    useSelection.getState().select('vessel:367719770');
    expect(useSelection.getState().selectedEntityId).toBe('vessel:367719770');
    useSelection.getState().select(null);
    expect(useSelection.getState().selectedEntityId).toBeNull();
  });
});

describe('useFilters', () => {
  it('toggles a clause on and off and bumps epoch', () => {
    const f = useFilters.getState();
    expect(f.clauses).toHaveLength(0);
    f.toggleClause('aircraftCategory', 'airliner', 'only');
    expect(useFilters.getState().clauses).toEqual([
      { facet: 'aircraftCategory', value: 'airliner', mode: 'only' },
    ]);
    expect(useFilters.getState().epoch).toBe(1);
    // Clicking the same chip again removes it.
    useFilters.getState().toggleClause('aircraftCategory', 'airliner', 'only');
    expect(useFilters.getState().clauses).toHaveLength(0);
    expect(useFilters.getState().epoch).toBe(2);
  });

  it('setting one mode drops the opposite for the same facet+value', () => {
    useFilters.getState().toggleClause('flag', 'US', 'only');
    useFilters.getState().toggleClause('flag', 'US', 'not'); // contradicts → replaces
    const clauses = useFilters.getState().clauses;
    expect(clauses).toEqual([{ facet: 'flag', value: 'US', mode: 'not' }]);
  });

  it('clearFacet drops only that facet; clear drops all', () => {
    const f = useFilters.getState();
    f.toggleClause('aircraftCategory', 'military', 'only');
    f.toggleClause('flag', 'RU', 'only');
    useFilters.getState().clearFacet('flag');
    expect(useFilters.getState().clauses).toEqual([
      { facet: 'aircraftCategory', value: 'military', mode: 'only' },
    ]);
    useFilters.getState().clear();
    expect(useFilters.getState().clauses).toHaveLength(0);
  });

  it('isActive reflects the current clause set', () => {
    useFilters.getState().toggleClause('squawk', '7700', 'only');
    expect(useFilters.getState().isActive('squawk', '7700', 'only')).toBe(true);
    expect(useFilters.getState().isActive('squawk', '7700', 'not')).toBe(false);
  });
});

describe('useImagery lod1 auto-fill toggle', () => {
  beforeEach(() => useImagery.setState({ lod1Auto: false }));

  it('defaults off and toggles the keyless auto-fill flag', () => {
    expect(useImagery.getState().lod1Auto).toBe(false);
    useImagery.getState().setLod1Auto(true);
    expect(useImagery.getState().lod1Auto).toBe(true);
    useImagery.getState().setLod1Auto(false);
    expect(useImagery.getState().lod1Auto).toBe(false);
  });
});

describe('matchesFilterClauses (pure)', () => {
  // A resolver mapping each facet to the values a hypothetical entity carries.
  const resolverFor =
    (carried: Partial<Record<FilterFacet, string[]>>) =>
    (facet: FilterFacet): readonly string[] =>
      carried[facet] ?? [];

  it('empty clause list passes everything', () => {
    expect(matchesFilterClauses([], resolverFor({ aircraftCategory: ['airliner'] }))).toBe(true);
  });

  it('only-include OR within facet, AND across facets', () => {
    const clauses: FilterClause[] = [
      { facet: 'aircraftCategory', value: 'airliner', mode: 'only' },
      { facet: 'aircraftCategory', value: 'military', mode: 'only' },
      { facet: 'flag', value: 'US', mode: 'only' },
    ];
    // military + US → passes (OR within category, AND across to flag)
    expect(matchesFilterClauses(clauses, resolverFor({ aircraftCategory: ['military'], flag: ['US'] }))).toBe(true);
    // airliner but GB → fails the flag group
    expect(matchesFilterClauses(clauses, resolverFor({ aircraftCategory: ['airliner'], flag: ['GB'] }))).toBe(false);
    // no category value at all → fails the category group
    expect(matchesFilterClauses(clauses, resolverFor({ flag: ['US'] }))).toBe(false);
  });

  it('not-exclude rejects regardless of includes', () => {
    const clauses: FilterClause[] = [
      { facet: 'vesselType', value: 'tanker', mode: 'not' },
    ];
    expect(matchesFilterClauses(clauses, resolverFor({ vesselType: ['tanker'] }))).toBe(false);
    expect(matchesFilterClauses(clauses, resolverFor({ vesselType: ['cargo'] }))).toBe(true);
  });
});
