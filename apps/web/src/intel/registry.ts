// Global intel registry — single shared instance of the in-process trackers
// so adapters can feed them and panels can read from them without prop
// drilling.

import { DarkVesselTracker } from './darkVessel.js';

export const intel = {
  darkVessels: new DarkVesselTracker(),
};

// Cross-layer aircraft deduplication.
//
// The same physical aircraft (identified by ICAO 24-bit address) often appears
// in multiple feeds at once — e.g. a US Air Force C-17 is in the global ADS-B
// snapshot, the military-only filter, and (during a squawk-7700 event) the
// emergencies feed. Each Cesium CustomDataSource is per-layer, so without
// coordination we'd render the same icao24 as three stacked entities — the
// operator sees a thick icon and the click target ambiguates.
//
// Rule: highest-priority layer owns the entity for that icao24; lower-priority
// layers MUST skip render for that frame. Priority is intentional — the
// emergencies feed wins over mil wins over global so the most-specific feed's
// styling (flashing red, orange mil tint) is what the operator sees.
//
// Adapters call `claim(icao24, layerId)` per feature and only render when the
// returned owner matches their own layer id. On entity removal (prune phase or
// detach) adapters call `release(icao24, layerId)` so a higher-priority layer
// can re-claim later.
export const aircraftDedup = {
  // icao24 (lowercase hex) → owning layer id
  owners: new Map<string, string>(),
  // Higher number wins. Layers not listed here get priority 0 (still
  // participates in dedup — first claim wins until a listed layer arrives).
  priority: {
    'aviation.adsb.live.emergencies': 30,
    'aviation.adsb.live.mil': 20,
    'aviation.adsb.global': 10,
    'aviation.adsb.fi.global': 5,
    'aviation.opensky.states': 5,
  } as Record<string, number>,

  // Return the priority for a layer id (0 for unlisted layers).
  priorityOf(layerId: string): number {
    return this.priority[layerId] ?? 0;
  },

  // Try to claim `icao24` for `layerId`. Returns the layer id that owns the
  // icao24 after the call — caller renders iff the returned id === layerId.
  claim(icao24: string, layerId: string): string {
    const current = this.owners.get(icao24);
    if (current === undefined) {
      this.owners.set(icao24, layerId);
      return layerId;
    }
    if (current === layerId) return layerId;
    if (this.priorityOf(layerId) > this.priorityOf(current)) {
      this.owners.set(icao24, layerId);
      return layerId;
    }
    return current;
  },

  // Drop the claim iff this layer currently owns it. No-op otherwise — we
  // don't want a lower-priority layer's prune to clobber a higher-priority
  // layer's active claim.
  release(icao24: string, layerId: string): void {
    if (this.owners.get(icao24) === layerId) {
      this.owners.delete(icao24);
    }
  },
};
