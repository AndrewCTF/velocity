// Simulated FMV (Full-Motion Video) detection engine — SIM-DERIVED, NOT CV.
//
// Given a focal drone's sensor footprint (modelled as a ground-projected circle)
// and the set of other sim agents / known fixed points, this module projects
// which of them fall inside the footprint and emits Detection records with
// plausible (but purely synthetic) bounding boxes and confidence scores.
//
// IMPORTANT: this module performs NO real computer vision or image processing.
// All values are deterministically computed from sim geometry. Every caller
// MUST display a NOTIONAL // SIMULATED caveat alongside any output.

import type { LatLon } from '../sim/types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type DetectionClass = 'vehicle' | 'aircraft' | 'structure' | 'drone';

export interface Detection {
  /** Stable id tied to the source agent / point so the bbox survives re-renders. */
  id: string;
  cls: DetectionClass;
  /** Confidence 0..1 — higher toward footprint centre. */
  conf: number;
  /** Bounding box in normalised image space (0..1 each axis). */
  bbox: { x: number; y: number; w: number; h: number };
}

/** Counts of each detection class across a Detection[]. */
export interface ClassCounts {
  vehicle: number;
  aircraft: number;
  structure: number;
  drone: number;
}

/** A focal drone: everything the sensor needs to project a footprint. */
export interface FocalDrone {
  lat: number;
  lon: number;
  /** Altitude in metres (used to size the footprint). */
  altM: number;
  /** True heading 0..360. */
  heading: number;
}

/** A candidate for detection — a sim agent or fixed reference point. */
export interface DetectionCandidate {
  id: string;
  lat: number;
  lon: number;
  /** If not supplied, defaults to 'vehicle'. */
  cls?: DetectionClass | undefined;
}

// ── Haversine ────────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;

function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * sinLon * sinLon;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// ── Deterministic pseudo-random (no Math.random) ─────────────────────────────
// Produces a value in [0, 1) from a string key + integer index.
// Stable across ticks: same (id, tick) → same value.

function stableFloat(id: string, salt: number): number {
  // djb2-style hash over id chars + salt.
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 33) ^ id.charCodeAt(i)) >>> 0;
  }
  h = (Math.imul(h, 33) ^ (salt & 0xffff)) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca77) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae3d) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 0) / 4294967296;
}

// ── Sensor footprint ─────────────────────────────────────────────────────────
//
// Model: a nadir-pointing EO sensor with a ±25° half-angle FOV (typical
// FLIR / EO payload for small UAVs). Ground footprint radius (km):
//   r = alt * tan(25°)   where alt is in km
// This is deliberately simple — the goal is plausible geometry, not
// accurate optics.

const HALF_ANGLE_RAD = (25 * Math.PI) / 180; // 25° half-FOV
const TAN_HALF = Math.tan(HALF_ANGLE_RAD);

function footprintRadiusKm(altM: number): number {
  const altKm = Math.max(0.01, altM) / 1000;
  return altKm * TAN_HALF;
}

// ── Bbox projection ──────────────────────────────────────────────────────────
//
// Maps a target's position (relative to the sensor footprint) to a normalised
// image-space bounding box.  The footprint is treated as the whole frame
// [0,1]×[0,1]; north is image top.  A small jitter (keyed on the id) adds
// believable per-target variation without breaking determinism.

function projectBbox(
  focal: FocalDrone,
  target: DetectionCandidate,
  footprintRadiusKm: number,
  index: number,
): Detection['bbox'] {
  const dLat = target.lat - focal.lat;
  const dLon = (target.lon - focal.lon) * Math.cos(focal.lat * DEG2RAD);
  // Map to [0,1]: centre of footprint is (0.5, 0.5); north = top.
  // dLat positive → further north → lower y (screen top).
  const range = footprintRadiusKm / 111.32; // deg/km at equator approximation
  const cx = 0.5 + dLon / (2 * range);
  const cy = 0.5 - dLat / (2 * range);

  // Stable size jitter per target — varies 0.04..0.10 in each axis.
  const jW = 0.04 + stableFloat(target.id, index * 7 + 1) * 0.06;
  const jH = 0.04 + stableFloat(target.id, index * 7 + 2) * 0.06;

  // Clamp the ORIGIN against (1 - size) so the far edge never exceeds the frame
  // (x+w <= 1, y+h <= 1) — a box at the footprint edge stays fully inside [0,1].
  return {
    x: Math.max(0, Math.min(1 - jW, cx - jW / 2)),
    y: Math.max(0, Math.min(1 - jH, cy - jH / 2)),
    w: jW,
    h: jH,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Project which candidates fall inside the sensor footprint of `focal` and
 * return Detection records.  The `tick` parameter is used to vary confidence
 * slightly across frames for visual realism; detections themselves are
 * geometrically stable (same candidate in = same box).
 */
export function projectDetections(
  focal: FocalDrone,
  candidates: DetectionCandidate[],
  tick = 0,
): Detection[] {
  const rKm = footprintRadiusKm(focal.altM);
  const results: Detection[] = [];

  candidates.forEach((c, index) => {
    const distKm = haversineKm({ lat: focal.lat, lon: focal.lon }, { lat: c.lat, lon: c.lon });
    if (distKm > rKm) return; // outside footprint

    // Confidence: 1.0 at centre, falls off with distance. Small per-tick
    // shimmer (±0.03) gives the "tracking lock" visual effect.
    const normDist = Math.min(1, distKm / rKm);
    const baseConf = 0.65 + 0.3 * (1 - normDist);
    const shimmer = (stableFloat(c.id, tick & 0xff) - 0.5) * 0.06;
    const conf = Math.max(0.3, Math.min(0.99, baseConf + shimmer));

    results.push({
      id: c.id,
      cls: c.cls ?? 'vehicle',
      conf,
      bbox: projectBbox(focal, c, rKm, index),
    });
  });

  return results;
}

/**
 * Count detections by class.  Useful for the class-count badge row in FmvPanel.
 */
export function classCounts(detections: Detection[]): ClassCounts {
  const counts: ClassCounts = { vehicle: 0, aircraft: 0, structure: 0, drone: 0 };
  for (const d of detections) {
    counts[d.cls] += 1;
  }
  return counts;
}

/**
 * Footprint radius (km) for a given altitude.  Exposed so FmvPanel can draw
 * a footprint ring and for test assertions.
 */
export { footprintRadiusKm };
