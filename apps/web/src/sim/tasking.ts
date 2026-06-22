// Satellite tasking math — PURE functions, no Cesium, no React, no network.
//
// Given a satellite's TLE and a ground AOI, compute when the satellite is
// ABOVE the local horizon (a "pass"), the sky-track of az/el during a window,
// and revisit/coverage statistics over a mission window. This is forward
// PREDICTION used by the collection planner only — it is NOT written back into
// the live globe (SatelliteAdapter), which renders only the rolling SGP4 window
// around the current clock. SGP4-from-TLE IS the satellite's authoritative
// position, so propagating it forward for planning is real orbital mechanics,
// not the forbidden ADS-B-style motion synthesis.
//
// All angles returned to callers are DEGREES. satellite.js works in radians
// internally (geodeticToEcf / ecfToLookAngles), so we convert at the boundary.

import {
  twoline2satrec,
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
  type SatRec,
  type EciVec3,
  type Kilometer,
} from 'satellite.js';

// Note on the satellite.js API: ecfToLookAngles takes the observer as a geodetic
// location (lon/lat in radians, height in km) directly — geodeticToEcf is only
// needed when you already hold the observer in ECF, which we don't, so the
// observer is passed straight as { longitude, latitude, height }.

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export interface AoiPoint {
  lat: number; // degrees
  lon: number; // degrees
  altM?: number; // observer height (meters); defaults to 0
}

export interface Window {
  startMs: number;
  endMs: number;
}

export interface Pass {
  satName?: string;
  startMs: number;
  endMs: number;
  maxElevDeg: number;
  durationS: number;
}

export interface SkyPoint {
  tMs: number;
  azDeg: number; // 0..360, 0 = North, 90 = East
  elDeg: number; // >= 0 (above horizon)
}

export interface CoverageStats {
  passCount: number;
  avgRevisitMin: number; // mean gap between consecutive pass starts
  maxGapMin: number; // largest gap between consecutive pass starts (or full window if 0/1 pass)
  coveragePct: number; // % of the window the satellite(s) are in view
}

// Build a SatRec, returning null on a parse / sgp4init error (decayed element
// sets, malformed lines) so callers can skip the satellite cleanly.
export function makeSatrec(tle1: string, tle2: string): SatRec | null {
  try {
    const rec = twoline2satrec(tle1, tle2);
    if (rec.error) return null;
    return rec;
  } catch {
    return null;
  }
}

