import { describe, it, expect, beforeEach } from 'vitest';
import { useDetectionTriage } from './detectionTriage.js';

// Confirm/dismiss feedback + soak accumulation (§8 detection triage). The store
// is the tested core; the FMV panel is a thin view over it.
describe('detectionTriage', () => {
  beforeEach(() => {
    useDetectionTriage.setState({ confirmed: new Set(), dismissed: new Set(), soak: new Map() });
  });

  it('confirm marks confirmed and feeds one soak cell', () => {
    const s = useDetectionTriage.getState();
    s.confirm('d1', 0.5, 0.5);
    expect(useDetectionTriage.getState().status('d1')).toBe('confirmed');
    expect(useDetectionTriage.getState().soak.size).toBe(1);
  });

  it('two confirms in the same cell accumulate (n=2), different cells split', () => {
    const s = useDetectionTriage.getState();
    s.confirm('d1', 0.51, 0.51);
    s.confirm('d2', 0.52, 0.52); // same 24-grid cell as d1
    s.confirm('d3', 0.02, 0.02); // different cell
    const cells = useDetectionTriage.getState().soakCells();
    expect(cells.length).toBe(2);
    expect(Math.max(...cells.map((c) => c.n))).toBe(2);
  });

  it('dismiss overrides a prior confirm and vice-versa', () => {
    const s = useDetectionTriage.getState();
    s.confirm('d1', 0.5, 0.5);
    s.dismiss('d1');
    expect(useDetectionTriage.getState().status('d1')).toBe('dismissed');
    expect(useDetectionTriage.getState().confirmed.has('d1')).toBe(false);
  });

  it('clearSoak empties the density grid but keeps feedback', () => {
    const s = useDetectionTriage.getState();
    s.confirm('d1', 0.5, 0.5);
    s.clearSoak();
    expect(useDetectionTriage.getState().soak.size).toBe(0);
    expect(useDetectionTriage.getState().status('d1')).toBe('confirmed');
  });
});
