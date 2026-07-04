// Terrain-aware route planner. Grids the bounding box of the clicked waypoints,
// samples real ground elevation (sim/terrain.ts, keyless Mapbox Terrain-RGB — which
// includes bathymetry, so ocean reads strongly negative and land positive), and
// A*-routes each leg so the line sits on a VALID path:
//   - naval: water-only — land cells (elev > SEA_M) are impassable, so the route
//     curves around coastlines instead of cutting across land.
//   - ground: every cell passable, but steep cells cost more, so the route prefers
//     valleys/flat ground over ridgelines.
//
// To route AROUND a large landmass the search box must enclose a water passage, so
// a blocked leg triggers an adaptive bbox expansion (a thin W–E leg past a tall
// island starts too narrow to go around it).
//
// ponytail: land/water is inferred from elevation (elev > SEA_M ≈ land). Ceiling:
// low-lying coast (<8 m) reads as water. Fine for an analyst-reviewed open-water /
// strait route; swap in a coastline raster if precision matters.

import { astarGrid, type CostGrid } from './astar.js';
import { haversineKm } from './projection.js';
import { sampleGroundLevel, type LatLon } from '../sim/terrain.js';

export type RouteMode = 'naval' | 'ground';

const SEA_M = 8; // ≤ this elevation counts as water
const MAX_CELLS = 2600; // grid budget (≈51×51) — bounds A* + terrain sampling
const SLOPE_W = 0.06; // ground cost per (m/km) of local slope
const SLOPE_MAX_ADD = 9; // cap the per-cell slope penalty
const PAD_SCALES = [0.6, 1.3, 2.6]; // adaptive bbox padding (× max span), escalated on a blocked leg

interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface RouteResult {
  coords: [number, number][]; // [lon,lat] dense routed path
  mode: RouteMode;
  blockedFallback: boolean; // a leg fell back to a straight segment (no path found)
  cells: number; // grid size actually used (telemetry)
}

// Pick a fixed terrain zoom from the bbox span so tile loads stay bounded
// (~10 tiles across the longest side).
function pickLevel(spanDeg: number): number {
  const lvl = Math.floor(Math.log2((360 / Math.max(spanDeg, 0.05)) * 10));
  return Math.max(6, Math.min(12, lvl));
}

export async function planRoute(waypoints: LatLon[], mode: RouteMode): Promise<RouteResult> {
  if (waypoints.length < 2) {
    return { coords: waypoints.map((p) => [p.lon, p.lat]), mode, blockedFallback: false, cells: 0 };
  }
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of waypoints) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
  }
  const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);

  // Try progressively larger search boxes; stop as soon as every leg routes. Only
  // hard legs (around a big landmass) pay for the extra terrain samples.
  let best: RouteResult | null = null;
  for (const scale of PAD_SCALES) {
    const pad = Math.max(maxSpan * scale, 0.5);
    const bbox: BBox = { minLat: minLat - pad, maxLat: maxLat + pad, minLon: minLon - pad, maxLon: maxLon + pad };
    const res = await routeOnBbox(waypoints, mode, bbox);
    if (!res.blockedFallback) return res;
    best = res;
  }
  return best!;
}

async function routeOnBbox(waypoints: LatLon[], mode: RouteMode, bbox: BBox): Promise<RouteResult> {
  const latSpan = bbox.maxLat - bbox.minLat;
  const lonSpan = bbox.maxLon - bbox.minLon;
  const aspect = lonSpan / latSpan || 1;
  let rows = Math.max(8, Math.round(Math.sqrt(MAX_CELLS / aspect)));
  let cols = Math.max(8, Math.round(rows * aspect));
  while (cols * rows > MAX_CELLS) { rows = Math.max(8, rows - 1); cols = Math.max(8, Math.round(rows * aspect)); }
  const cellLat = latSpan / (rows - 1);
  const cellLon = lonSpan / (cols - 1);
  const cellKm = Math.max(0.05, haversineKm(bbox.minLat, bbox.minLon, bbox.minLat + cellLat, bbox.minLon + cellLon));
  const cellLL = (c: number, r: number): LatLon => ({ lat: bbox.minLat + r * cellLat, lon: bbox.minLon + c * cellLon });

  // Sample elevation for every cell (one batched call at a bounded zoom).
  const pts: LatLon[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push(cellLL(c, r));
  const elev = await sampleGroundLevel(pts, pickLevel(Math.max(latSpan, lonSpan)));
  const at = (c: number, r: number): number => elev[r * cols + c] ?? 0;

  let enter: (c: number, r: number) => number;
  if (mode === 'naval') {
    enter = (c, r) => (at(c, r) > SEA_M ? Infinity : 1);
  } else {
    enter = (c, r) => {
      const e = at(c, r);
      const nb = [at(Math.max(0, c - 1), r), at(Math.min(cols - 1, c + 1), r), at(c, Math.max(0, r - 1)), at(c, Math.min(rows - 1, r + 1))];
      const slope = nb.reduce((s, v) => s + Math.abs(e - v), 0) / (4 * cellKm);
      return 1 + Math.min(SLOPE_MAX_ADD, slope * SLOPE_W);
    };
  }
  const grid: CostGrid = { cols, rows, enter };

  const toCell = (p: LatLon): [number, number] => [
    Math.max(0, Math.min(cols - 1, Math.round((p.lon - bbox.minLon) / cellLon))),
    Math.max(0, Math.min(rows - 1, Math.round((p.lat - bbox.minLat) / cellLat))),
  ];
  const snapWater = (cell: [number, number]): [number, number] => {
    if (mode !== 'naval' || Number.isFinite(enter(cell[0], cell[1]))) return cell;
    for (let rad = 1; rad < Math.max(cols, rows); rad++) {
      for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
        const nc = cell[0] + dc, nr = cell[1] + dr;
        if (nc >= 0 && nr >= 0 && nc < cols && nr < rows && Number.isFinite(enter(nc, nr))) return [nc, nr];
      }
    }
    return cell;
  };

  const out: [number, number][] = [[waypoints[0]!.lon, waypoints[0]!.lat]];
  let blockedFallback = false;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const start = snapWater(toCell(waypoints[i]!));
    const goal = snapWater(toCell(waypoints[i + 1]!));
    const path = astarGrid(grid, start, goal);
    if (!path) {
      blockedFallback = true;
      out.push([waypoints[i + 1]!.lon, waypoints[i + 1]!.lat]);
      continue;
    }
    const leg = simplify(path.map(([c, r]) => cellLL(c, r)));
    for (let k = 1; k < leg.length; k++) out.push([leg[k]!.lon, leg[k]!.lat]);
    out.push([waypoints[i + 1]!.lon, waypoints[i + 1]!.lat]);
  }
  return { coords: out, mode, blockedFallback, cells: cols * rows };
}

// Drop interior points that lie (near-)collinear with their neighbours so a long
// diagonal run becomes one segment. Keeps turns.
function simplify(pts: LatLon[], tol = 1e-4): LatLon[] {
  if (pts.length <= 2) return pts;
  const out: LatLon[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!, b = pts[i]!, c = pts[i + 1]!;
    const cross = (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
    if (Math.abs(cross) > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}
