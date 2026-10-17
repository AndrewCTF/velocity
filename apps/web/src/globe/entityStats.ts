// ── Shared entity-stats sampler ─────────────────────────────────────────────
//
// ONE walk of every data-source entity per sample, feeding BOTH consumers that
// used to each run their own full walk every tick:
//   • HistogramPanel — faceted contact counts (was aggregate(), 800 ms)
//   • OpsPanel        — live in-AOI contact counts (was countInAoi(), 2 s)
//
// Two overlapping O(entities × props) walks on the main thread is what stole
// frames from Cesium's render loop during a world-view pan. This collapses them
// to one walk, and — crucially — schedules it via requestIdleCallback so the
// walk DEFERS itself while the main thread is busy (i.e. mid-drag) instead of
// firing on a hard interval right when the camera is moving. It also pauses
// while the tab is hidden. Results land in the `useEntityStats` store; panels
// subscribe to their slice.
//
// ponytail: post-hoc walk over the live scene. Upgrade path if this ever needs
// to be sub-millisecond — accumulate facet/AOI counts inside
// PollGeoJsonAdapter.drain, which already iterates every feature. YAGNI now: the
// walk is off the critical path (idle-scheduled) and one pass is cheap enough.

import * as Cesium from 'cesium';
import { create } from 'zustand';
import { chokepoints } from '../registry/chokepoints.js';
import { isCameraMoving } from './cameraMotion.js';
import {
  newFacetTally,
  tallyFacets,
  tallyTier,
  buildHistograms,
  type Histogram,
} from '../explorer/facets.js';
import { tierOf } from '../registry/provenance.js';
import { dict } from '../shell/safeKeys.js';

export interface EntityStats {
  histograms: Histogram[];
  // Classified contacts (aircraft + vessel) on the globe this sample.
  counted: number;
  // chokepoint id → live contact count inside its bbox at the sampled clock.
  aoiCounts: Record<string, number>;
  // wall-clock ms of the most recent sample (0 = never sampled).
  sampledAt: number;
}

const EMPTY: EntityStats = { histograms: [], counted: 0, aoiCounts: {}, sampledAt: 0 };

export const useEntityStats = create<EntityStats>(() => ({ ...EMPTY }));

// ── sampler control (module singleton) ──────────────────────────────────────
let viewer: Cesium.Viewer | null = null;
let consumers = 0;
let timer: number | null = null;
let idle: number | null = null;
let job: Generator<void, EntityStats | null> | null = null;

const SAMPLE_INTERVAL_MS = 900; // floor spacing between samples
const IDLE_TIMEOUT_MS = 600; // run within this even if the main thread never idles
// Entities walked between deadline checks (~2 ms at the measured ~4 us each).
// The walk used to run whole: ~60 ms over 16k contacts, once a second, and with
// the clock playing the globe renders every frame, so the idle callback's
// deadline was a few ms and the timeout forced the rest through as one long
// task (about ten dropped frames a second on a 165 Hz panel, measured
// 2026-10-17). It now stops at the deadline and resumes in the next idle period.
const WALK_CHUNK = 500;

const ric: typeof window.requestIdleCallback | undefined =
  typeof window !== 'undefined' ? window.requestIdleCallback?.bind(window) : undefined;
const cic: typeof window.cancelIdleCallback | undefined =
  typeof window !== 'undefined' ? window.cancelIdleCallback?.bind(window) : undefined;

function clearTimers(): void {
  job = null;
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (idle != null) {
    cic?.(idle);
    idle = null;
  }
}

function paused(): boolean {
  return consumers <= 0 || (typeof document !== 'undefined' && document.hidden);
}

function scheduleNext(): void {
  clearTimers();
  if (paused()) return;
  timer = window.setTimeout(() => {
    timer = null;
    const run = (deadline?: IdleDeadline): void => {
      idle = null;
      if (!job) {
        // §5.2.3: don't START a walk while the camera is moving. Serve the last
        // snapshot; resample the moment the camera settles.
        if (isCameraMoving() || !viewer || viewer.isDestroyed()) {
          scheduleNext();
          return;
        }
        job = walk(viewer);
      }
      try {
        for (;;) {
          const r = job.next();
          if (r.done) {
            job = null;
            if (r.value) useEntityStats.setState(r.value);
            scheduleNext();
            return;
          }
          // No requestIdleCallback (Safari): finish in one go, as before.
          if (deadline && deadline.timeRemaining() < 1) {
            idle = ric!(run, { timeout: IDLE_TIMEOUT_MS });
            return;
          }
        }
      } catch {
        /* a torn-down viewer mid-walk; the next sample recovers */
        job = null;
        scheduleNext();
      }
    };
    if (ric) idle = ric(run, { timeout: IDLE_TIMEOUT_MS });
    else run();
  }, SAMPLE_INTERVAL_MS);
}