// Look angle (az/el/range) of a satellite from an observer at a given instant.
// Returns null when SGP4 fails at that time (deep-space error / decay).
function lookAt(
  rec: SatRec,
  observer: { longitude: number; latitude: number; height: number },
  date: Date,
): { azDeg: number; elDeg: number; rangeKm: number } | null {
  const pv = propagate(rec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const gmst = gstime(date);
  const ecf = eciToEcf(pv.position as EciVec3<Kilometer>, gmst);
  const look = ecfToLookAngles(observer, ecf);
  const elDeg = look.elevation * DEG;
  let azDeg = look.azimuth * DEG;
  if (!isFinite(elDeg) || !isFinite(azDeg)) return null;
  azDeg = ((azDeg % 360) + 360) % 360;
  return { azDeg, elDeg, rangeKm: look.rangeSat };
}

function observerGd(aoi: AoiPoint): { longitude: number; latitude: number; height: number } {
  return {
    longitude: aoi.lon * RAD,
    latitude: aoi.lat * RAD,
    height: (aoi.altM ?? 0) / 1000, // satellite.js wants kilometers
  };
}

// Passes over an AOI within a window: each pass is a contiguous run of samples
// where elevation >= minElevDeg. Samples are taken every `stepSec`. The reported
// start/end are clamped to the boundary samples of the run (sub-step precision
// is unnecessary for planning and keeps this allocation-light).
export function passesOverAoi(
  tle1: string,
  tle2: string,
  aoi: AoiPoint,
  win: Window,
  stepSec = 30,
  minElevDeg = 10,
  satName?: string,
): Pass[] {
  const rec = makeSatrec(tle1, tle2);
  if (!rec) return [];
  // satellite.js' SatRec carries no object name, so the caller supplies it (the
  // planner stamps each pass with the CelesTrak OBJECT_NAME).
  const name = satName;
  const obs = observerGd(aoi);
  const step = Math.max(1, stepSec) * 1000;
  const out: Pass[] = [];

  let inPass = false;
  let passStartMs = 0;
  let passMaxEl = -Infinity;
  let lastAboveMs = 0;

  for (let tMs = win.startMs; tMs <= win.endMs; tMs += step) {
    const look = lookAt(rec, obs, new Date(tMs));
    const above = look != null && look.elDeg >= minElevDeg;
    if (above) {
      if (!inPass) {
        inPass = true;
        passStartMs = tMs;
        passMaxEl = -Infinity;
      }
      if (look!.elDeg > passMaxEl) passMaxEl = look!.elDeg;
      lastAboveMs = tMs;
    } else if (inPass) {
      out.push(finishPass(name, passStartMs, lastAboveMs, passMaxEl, step));
      inPass = false;
    }
  }
  if (inPass) out.push(finishPass(name, passStartMs, lastAboveMs, passMaxEl, step));
  return out;
}

function finishPass(
  name: string | undefined,
  startMs: number,
  endMs: number,
  maxEl: number,
  stepMs: number,
): Pass {
  const clampedEl = Math.max(0, Math.min(90, maxEl));
  // The sat rose before the first above-mask sample and set after the last, so
  // the true above-mask span is ~one extra step wide. Adding stepMs also keeps a
  // single-sample grazing pass from reporting a misleading 0s duration.
  const base = {
    startMs,
    endMs,
    maxElevDeg: clampedEl,
    durationS: Math.max(0, (endMs - startMs + stepMs) / 1000),
  };
  return name ? { satName: name, ...base } : base;
}

// Sky-view track: az/el samples while the satellite is above the horizon
// (el >= 0) across the window. Feeds the polar SkyViewPlot.
export function skyView(
  tle1: string,
  tle2: string,
  aoi: AoiPoint,
  win: Window,
  stepSec = 30,
): SkyPoint[] {
  const rec = makeSatrec(tle1, tle2);
  if (!rec) return [];
  const obs = observerGd(aoi);
  const step = Math.max(1, stepSec) * 1000;
  const out: SkyPoint[] = [];
  for (let tMs = win.startMs; tMs <= win.endMs; tMs += step) {
    const look = lookAt(rec, obs, new Date(tMs));
    if (look && look.elDeg >= 0) out.push({ tMs, azDeg: look.azDeg, elDeg: look.elDeg });
  }
  return out;
}

// Aggregate revisit / coverage stats from a set of passes over a window.
// `passes` may span multiple satellites; they're sorted by start time so the
// revisit/gap figures describe the COMBINED collection cadence over the AOI.
export function coverageStats(passes: readonly Pass[], win: Window): CoverageStats {
  const winMin = Math.max(0, (win.endMs - win.startMs) / 60000);
  if (passes.length === 0) {
    return { passCount: 0, avgRevisitMin: 0, maxGapMin: winMin, coveragePct: 0 };
  }

  const sorted = [...passes].sort((a, b) => a.startMs - b.startMs);

  // Coverage % = union of in-view intervals / window length (intervals from
  // different satellites can overlap, so merge before summing).
  const merged: Array<[number, number]> = [];
  for (const p of sorted) {
    const s = Math.max(p.startMs, win.startMs);
    const e = Math.min(p.endMs, win.endMs);
    if (e <= s) continue;
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const inViewMs = merged.reduce((acc, [s, e]) => acc + (e - s), 0);
  const winMs = Math.max(1, win.endMs - win.startMs);
  const coveragePct = (inViewMs / winMs) * 100;

  // Revisit = gaps between consecutive pass START times.
  let avgRevisitMin = 0;
  let maxGapMin = winMin;
  if (sorted.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i]!.startMs - sorted[i - 1]!.startMs) / 60000);
    }
    avgRevisitMin = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    maxGapMin = gaps.reduce((m, g) => (g > m ? g : m), 0); // reduce, not Math.max(...spread) — safe for any pass count
  }

  return {
    passCount: sorted.length,
    avgRevisitMin,
    maxGapMin,
    coveragePct: Math.max(0, Math.min(100, coveragePct)),
  };
}
