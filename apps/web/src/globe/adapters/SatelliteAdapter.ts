import * as Cesium from 'cesium';
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
  type SatRec,
} from 'satellite.js';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { satelliteStyle } from './styles.js';
import { frameBudgetRemaining, recordFrameSpend } from '../frameBudget.js';
import { labelFor } from './labelStyle.js';
import { PrimitiveEntityLayer } from './PrimitiveEntityLayer.js';
import { apiFetch } from '../../transport/http.js';
import { isMobileDevice } from '../../shell/device.js';
import { setRenderNeed } from '../renderNeeds.js';

interface Props {
  ctx: AdapterCtx;
  endpoint: string;
  group: string;
  refreshSec: number;
}

interface OmmRecord {
  OBJECT_NAME: string;
  // String, not number: the backend parses CelesTrak FORMAT=tle and sends the
  // catalogue number from line 1 (Alpha-5-safe for ids > 99999, e.g. Starlink).
  NORAD_CAT_ID: number | string;
  TLE_LINE1?: string;
  TLE_LINE2?: string;
}

// Hard cap to keep the frame budget healthy; phones get a quarter (per-sat SGP4
// + a billboard each is heavy on mobile GPUs).
const MAX_SATS = isMobileDevice() ? 1000 : 4000;

// Orbit sampling. We DON'T reassign a position every tick (that teleports the
// icon once per tick); instead we propagate a short rolling WINDOW of fixes per
// satellite into a Cesium SampledPositionProperty and let Cesium interpolate
// between them every frame the simulation clock advances — the exact smoothness
// machinery the aircraft/vessel adapters use. SGP4 from the current TLE IS the
// satellite's authoritative position (there is no separate "observed fix" feed),
// so sampling it is real physics, not the forbidden ADS-B motion synthesis.
const STEP_S = 20; // seconds between propagated samples (~0.45 km Linear chord error for ISS)
const WINDOW_S = 900; // seconds of orbit buffered per satellite (15 min → ~46 samples)
const REFRESH_LOW_FRAC = 0.25; // resample when <25% of a window remains ahead of the clock
const PRUNE_BEHIND_S = 120; // drop samples older than 2 min behind the clock
const SCAN_INTERVAL_MS = 30_000; // how often we look for windows running low
// ponytail: per-frame propagation budget. Chunking SGP4 across frames is what
// keeps re-sampling 4 k satellites off the hot path (no 60 ms hitch). Bump the
// work to a Web Worker only if MAX_SATS is later raised past ~10 k.
const SAMPLE_BUDGET_MS = 5;
// Floor for the SGP4 pump's slice when the shared per-frame budget is nearly
// spent, so a busy frame can't stall orbit propagation entirely.
const SAT_MIN_SLICE_MS = 2;

const EPOCH_START = Cesium.JulianDate.fromIso8601('1970-01-01T00:00:00Z');

export interface OrbitSample {
  tMs: number;
  lon: number;
  lat: number;
  alt: number; // meters
}

// Pure SGP4 sampler — propagate `rec` at `startMs, startMs+step, … startMs+window`
// and return geodetic fixes. Altitude is METERS (eciToGeodetic gives km).
// Samples where propagation fails (decayed/deep-space error, non-finite) are
// dropped, so the result can be shorter than window/step+1. Exported for tests.
export function sampleOrbit(
  rec: SatRec,
  startMs: number,
  stepSec: number,
  windowSec: number,
): OrbitSample[] {
  const out: OrbitSample[] = [];
  const n = Math.floor(windowSec / stepSec);
  for (let i = 0; i <= n; i++) {
    const tMs = startMs + i * stepSec * 1000;
    const date = new Date(tMs);
    const pv = propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
    const gmst = gstime(date);
    const g = eciToGeodetic(pv.position, gmst);
    const lat = degreesLat(g.latitude);
    const lon = degreesLong(g.longitude);
    const alt = g.height * 1000;
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) continue;
    out.push({ tMs, lon, lat, alt });
  }
  return out;
}

function jdToMs(jd: Cesium.JulianDate): number {
  return Cesium.JulianDate.toDate(jd).getTime();
}