// The single walk, all at once. Used for the immediate sample on mount, viewer
// change and tab return. Robust to a torn-down viewer mid-pass (HMR /
// ErrorBoundary).
function sampleOnce(): void {
  if (!viewer || viewer.isDestroyed()) return;
  try {
    const it = walk(viewer);
    let r = it.next();
    while (!r.done) r = it.next();
    if (r.value) useEntityStats.setState(r.value);
  } catch {
    /* a torn-down viewer mid-walk; the next sample recovers */
  }
}

// One sample, resumable: yields every WALK_CHUNK entities. Entities added or
// removed between chunks can be missed or counted once more in that sample,
// which a histogram that resamples every second does not notice.
function* walk(v: Cesium.Viewer): Generator<void, EntityStats | null> {
  const time = v.clock.currentTime;
  const tally = newFacetTally();
  const aoi = new Map<string, number>();
  for (const c of chokepoints) aoi.set(c.id, 0);
  const carto = new Cesium.Cartographic();
  const scratch = new Cesium.Cartesian3();
  let walked = 0;

  for (let d = 0; d < v.dataSources.length; d++) {
    const ds = v.dataSources.get(d);
    // The tier belongs to the SOURCE, not to the contact, so it is not in any
    // feature's property bag and cannot be. The DataSource name IS the layer
    // id, which is the only place in this walk where the two meet.
    const dsTier = tierOf(ds.name);
    for (const e of ds.entities.values) {
      if (++walked % WALK_CHUNK === 0) {
        yield;
        if (v.isDestroyed()) return null;
      }
      // AOI bbox test — every entity that resolves a position counts, exactly
      // like the old countInAoi (kind-agnostic).
      const pos = e.position?.getValue(time, scratch);
      if (pos) {
        Cesium.Cartographic.fromCartesian(pos, Cesium.Ellipsoid.WGS84, carto);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        for (const c of chokepoints) {
          const [w, s, ee, n] = c.bbox;
          if (lon >= w && lon <= ee && lat >= s && lat <= n) {
            aoi.set(c.id, (aoi.get(c.id) ?? 0) + 1);
          }
        }
      }

      // Provenance first, and unconditionally. Everything below this line can
      // skip an entity for a reason that has nothing to do with its source.
      tallyTier(tally, dsTier);

      // Facet tally — read the property bag once and classify (aircraft/vessel
      // only; scenery is skipped inside tallyFacets).
      const bag = e.properties;
      if (!bag) continue;
      const names = bag.propertyNames as readonly string[] | undefined;
      if (!names || names.length === 0) continue;
      const props = dict<unknown>();
      for (const nm of names) {
        const p = (bag as unknown as Record<string, Cesium.Property | undefined>)[nm];
        if (!p) continue;
        try {
          props[nm] = p.getValue(time);
        } catch {
          /* skip unreadable property */
        }
      }
      tallyFacets(tally, props);
    }
  }

  const aoiCounts = dict<number>();
  for (const [k, n] of aoi) aoiCounts[k] = n;
  return {
    histograms: buildHistograms(tally),
    counted: tally.counted,
    aoiCounts,
    sampledAt: Date.now(),
  };
}

// Point the sampler at the live viewer. Panels call this in their mount effect;
// the latest viewer wins. Kicks an immediate sample if anyone is listening.
export function setStatsViewer(v: Cesium.Viewer | null): void {
  viewer = v;
  if (v && consumers > 0 && !paused()) {
    sampleOnce();
    scheduleNext();
  }
}

// Ref-counted subscription. The walk only runs while ≥1 consumer is mounted.
// Returns a release fn for the effect cleanup.
export function acquireStats(): () => void {
  consumers++;
  if (consumers === 1) {
    sampleOnce();
    scheduleNext();
  }
  return () => {
    consumers = Math.max(0, consumers - 1);
    if (consumers === 0) {
      clearTimers();
      useEntityStats.setState({ ...EMPTY });
    }
  };
}

// Resume promptly when the tab returns to the foreground; stop burning cycles
// while hidden.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimers();
    } else if (consumers > 0) {
      sampleOnce();
      scheduleNext();
    }
  });
}
