import { describe, it, expect } from 'vitest';
import { astarGrid, type CostGrid } from './astar.js';

// 5x5 grid with a vertical wall at column 2 (rows 0..3 blocked, row 4 open) —
// the path must detour down to row 4 to get around it.
function walled(): CostGrid {
  return {
    cols: 5,
    rows: 5,
    enter: (c, r) => (c === 2 && r < 4 ? Infinity : 1),
  };
}

describe('astarGrid', () => {
  it('routes around a wall', () => {
    const path = astarGrid(walled(), [0, 0], [4, 0]);
    expect(path).not.toBeNull();
    // start and goal correct
    expect(path![0]).toEqual([0, 0]);
    expect(path![path!.length - 1]).toEqual([4, 0]);
    // never steps on a blocked cell
    for (const [c, r] of path!) expect(c === 2 && r < 4).toBe(false);
    // must have dipped to the open row to pass the wall
    expect(path!.some(([, r]) => r === 4)).toBe(true);
  });

  it('returns null when goal is walled off', () => {
    const sealed: CostGrid = { cols: 3, rows: 3, enter: (c) => (c === 1 ? Infinity : 1) };
    expect(astarGrid(sealed, [0, 0], [2, 0])).toBeNull();
  });

  it('takes the straight diagonal on an open grid', () => {
    const open: CostGrid = { cols: 4, rows: 4, enter: () => 1 };
    const path = astarGrid(open, [0, 0], [3, 3]);
    expect(path).not.toBeNull();
    expect(path!.length).toBe(4); // 3 diagonal steps
  });
});