// Polls CelesTrak (every refreshSec) for a group's two-line elements, then
// streams SGP4-sampled orbit windows into per-satellite SampledPositionProperty
// entities. Cesium interpolates them smoothly every frame; propagation is
// chunked across frames so neither the TLE refresh nor the rolling window
// resample ever blocks a frame.
export class SatelliteAdapter implements LayerAdapter {
  private ds: Cesium.CustomDataSource;
  // Icons+labels render as ONE BillboardCollection/LabelCollection off the
  // (graphics-less) entities — 4k orbiting entity billboards otherwise made the
  // visualizer walk every sat each frame. Entities keep position (SGP4 sampled)
  // + name + props so selection/getById still resolve them.
  private prim: PrimitiveEntityLayer | null = null;
  // Raw TLE lines per satellite. We DON'T call twoline2satrec here — sgp4init
  // for 4 k satellites is a ~100 ms synchronous block; instead we keep the lines
  // and build the SatRec lazily in the chunked pump (recCache), so even the
  // parse is spread across frames.
  private satrecs = new Map<string, { l1: string; l2: string; name: string; norad: string }>();
  private recCache = new Map<string, SatRec>();
  // entityId → tMs of the furthest sample currently buffered for that satellite.
  private lastSampleMs = new Map<string, number>();
  private fetchTimer: number | null = null;
  private scanTimer: number | null = null;
  private retryTimer: number | null = null;
  private aborter: AbortController | null = null;
  private detached = false;
  // Work queue for chunked (re)sampling, with a dedup set.
  private queue: string[] = [];
  private queued = new Set<string>();
  private pumpScheduled = false;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    if (this.detached || viewer.isDestroyed()) return;
    this.prim = new PrimitiveEntityLayer(viewer.scene, {
      // Satellites carry no heading and a fixed accent tint; one style for all.
      styleFn: () => {
        const s = satelliteStyle();
        return { imageUri: s.imageUri, scale: s.scale, color: s.color, rotationRad: 0 };
      },
      labelFn: (props) => (props['name'] as string) || `NORAD ${props['noradId'] ?? ''}`,
      billboardBase: () => ({
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60_000_000),
        scaleByDistance: new Cesium.NearFarScalar(2_000_000, 1.2, 40_000_000, 0.5),
      }),
      labelBase: (text) => labelFor(text) as unknown as Cesium.Label.ConstructorOptions,
      getClock: () => viewer.clock.currentTime,
      // Orbits move continuously — mirror each frame the clock advances (rides
      // the existing render; paused timeline freezes the constellation correctly).
      shouldAnimate: () => viewer.clock.shouldAnimate,
      pulse: false,
      filter: false,
    });
    await this.refreshTles();
    this.fetchTimer = window.setInterval(
      () => void this.refreshTles(),
      this.props.refreshSec * 1000,
    );
    this.scanTimer = window.setInterval(() => this.scan(), SCAN_INTERVAL_MS);
  }

  detach(): void {
    this.detached = true;
    setRenderNeed(`sat:${this.props.ctx.descriptor.id}`, false);
    if (this.fetchTimer != null) window.clearInterval(this.fetchTimer);
    if (this.scanTimer != null) window.clearInterval(this.scanTimer);
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer);
    this.fetchTimer = null;
    this.scanTimer = null;
    this.retryTimer = null;
    this.aborter?.abort();
    this.queue = [];
    this.queued.clear();
    this.recCache.clear();
    this.prim?.destroy();
    this.prim = null;
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* gone */
    }
  }

  private async refreshTles(): Promise<void> {
    this.aborter?.abort();
    this.aborter = new AbortController();
    try {
      const r = await apiFetch(this.props.endpoint, { signal: this.aborter.signal });
      if (!r.ok) {
        this.props.ctx.reportStatus({ status: 'red', note: `upstream ${r.status}` });
        this.scheduleRetry();
        return;
      }
      const j = (await r.json()) as { items: OmmRecord[] };
      const items = (j.items ?? []).slice(0, MAX_SATS);
      const descriptorId = this.props.ctx.descriptor.id;
      const next = new Map<string, { l1: string; l2: string; name: string; norad: string }>();
      for (const rec0 of items) {
        const l1 = rec0.TLE_LINE1;
        const l2 = rec0.TLE_LINE2;
        if (!l1 || !l2) continue;
        const norad = String(rec0.NORAD_CAT_ID);
        next.set(`${descriptorId}:sat:${norad}`, {
          l1,
          l2,
          name: (rec0.OBJECT_NAME || '').trim(),
          norad,
        });
      }

      // Prune entities for satellites no longer in the catalogue.
      for (const e of [...this.ds.entities.values]) {
        if (!next.has(e.id)) {
          this.ds.entities.removeById(e.id);
          this.prim?.remove(String(e.id));
          this.lastSampleMs.delete(e.id);
        }
      }

      this.satrecs = next;
      // §5.1: orbits are SGP4-animated (SampledPositionProperty) — tell the render
      // governor to keep rendering every frame while this layer has satellites.
      setRenderNeed(`sat:${this.props.ctx.descriptor.id}`, next.size > 0);
      // Fresh elements → drop cached satrecs + re-seed every window from now.
      this.recCache.clear();
      this.lastSampleMs.clear();
      this.queue = [];
      this.queued.clear();
      for (const id of next.keys()) this.enqueue(id);

      this.props.ctx.reportStatus({
        status: items.length > 0 ? 'green' : 'amber',
        lastSeen: Date.now(),
        ...(items.length === 0 && { note: 'no TLEs returned' }),
      });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      this.props.ctx.reportStatus({ status: 'red', note: 'transport error' });
      this.scheduleRetry();
    }
  }

  // CelesTrak occasionally throttles a large group with a non-200 (the cache
  // only stores successes) and the regular refetch timer is 2 h away — so on
  // failure retry sooner (one pending at a time, gentle on a throttling
  // upstream) instead of leaving the layer empty until the next scheduled pull.
  private scheduleRetry(): void {
    if (this.detached || this.retryTimer != null) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.refreshTles();
    }, 180_000);
  }

  // Enqueue a satellite whose window needs (re)sampling, then make sure the
  // chunk pump is scheduled.
  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.detached) return;
    this.pumpScheduled = true;
    window.requestAnimationFrame((ts) => this.pump(ts));
  }

  // Process queued satellites within a per-frame time budget, yielding to the
  // next frame when the budget is spent so the main thread never stalls. The
  // budget is SHARED with the ADS-B / vessel drains (frameBudget.ts): when one
  // already drained this frame the pump shrinks its slice so their combined work
  // doesn't overrun the frame (the world-view pan stutter).
  private pump(ts = performance.now()): void {
    this.pumpScheduled = false;
    if (this.detached) return;
    const start = performance.now();
    const budget = Math.max(SAT_MIN_SLICE_MS, Math.min(SAMPLE_BUDGET_MS, frameBudgetRemaining(ts)));
    const entities = this.ds.entities;
    entities.suspendEvents();
    let processed = 0;
    while (this.queue.length > 0 && performance.now() - start < budget) {
      const id = this.queue.shift() as string;
      this.queued.delete(id);
      this.applySat(id);
      processed++;
    }
    entities.resumeEvents();
    recordFrameSpend(ts, performance.now() - start);
    if (processed > 0) this.props.ctx.viewer.scene.requestRender();
    if (this.queue.length > 0) this.schedulePump();
  }

  // Periodically enqueue satellites whose buffered window is about to run out
  // (or whose buffer no longer brackets the clock, e.g. after a history scrub).
  private scan(): void {
    if (this.detached) return;
    const clockMs = jdToMs(this.props.ctx.viewer.clock.currentTime);
    const lowMs = WINDOW_S * 1000 * REFRESH_LOW_FRAC;
    for (const id of this.satrecs.keys()) {
      const last = this.lastSampleMs.get(id);
      if (last == null || last - clockMs < lowMs) this.enqueue(id);
    }
  }

  // (Re)sample one satellite's window and upsert its entity. Appends to the
  // existing SampledPositionProperty while the buffer is still ahead of the
  // clock; otherwise (new satellite, exhausted buffer, or clock jumped outside
  // the buffer) seeds a fresh window from the current clock time.
  private applySat(id: string): void {
    const meta = this.satrecs.get(id);
    if (!meta) return; // dropped between enqueue and pump
    const { name, norad } = meta;
    // Lazily build (and cache) the SatRec — this is the sgp4init cost, spread
    // across frames by the pump instead of done in bulk on TLE load.
    let rec = this.recCache.get(id);
    if (!rec) {
      try {
        rec = twoline2satrec(meta.l1, meta.l2);
      } catch {
        this.satrecs.delete(id);
        return;
      }
      if (rec.error) {
        this.satrecs.delete(id);
        return;
      }
      this.recCache.set(id, rec);
    }
    const clock = this.props.ctx.viewer.clock;
    const clockMs = jdToMs(clock.currentTime);
    const ex = this.ds.entities.getById(id);
    const last = this.lastSampleMs.get(id);

    const canAppend =
      !!ex &&
      ex.position instanceof Cesium.SampledPositionProperty &&
      last != null &&
      last >= clockMs &&
      last <= clockMs + WINDOW_S * 1000 * 1.5;

    const startMs = canAppend ? (last as number) + STEP_S * 1000 : clockMs;
    const samples = sampleOrbit(rec, startMs, STEP_S, WINDOW_S);
    if (samples.length === 0) return; // propagation failing — leave as-is / skip

    const times: Cesium.JulianDate[] = [];
    const positions: Cesium.Cartesian3[] = [];
    for (const s of samples) {
      times.push(Cesium.JulianDate.fromDate(new Date(s.tMs)));
      positions.push(Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.alt));
    }

    let sampled: Cesium.SampledPositionProperty;
    if (canAppend) {
      sampled = ex.position as Cesium.SampledPositionProperty;
    } else {
      sampled = new Cesium.SampledPositionProperty();
      sampled.setInterpolationOptions({
        interpolationAlgorithm: Cesium.LinearApproximation,
        interpolationDegree: 1,
      });
      sampled.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      sampled.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
    }
    sampled.addSamples(times, positions);
    this.lastSampleMs.set(id, samples[samples.length - 1]!.tMs);

    if (ex) {
      if (ex.position !== sampled) ex.position = sampled;
      // Bounded memory: drop samples well behind the clock.
      const cut = Cesium.JulianDate.fromDate(new Date(clockMs - PRUNE_BEHIND_S * 1000));
      sampled.removeSamples(
        new Cesium.TimeInterval({
          start: EPOCH_START,
          stop: cut,
          isStartIncluded: true,
          isStopIncluded: false,
        }),
      );
    } else {
      // Graphics-less entity (position + name + props); the icon + label are
      // painted by the batched primitive layer. props feed its style/label fns.
      const label = name || `NORAD ${norad}`;
      const props = { kind: 'satellite', name, noradId: norad };
      const ent = this.ds.entities.add({ id, position: sampled, name: label, properties: props });
      this.prim?.sync(ent, props);
    }
  }
}
