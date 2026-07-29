import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAnnotations,
  useAnnoDraft,
  draftBase,
  annotationColor,
  annotationsToGeoJSON,
  annotationsFromGeoJSON,
  THREAT_COLOR,
  type AnnoKind,
} from './annotationStore.js';

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

describe('annotation store — kinds, history, round-trip', () => {
  beforeEach(() => {
    useAnnotations.setState({ annotations: [], past: [], future: [] });
  });

  it('supports every kind the renderer draws', () => {
    // The store used to declare three kinds while draw.ts already implemented
    // five modes, so polygon and rect were unreachable from an annotation.
    const kinds: AnnoKind[] = [
      'point', 'line', 'circle', 'polygon', 'rect',
      'arrow', 'corridor', 'sector', 'text', 'symbol', 'freehand',
    ];
    for (const kind of kinds) {
      useAnnotations.getState().add({ kind, label: kind, threat: 'unknown' });
    }
    expect(useAnnotations.getState().annotations).toHaveLength(kinds.length);
  });

  it('undo and redo walk the history', () => {
    const s = useAnnotations.getState();
    s.add({ kind: 'point', label: 'one', threat: 'hostile', coords: [[1, 2]] });
    s.add({ kind: 'point', label: 'two', threat: 'friendly', coords: [[3, 4]] });
    expect(useAnnotations.getState().annotations).toHaveLength(2);

    useAnnotations.getState().undo();
    expect(useAnnotations.getState().annotations).toHaveLength(1);
    useAnnotations.getState().undo();
    expect(useAnnotations.getState().annotations).toHaveLength(0);
    useAnnotations.getState().redo();
    expect(useAnnotations.getState().annotations).toHaveLength(1);
  });

  it('a locked annotation refuses updates', () => {
    const id = useAnnotations.getState().add({
      kind: 'point', label: 'pinned', threat: 'neutral', coords: [[0, 0]], locked: true,
    });
    useAnnotations.getState().update(id, { label: 'moved' });
    expect(useAnnotations.getState().annotations[0]!.label).toBe('pinned');
  });

  it('style overrides the threat colour, and falls back when absent', () => {
    const a = { id: 'x', kind: 'point' as const, label: '', threat: 'hostile' as const };
    expect(annotationColor(a)).toBe(THREAT_COLOR.hostile);
    expect(annotationColor({ ...a, style: { color: '#123456' } })).toBe('#123456');
  });

  it('exports to GeoJSON and reads its own export back', () => {
    const s = useAnnotations.getState();
    s.add({ kind: 'point', label: 'OBJ BRAVO', threat: 'hostile', coords: [[10, 20]] });
    s.add({ kind: 'line', label: 'route', threat: 'friendly', coords: [[0, 0], [1, 1]] });
    const json = annotationsToGeoJSON();
    expect(JSON.parse(json).features).toHaveLength(2);

    useAnnotations.setState({ annotations: [], past: [], future: [] });
    expect(annotationsFromGeoJSON(json)).toBe(2);
    const back = useAnnotations.getState().annotations;
    expect(back.map((a) => a.label).sort()).toEqual(['OBJ BRAVO', 'route']);
    expect(back.find((a) => a.label === 'route')!.kind).toBe('line');
  });

  it('the shared draft is what a placement surface reads', () => {
    // The toolbar hardcoded { threat: 'unknown', label: '' } and could only
    // place a point, so its own tooltip promised labelled markers and produced
    // unlabelled yellow dots.
    useAnnoDraft.getState().set({ kind: 'rect', threat: 'hostile', label: 'AO ALPHA' });
    useAnnoDraft.getState().setStyle({ width: 6 });
    const base = draftBase();
    expect(base.kind).toBe('rect');
    expect(base.threat).toBe('hostile');
    expect(base.label).toBe('AO ALPHA');
    expect(base.style?.width).toBe(6);
  });
});
