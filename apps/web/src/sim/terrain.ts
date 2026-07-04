// Terrain sampling for the sim — real ground elevation (mountains, hills,
// valleys) from the keyless /tiles/terrain proxy, independent of whether the
// globe is currently rendering terrain. Used for nap-of-earth flight (hug the
// ground) and line-of-sight masking (a ridge between a control station / SAM
// radar and a low-flying drone breaks the link / hides the drone).
//
// Sampling does network tile fetches, so callers sample ONCE per scenario
// (a profile along each route) and look the cached values up per tick.

import * as Cesium from 'cesium';
import { backendUrl } from '../transport/http.js';

export interface LatLon {
  lat: number;
  lon: number;
}

// Lazy — the cesium-martini worker factory touches URL.createObjectURL at import
// time, which blows up in jsdom/test. Loading it on first use keeps the pure
// helpers (lineMasked) importable in unit tests.
let _providerP: Promise<Cesium.TerrainProvider> | null = null;
async function provider(): Promise<Cesium.TerrainProvider> {
  if (!_providerP) {
    _providerP = import('@macrostrat/cesium-martini').then(
      (m) =>
        new m.MapboxTerrainProvider({
          urlTemplate: backendUrl('/tiles/terrain/{z}/{x}/{y}.png'),
          maxZoom: 15,
          tileSize: 256,
        }) as unknown as Cesium.TerrainProvider,
    );
  }
  return _providerP;
}

// Ground elevation (m) at each point. Returns 0s if terrain is unavailable so
// the caller degrades gracefully to flat-earth (LOS always clear, alt = MSL).
export async function sampleGround(points: LatLon[]): Promise<number[]> {
  if (points.length === 0) return [];
  const cartos = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
  try {
    await Cesium.sampleTerrainMostDetailed(await provider(), cartos);
    return cartos.map((c) => (Number.isFinite(c.height) ? c.height : 0));
  } catch {
    return points.map(() => 0);
  }
}

// Ground elevation (m) sampled at a FIXED zoom `level`, not most-detailed. The
// route planner grids a whole bbox (thousands of points); most-detailed (z15)
// would load thousands of tiles, so it caps the level by bbox span to bound tile
// loads. Same graceful-0 fallback as sampleGround.
export async function sampleGroundLevel(points: LatLon[], level: number): Promise<number[]> {
  if (points.length === 0) return [];
  const cartos = points.map((p) => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
  try {
    await Cesium.sampleTerrain(await provider(), Math.max(0, Math.round(level)), cartos);
    return cartos.map((c) => (Number.isFinite(c.height) ? c.height : 0));
  } catch {
    return points.map(() => 0);
  }
}

function lerpPoints(a: LatLon, b: LatLon, n: number): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 1; i < n; i++) {
    const f = i / n;
    out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
  }
  return out;
}

// Is the straight 3D sight-line from A (at altA m) to B (at altB m) broken by
// terrain in between? Samples intermediate ground heights and checks whether any
// rises above the line (minus a clearance margin). Pure given the sampled
// heights — exported helper `lineMasked` is unit-tested without network.
export async function losBlocked(
  a: LatLon & { alt: number },
  b: LatLon & { alt: number },
  samples = 20,
  clearanceM = 15,
): Promise<boolean> {
  const pts = lerpPoints(a, b, samples);
  const ground = await sampleGround(pts);
  return lineMasked(a.alt, b.alt, ground, clearanceM);
}

// Pure terrain-masking test: given endpoint altitudes and the ground heights at
// the evenly-spaced interior points, is the line of sight blocked?
export function lineMasked(altA: number, altB: number, ground: number[], clearanceM = 15): boolean {
  const n = ground.length + 1;
  for (let i = 0; i < ground.length; i++) {
    const f = (i + 1) / n;
    const lineH = altA + (altB - altA) * f;
    if (ground[i]! > lineH - clearanceM) return true;
  }
  return false;
}

// Sample a ground-height profile along a route (launch→target) at `n` points,
// for nap-of-earth altitude lookup. Returns heights for fractions 0..1.
export async function routeGroundProfile(launch: LatLon, target: LatLon, n = 32): Promise<number[]> {
  const pts: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push({ lat: launch.lat + (target.lat - launch.lat) * f, lon: launch.lon + (target.lon - launch.lon) * f });
  }
  return sampleGround(pts);
}

// Lookup a value from a 0..1-indexed profile at fraction f (nearest sample).
export function profileAt(profile: number[], f: number): number {
  if (profile.length === 0) return 0;
  const i = Math.max(0, Math.min(profile.length - 1, Math.round(f * (profile.length - 1))));
  return profile[i]!;
}
