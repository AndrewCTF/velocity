import { describe, it, expect, beforeEach } from 'vitest';
import { useFeeds, useSelection, useTime, useAlerts } from './stores.js';
import type { Alert } from '@osint/shared';

beforeEach(() => {
  useFeeds.setState({ feeds: {} });
  useSelection.setState({ selectedEntityId: null });
  useTime.setState({ playing: false, multiplier: 1, currentTime: 0, sceneMode: '3D' });
  useAlerts.setState({ alerts: [] });
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
