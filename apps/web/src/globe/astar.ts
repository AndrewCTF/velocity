// Generic 8-connected grid A* — pure, no Cesium, unit-tested (astar.test.ts).
// The route planner supplies a cost grid (cost to ENTER a cell; Infinity = blocked)
// and start/goal cells; A* returns the cell path or null when unreachable.

export interface CostGrid {
  cols: number;
  rows: number;
  /** Cost to ENTER cell (c,r). Return Infinity for an impassable cell. */
  enter: (c: number, r: number) => number;
}

type Cell = [number, number];

// Minimal binary min-heap keyed by f-score (avoids an O(n) scan of the open set
// — a naive array search makes A* O(n^2) and janks the main thread on a 2.5k grid).
class MinHeap {
  private h: { idx: number; f: number }[] = [];
  get size(): number {
    return this.h.length;
  }
  push(idx: number, f: number): void {
    const h = this.h;
    h.push({ idx, f });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]!.f <= h[i]!.f) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }
  pop(): number {
    const h = this.h;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l]!.f < h[m]!.f) m = l;
        if (r < h.length && h[r]!.f < h[m]!.f) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top.idx;
  }
}

const SQRT2 = Math.SQRT2;

/**
 * 8-connected A* over a cost grid. Step cost = enter(neighbour) × (√2 for
 * diagonals). Heuristic = octile distance (admissible for 8-connectivity), so the
 * path is optimal. Returns the list of cells [c,r] from start to goal inclusive,
 * or null if no path exists. Diagonals are NOT allowed to cut between two blocked
 * cells (no corner-clipping through walls).
 */
export function astarGrid(grid: CostGrid, start: Cell, goal: Cell): Cell[] | null {
  const { cols, rows, enter } = grid;
  const idx = (c: number, r: number): number => r * cols + c;
  const N = cols * rows;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const [sc, sr] = start;
  const [gc, gr] = goal;
  const h = (c: number, r: number): number => {
    const dx = Math.abs(c - gc);
    const dy = Math.abs(r - gr);
    return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
  };

  const open = new MinHeap();
  g[idx(sc, sr)] = 0;
  open.push(idx(sc, sr), h(sc, sr));

  const blocked = (c: number, r: number): boolean => !Number.isFinite(enter(c, r));

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cc = cur % cols;
    const cr = (cur - cc) / cols;
    if (cc === gc && cr === gr) {
      // reconstruct
      const path: Cell[] = [];
      let p = cur;
      while (p !== -1) {
        const c = p % cols;
        path.push([c, (p - c) / cols]);
        p = came[p]!;
      }
      return path.reverse();
    }
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = idx(nc, nr);
        if (closed[ni]) continue;
        const stepEnter = enter(nc, nr);
        if (!Number.isFinite(stepEnter)) continue;
        // No corner-cutting: a diagonal move is illegal if it squeezes between two
        // blocked orthogonal neighbours.
        if (dc !== 0 && dr !== 0 && (blocked(cc + dc, cr) || blocked(cc, cr + dr))) continue;
        const step = stepEnter * (dc !== 0 && dr !== 0 ? SQRT2 : 1);
        const tentative = g[cur]! + step;
        if (tentative < g[ni]!) {
          g[ni] = tentative;
          came[ni] = cur;
          open.push(ni, tentative + h(nc, nr));
        }
      }
    }
  }
  return null;
}
