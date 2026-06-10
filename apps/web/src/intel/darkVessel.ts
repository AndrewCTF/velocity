// In-process dark-vessel candidate tracker.
//
// research.md §2 / research_updated.md §1.3: a vessel that stops broadcasting
// AIS for ≥N hours while its last position is inside a monitored AOI is a
// "dark vessel candidate". Real darkness needs SAR cross-reference (GFW);
// this tracker produces the AIS-side half so the operator sees candidates
// long before the SAR pass.
//
// We keep a ring buffer of last-seen times per MMSI. On every tick we list
// any MMSI whose last_seen was within `lookbackMs` of `now - gapMs` (so the
// gap is fresh, not ancient) and whose last position lies in any active AOI.

import type { Chokepoint } from '../registry/chokepoints.js';

export interface VesselFix {
  mmsi: string;
  lat: number;
  lon: number;
  t: number; // epoch ms
  name?: string | null;
  sog?: number | null;
}

export interface DarkVesselCandidate {
  mmsi: string;
  lastSeen: number;
  lastLat: number;
  lastLon: number;
  gapMs: number;
  name?: string | null;
  insideAoi?: string;
}

const DEFAULT_GAP_MS = 60 * 60 * 1000; // 1h
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1000; // candidate stays fresh for 30m

export class DarkVesselTracker {
  private fixes = new Map<string, VesselFix>();

  observe(fix: VesselFix): void {
    this.fixes.set(fix.mmsi, fix);
  }

  prune(olderThanMs: number): void {
    const cutoff = Date.now() - olderThanMs;
    for (const [k, v] of this.fixes) if (v.t < cutoff) this.fixes.delete(k);
  }

  candidates(
    aois: readonly Chokepoint[],
    opts: { gapMs?: number; lookbackMs?: number; now?: number } = {},
  ): DarkVesselCandidate[] {
    const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
    const lookback = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    const now = opts.now ?? Date.now();
    const out: DarkVesselCandidate[] = [];
    for (const f of this.fixes.values()) {
      const gap = now - f.t;
      if (gap < gapMs) continue;
      if (gap > gapMs + lookback) continue;
      const aoi = aois.find((a) => inBbox(a.bbox, f.lon, f.lat));
      if (aois.length > 0 && !aoi) continue;
      const c: DarkVesselCandidate = {
        mmsi: f.mmsi,
        lastSeen: f.t,
        lastLat: f.lat,
        lastLon: f.lon,
        gapMs: gap,
      };
      if (f.name != null) c.name = f.name;
      if (aoi) c.insideAoi = aoi.id;
      out.push(c);
    }
    return out.sort((a, b) => b.gapMs - a.gapMs);
  }

  size(): number {
    return this.fixes.size;
  }
}

export function inBbox(
  bbox: [number, number, number, number],
  lon: number,
  lat: number,
): boolean {
  const [w, s, e, n] = bbox;
  return lon >= w && lon <= e && lat >= s && lat <= n;
}
