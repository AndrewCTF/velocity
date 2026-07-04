import { describe, it, expect, beforeEach } from 'vitest';
import { useWatchboxes } from './watchboxStore.js';

describe('watchboxStore.update', () => {
  beforeEach(() => useWatchboxes.getState().clear());

  it('patches a watchbox in place by id, leaving others + unset fields untouched', () => {
    const s = useWatchboxes.getState();
    const id = s.add({ label: 'A', center: { lat: 1, lon: 2 }, radiusKm: 1, rule: 'enter' });
    const other = s.add({ label: 'B', center: { lat: 3, lon: 4 }, radiusKm: 2, rule: 'exit' });

    s.update(id, { label: 'A2', radiusKm: 9, rule: 'loiter' });

    const wbs = useWatchboxes.getState().watchboxes;
    const w = wbs.find((x) => x.id === id)!;
    expect(w.label).toBe('A2');
    expect(w.radiusKm).toBe(9);
    expect(w.rule).toBe('loiter');
    expect(w.center).toEqual({ lat: 1, lon: 2 }); // not in patch → unchanged
    expect(wbs.find((x) => x.id === other)!.label).toBe('B'); // other untouched
  });
});
