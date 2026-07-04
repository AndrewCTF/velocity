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
  buildHistograms,
  type Histogram,
} from '../explorer/facets.js';

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

const SAMPLE_INTERVAL_MS = 900; // floor spacing between samples
const IDLE_TIMEOUT_MS = 600; // run within this even if the main thread never idles

const ric: typeof window.requestIdleCallback | undefined =
  typeof window !== 'undefined' ? window.requestIdleCallback?.bind(window) : undefined;
const cic: typeof window.cancelIdleCallback | undefined =
  typeof window !== 'undefined' ? window.cancelIdleCallback?.bind(window) : undefined;

function clearTimers(): void {
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
    const run = (): void => {
      idle = null;
      // §5.2.3: skip the forced idle-timeout walk while the camera is moving —
      // a full ~35k-entity × all-props walk mid-drag is a pan hitch. Serve the
      // last snapshot; resample the moment the camera settles.
      if (!isCameraMoving()) sampleOnce();
      scheduleNext();
    };
    if (ric) idle = ric(run, { timeout: IDLE_TIMEOUT_MS });
    else run();
  }, SAMPLE_INTERVAL_MS);
}

// The single walk. Robust to a torn-down viewer mid-pass (HMR / ErrorBoundary).
function sampleOnce(): void {
  if (!viewer || viewer.isDestroyed()) return;
  try {
    const time = viewer.clock.currentTime;
    const tally = newFacetTally();
    const aoi = new Map<string, number>();
    for (const c of chokepoints) aoi.set(c.id, 0);
    const carto = new Cesium.Cartographic();
    const scratch = new Cesium.Cartesian3();

    for (let d = 0; d < viewer.dataSources.length; d++) {
      const ds = viewer.dataSources.get(d);
      for (const e of ds.entities.values) {
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

        // Facet tally — read the property bag once and classify (aircraft/vessel
        // only; scenery is skipped inside tallyFacets).
        const bag = e.properties;
        if (!bag) continue;
        const names = bag.propertyNames as readonly string[] | undefined;
        if (!names || names.length === 0) continue;
        const props: Record<string, unknown> = {};
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

    const aoiCounts: Record<string, number> = {};
    for (const [k, v] of aoi) aoiCounts[k] = v;
    useEntityStats.setState({
      histograms: buildHistograms(tally),
      counted: tally.counted,
      aoiCounts,
      sampledAt: Date.now(),
    });
  } catch {
    /* a torn-down viewer mid-walk; the next sample recovers */
  }
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
