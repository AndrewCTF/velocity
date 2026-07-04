import { describe, it, expect, beforeEach } from 'vitest';
import { useAnnotations } from './annotationStore.js';

describe('annotationStore.update', () => {
  beforeEach(() => useAnnotations.getState().clear());

  it('patches label + threat in place by id without disturbing geometry', () => {
    const s = useAnnotations.getState();
    const id = s.add({ kind: 'circle', label: 'OBJ', threat: 'hostile', center: { lat: 5, lon: 6 }, radiusKm: 3 });

    s.update(id, { label: 'OBJ BRAVO', threat: 'friendly' });

    const a = useAnnotations.getState().annotations.find((x) => x.id === id)!;
    expect(a.label).toBe('OBJ BRAVO');
    expect(a.threat).toBe('friendly');
    expect(a.kind).toBe('circle'); // not in patch → unchanged
    expect(a.center).toEqual({ lat: 5, lon: 6 });
    expect(a.radiusKm).toBe(3);
  });
});
