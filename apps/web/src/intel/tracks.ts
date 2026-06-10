// Per-entity position ring buffer used by the entity panel sparkline + the
// track polyline overlay. Bounded so it can't grow unboundedly even with
// thousands of moving entities.
//
// DEDUP IS DELIBERATELY LOOSE — DO NOT TIGHTEN.
// A fix is accepted whenever displacement ≥ ~100 m OR ≥5 s have elapsed
// since the last push. It is skipped ONLY when BOTH the position is within
// ~100 m AND less than 5 s has passed. That guarantees every aircraft poll
// and every vessel WS frame produces a fresh point, so the selection-track
// polyline has ≥2 points to draw within ~5-8 s of the user clicking a
// contact — instead of the previous 60 s wait for stationary entities.
// Past attempts to tighten further (e.g. 1 km / 30 s) made the counter
// stick at 0 for parked aircraft — the bug we are explicitly avoiding. If
// you want fewer points, change MAX_POINTS_PER_ENTITY.
//
// `push()` accepts an optional `{ force: true }` to bypass dedup entirely.
// The PollGeoJsonAdapter and AisWsAdapter both set force=true for the
// currently SELECTED entity so the magenta polyline gains a new fix on
// every poll (one point every 2 s → 30 points in 60 s → smooth curve)
// regardless of whether the entity is moving. Without this, a slow-moving
// or stationary aircraft / vessel produced what looked like a straight
// line because the 5 s/100 m dedup ate most of its samples.

// Dev-only switch for verifying tracks.push wiring from adapters. When set
// to true, every accept/skip in push() is logged. Off by default — leave
// off in committed code.
export const __DEBUG_FORCE_PUSH = false;

export interface TrackPoint {
  t: number; // epoch ms
  lon: number;
  lat: number;
  alt: number;
  sog?: number;
  track?: number;
}

const MAX_POINTS_PER_ENTITY = 60; // ~last 60 fixes
// Must exceed the live entity population or eviction thrashes: with the
// Digitraffic global snapshot (~18.5k vessels) + ADS-B (~2k aircraft) a
// 5 000 cap meant every vessel poll evicted every aircraft ring, so the
// selection polyline never reached 2 points. 25 000 matches the per-layer
// entity cap (MAX_PER_LAYER in PollGeoJsonAdapter); in steady state no
// eviction happens at all, which also removes the O(n) evict scan per
// insert.
const MAX_TRACKED_ENTITIES = 25_000;

class TrackStore {
  private tracks = new Map<string, TrackPoint[]>();

  push(id: string, p: TrackPoint, opts?: { force?: boolean }): void {
    let arr = this.tracks.get(id);
    if (!arr) {
      if (this.tracks.size >= MAX_TRACKED_ENTITIES) this.evictOne();
      arr = [];
      this.tracks.set(id, arr);
    }
    // Loosened dedup: accept the fix if displacement ≥ ~100 m OR ≥5 s have
    // elapsed since the last push. Only skip when BOTH the position changed
    // by <0.001° (~100 m at the equator) AND less than 5 s has passed.
    //
    // BYPASS: when `opts.force` is set, push regardless. The adapters set
    // this for the currently SELECTED entity so the magenta polyline gains
    // a fresh fix on every poll (2 s cadence for aircraft, event-driven
    // for vessels), producing a dense smooth curve over 60 s instead of
    // looking like a straight line for slow-moving traffic.
    const last = arr[arr.length - 1];
    const dLon = last ? Math.abs(last.lon - p.lon) : Infinity;
    const dLat = last ? Math.abs(last.lat - p.lat) : Infinity;
    const dt = last ? p.t - last.t : Infinity;
    const force = opts?.force === true;
    if (!force && last && dLon < 0.001 && dLat < 0.001 && dt < 5_000) {
      if (__DEBUG_FORCE_PUSH) {
        // eslint-disable-next-line no-console
        console.info('[tracks] skip', id, { dLon, dLat, dt });
      }
      return;
    }
    arr.push(p);
    if (arr.length > MAX_POINTS_PER_ENTITY) arr.shift();
    if (__DEBUG_FORCE_PUSH) {
      // eslint-disable-next-line no-console
      console.info('[tracks] push', id, { size: this.tracks.size, len: arr.length, force });
    }
  }

  get(id: string): readonly TrackPoint[] {
    return this.tracks.get(id) ?? [];
  }

  size(): number {
    return this.tracks.size;
  }

  // Debug helper — number of buffered points for a given entity. Used by the
  // dev console / LayerRail debug log to verify that adapters are wiring
  // tracks.push correctly. Returns 0 for unknown ids.
  points(id: string): number {
    return this.tracks.get(id)?.length ?? 0;
  }

  private evictOne(): void {
    // Evict the entity with the oldest most-recent fix.
    let oldestId: string | null = null;
    let oldestT = Infinity;
    for (const [id, arr] of this.tracks) {
      const last = arr[arr.length - 1];
      if (last && last.t < oldestT) {
        oldestT = last.t;
        oldestId = id;
      }
    }
    if (oldestId) this.tracks.delete(oldestId);
  }
}

export const tracks = new TrackStore();
