import * as Cesium from 'cesium';
import { aircraftStyle, vesselStyle } from './adapters/styles.js';
import { labelFor } from './adapters/labelStyle.js';
import { apiFetch } from '../transport/http.js';
import { haversineKm } from './draw.js';
import { createHeatmapDecoder, type HeatmapDecoder } from './heatmapWorker.js';
import {
  chunkKeyForMs,
  chunkStartMs,
  dayUtc,
  nextChunk,
  CHUNK_MS,
  type DecodedHeatmapChunk,
} from './heatmapChunk.js';

// Historical playback — the one transport that actually drives the Cesium
// clock, built on tar1090's chunk mechanism (docs plan "Wave 0").
//
// Two independent paths share this module:
//  - `load(windowSec, onlyId?)` — the ORIGINAL single-shot path: one
//    `/api/history/tracks` fetch for the last `windowSec`, used by
//    Pattern-of-life (EntityPanel -> polReplayStore -> TimeDock). Unchanged
//    behaviour, still a hard `removeAll()` + rebuild every call.
//  - `loadAt(startMs, endMs, onInfo?)` — the chunked replay path TimeDock's
//    day/time pickers drive. The playhead's chunk key is `${day} ${index}`
//    (30-minute UTC half hours); on `clock.onTick`, when the key changes, the
//    next chunk is fetched (and the FOLLOWING one prefetched) and its samples
//    are APPENDED to each id's existing SampledPositionProperty — entities are
//    created on first sight and upserted afterwards. That automatic
//    chunk-to-chunk advance never calls `removeAll()`; only `clear()` and a
//    fresh `loadAt()` call do (a `loadAt()` call is a deliberate jump to a new
//    time context — picking a different day — and tar1090 itself treats that
//    as a new session, not a continuation).
//
// Two data sources feed the chunk path: the archive this box recorded
// (`/api/history/tracks`, aircraft + vessels) and, for aircraft older than
// that archive, public tar1090 heatmap chunks proxied by the backend
// (`/api/history/upstream/chunk`, decoded client-side — binary format spec in
// heatmapChunk.ts). Vessels are always the own archive; aircraft use the own
// archive once the half hour is at or after the earliest recorded day, and the
// upstream chunk before that.
//
// Guardrails honoured (CLAUDE.md):
//  - Icons: replay markers reuse aircraftStyle / vesselStyle, so every contact
//    is its category SVG (never a bare point), rotated toward its last known
//    heading (a plain number reassigned on each new sample — never a
//    per-frame callback property, which would fabricate motion between real
//    fixes).
//  - requestRenderMode STAYS true. We do NOT flip it off. Instead, while a
//    replay is active we lower scene.maximumRenderTimeChange so Cesium renders
//    as simulation time advances; clear() restores the exact prior value
//    (GlobeCanvas pins it to 0 — restoring a hardcoded Infinity would leave
//    the LIVE glide silently unrendered after a replay exit).
//  - Interpolation uses LinearApproximation, matching the live adapter.

interface Track {
  id: string;
  kind: string; // 'aircraft' | 'vessel'
  points: [number, number, number, number][]; // [lon, lat, t(seconds), track_deg]
}
interface TracksResponse {
  tracks: Track[];
}

export type PlaybackSource = 'own' | 'upstream' | 'mixed' | 'none';

export interface PlaybackInfo {
  tracks: number;
  points: number;
  from: number; // epoch seconds
  to: number;
  source: PlaybackSource;
  label: string; // human-readable source description, e.g. "aircraft · adsb.fi archive · vessels · own archive since 2026-08-09"
  maxMultiplier: number; // 600 while the current chunk's aircraft come from upstream, else 3600
}

export interface PlaybackController {
  load(windowSec: number, onlyId?: string): Promise<PlaybackInfo | null>;
  loadAt(startMs: number, endMs: number, onInfo?: (info: PlaybackInfo) => void): Promise<PlaybackInfo | null>;
  clear(): void;
  isActive(): boolean;
  destroy(): void;
}

const AIR_TRAIL = Cesium.Color.fromCssColorString('#facc15').withAlpha(0.55);
const SEA_TRAIL = Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.55);
const DWELL = Cesium.Color.fromCssColorString('#d946ef'); // pattern-of-life dwell highlight
const DWELL_KM = 0.6; // cluster radius
const DWELL_S = 240; // min seconds stationary to count as a dwell
const CHUNK_SEC = CHUNK_MS / 1000;
const CHUNK_CACHE_MAX = 24; // "24-entry LRU of decoded GLOBAL chunks"

function julian(seconds: number): Cesium.JulianDate {
  return Cesium.JulianDate.fromDate(new Date(seconds * 1000));
}

/** A [w,s,e,n] rectangle (degrees) widened 1.2x around its own center, or null
 *  when the viewer has no computable view (headless / off-globe camera) — a
 *  null rect means "don't filter", matching the original unfiltered load(). */
function widenedViewDeg(viewer: Cesium.Viewer): [number, number, number, number] | null {
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return null;
  const w = Cesium.Math.toDegrees(rect.west);
  const s = Cesium.Math.toDegrees(rect.south);
  const e = Cesium.Math.toDegrees(rect.east);
  const n = Cesium.Math.toDegrees(rect.north);
  const dw = (e - w) * 0.1;
  const dh = (n - s) * 0.1;
  return [w - dw, s - dh, e + dw, n + dh];
}

function bboxQueryParam(rect: [number, number, number, number] | null): string {
  if (!rect) return '';
  const [w, s, e, n] = rect;
  return `&min_lon=${w}&min_lat=${s}&max_lon=${e}&max_lat=${n}`;
}

export function installHistoryPlayback(viewer: Cesium.Viewer): PlaybackController {
  const ds = new Cesium.CustomDataSource('history-replay');
  void viewer.dataSources.add(ds);
  let hiddenLive: Cesium.DataSource[] = [];
  let active = false;

  // Hide every other (live) data source so the replay reads cleanly; remember
  // exactly which we hid so clear() restores them and nothing else.
  function hideLive(): void {
    // Re-entrant safe: a second load() (two Pattern-of-life clicks with no exit
    // between) must not lose the saved set. If we skip already-hidden sources
    // while hiddenLive is freshly emptied, restoreLive() later has nothing to
    // un-hide and the live globe stays blank until reload. Restore first, then
    // re-capture whatever is currently visible.
    restoreLive();
    for (let i = 0; i < viewer.dataSources.length; i++) {
      const d = viewer.dataSources.get(i);
      if (d === ds || !d.show) continue;
      d.show = false;
      hiddenLive.push(d);
    }
  }
  function restoreLive(): void {
    for (const d of hiddenLive) d.show = true;
    hiddenLive = [];
  }

  // ── Shared per-id sample store ────────────────────────────────────────────
  // Both load() and loadAt()/the chunk pipeline append through this: one
  // SampledPositionProperty per id, created on first sight. load() clears it
  // (removeAll + rebuild) every call, matching its original behaviour; the
  // chunk pipeline's automatic chunk-to-chunk advance never does.
  interface LiveTrack {
    spp: Cesium.SampledPositionProperty;
    kind: string;
    lastTrackDeg: number;
  }
  const tracks = new Map<string, LiveTrack>();
  let totalPointsAppended = 0;

  function upsertSample(
    id: string,
    kind: string,
    lon: number,
    lat: number,
    tSec: number,
    trackDeg: number | null,
    trailTimeSec: number,
  ): void {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(tSec)) return;

    let tr = tracks.get(id);
    if (!tr) {
      const spp = new Cesium.SampledPositionProperty();
      spp.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      spp.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      spp.setInterpolationOptions({
        interpolationAlgorithm: Cesium.LinearApproximation,
        interpolationDegree: 1,
      });
      tr = { spp, kind, lastTrackDeg: trackDeg ?? 0 };
      tracks.set(id, tr);
    }
    tr.spp.addSample(julian(tSec), Cesium.Cartesian3.fromDegrees(lon, lat));
    if (trackDeg != null) tr.lastTrackDeg = trackDeg;
    totalPointsAppended++;

    const isAir = kind === 'aircraft';
    const style = isAir
      ? aircraftStyle({ track_deg: tr.lastTrackDeg })
      : vesselStyle({ cog: tr.lastTrackDeg });

    const entity = ds.entities.getById(`hist:${id}`);
    if (!entity) {
      const labelText = isAir ? id.replace(/^aircraft:/, '') : id.replace(/^vessel:/, '');
      ds.entities.add({
        id: `hist:${id}`,
        position: tr.spp,
        billboard: {
          image: style.imageUri,
          scale: style.scale,
          rotation: style.rotationRad,
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        },
        label: labelFor(labelText),
        path: {
          material: new Cesium.ColorMaterialProperty(isAir ? AIR_TRAIL : SEA_TRAIL),
          width: 2,
          leadTime: 0,
          trailTime: trailTimeSec,
          resolution: 30,
        },
      });
    } else if (entity.billboard) {
      // Reassigned as a constant property on each new sample — never a
      // per-frame callback. Heading updates at sample granularity, not per
      // frame: the icon points the way its last recorded fix did.
      entity.billboard.rotation = new Cesium.ConstantProperty(style.rotationRad);
    }
  }

  function resetTracks(): void {
    ds.entities.removeAll();
    tracks.clear();
    totalPointsAppended = 0;
  }

  // Pattern-of-life dwell clusters: stretches where the entity stayed within
  // DWELL_KM for ≥ DWELL_S get a magenta ring + duration label.
  function addDwellMarkers(tr: Track): void {
    const pts = tr.points;
    let i = 0;
    while (i < pts.length) {
      const [lon0, lat0, t0] = pts[i]!;
      let j = i + 1;
      let sumLon = lon0;
      let sumLat = lat0;
      let cnt = 1;
      while (j < pts.length) {
        const [lon, lat] = pts[j]!;
        if (haversineKm({ lat: lat0, lon: lon0 }, { lat, lon }) > DWELL_KM) break;
        sumLon += lon;
        sumLat += lat;
        cnt++;
        j++;
      }
      const dur = (pts[j - 1]?.[2] ?? t0) - t0;
      if (dur >= DWELL_S && cnt >= 3) {
        ds.entities.add({
          id: `dwell:${tr.id}:${i}`,
          position: Cesium.Cartesian3.fromDegrees(sumLon / cnt, sumLat / cnt),
          ellipse: {
            semiMajorAxis: 700,
            semiMinorAxis: 700,
            material: DWELL.withAlpha(0.18),
            outline: true,
            outlineColor: DWELL,
            outlineWidth: 2,
            height: 0,
          },
          label: {
            text: `dwell ${Math.round(dur / 60)}m`,
            font: '600 10px "IBM Plex Mono", monospace',
            fillColor: DWELL,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(5, 3),
            pixelOffset: new Cesium.Cartesian2(0, -10),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            // Depth-tested so the globe occludes a far-side dwell label rather
            // than bleeding it through the opposite hemisphere.
          },
        });
      }
      i = Math.max(j, i + 1);
    }
  }

  // ── Clock/render policy save-restore ──────────────────────────────────────
  // Captured on first activation (whichever path — load() or loadAt() — runs
  // first), restored in clear(). GlobeCanvas pins maximumRenderTimeChange to
  // 0 (invariants.test.ts); a hardcoded Infinity in clear() silently stopped
  // the LIVE SampledPositionProperty glide from rendering after any replay.
  let savedMaxRenderTimeChange: number | undefined;
  let savedClockRange: Cesium.ClockRange | undefined;
  let policySaved = false;
  function saveClockPolicyOnce(): void {
    if (policySaved) return;
    savedMaxRenderTimeChange = viewer.scene.maximumRenderTimeChange;
    savedClockRange = viewer.clock.clockRange;
    policySaved = true;
  }

  // ── Legacy single-shot path (Pattern-of-life) ─────────────────────────────
  async function load(windowSec: number, onlyId?: string): Promise<PlaybackInfo | null> {
    chunkActive = false; // pattern-of-life pre-empts any running chunk replay
    const now = Date.now() / 1000;
    const from = now - windowSec;
    const to = now;

    const bboxQ = bboxQueryParam(widenedViewDeg(viewer));
    let data: TracksResponse;
    try {
      const r = await apiFetch(
        `/api/history/tracks?from_ts=${from}&to_ts=${to}&limit_ids=2000${bboxQ}`,
      );
      if (!r.ok) return null;
      data = (await r.json()) as TracksResponse;
    } catch {
      return null;
    }

    resetTracks();
    currentKey = null;

    let pts = 0;
    let trackList = data.tracks ?? [];
    if (onlyId) trackList = trackList.filter((t) => t.id === onlyId);
    for (const tr of trackList) {
      let added = 0;
      for (const [lon, lat, t, trackDeg] of tr.points) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        upsertSample(tr.id, tr.kind, lon, lat, t, trackDeg ?? null, windowSec);
        added++;
      }
      pts += added;
    }
    if (onlyId && trackList[0]) addDwellMarkers(trackList[0]);

    saveClockPolicyOnce();
    viewer.clock.startTime = julian(from);
    viewer.clock.stopTime = julian(to);
    viewer.clock.currentTime = julian(from);
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.shouldAnimate = true;
    // requestRenderMode stays true; this just lets time advancement trigger
    // renders so the replay actually animates.
    viewer.scene.maximumRenderTimeChange = 0.2;

    hideLive();
    active = true;
    viewer.scene.requestRender();
    return {
      tracks: trackList.length,
      points: pts,
      from,
      to,
      source: 'own',
      label: 'own archive',
      maxMultiplier: 3600,
    };
  }

  // ── Chunk pipeline (main transport) ───────────────────────────────────────
  let chunkActive = false;
  let currentKey: string | null = null;
  let onInfoCb: ((info: PlaybackInfo) => void) | null = null;
  let onTickRemover: (() => void) | null = null;
  const decoder: HeatmapDecoder = createHeatmapDecoder();

  // 24-entry LRU of decoded/fetched chunks, keyed "upstream:<day> <index>" or
  // "own:<day> <index>:<kindFilter>". `null` caches a 404/empty answer so a
  // scrub back over an unreachable half hour does not refetch it every time.
  const chunkCache = new Map<string, DecodedHeatmapChunk | Track[] | null>();
  function cacheGet(key: string): DecodedHeatmapChunk | Track[] | null | undefined {
    if (!chunkCache.has(key)) return undefined;
    const v = chunkCache.get(key) ?? null;
    chunkCache.delete(key);
    chunkCache.set(key, v); // bump to most-recently-used
    return v;
  }
  function cacheSet(key: string, v: DecodedHeatmapChunk | Track[] | null): void {
    chunkCache.set(key, v);
    if (chunkCache.size > CHUNK_CACHE_MAX) {
      const oldest = chunkCache.keys().next().value;
      if (oldest !== undefined) chunkCache.delete(oldest);
    }
  }

  interface OldestState {
    ms: number; // 0 = unknown (treat everything as within the own archive)
    day: string | null;
  }
  let oldestPromise: Promise<OldestState> | null = null;
  function resolveOldest(): Promise<OldestState> {
    if (!oldestPromise) {
      oldestPromise = (async (): Promise<OldestState> => {
        try {
          const r = await apiFetch('/api/history/stats');
          if (!r.ok) return { ms: 0, day: null };
          // Two backends, two shapes (apps/api/app/history.py stats()):
          //   sqlite    — an explicit shard day list, no oldest_ts.
          //   timescale — literally "shards": [], plus oldest_ts (MIN(t) as
          //               epoch seconds; null while the archive is empty).
          // Keying this off `shards` alone made the Timescale case read
          // "everything is own archive" and silently killed upstream replay,
          // so prefer the backend-neutral oldest_ts and keep the shard list
          // as the SQLite fallback.
          const s = (await r.json()) as { shards?: { day: string }[]; oldest_ts?: number | null };
          const oldestTs = typeof s.oldest_ts === 'number' && s.oldest_ts > 0 ? s.oldest_ts : null;
          if (oldestTs !== null) {
            const ms = oldestTs * 1000;
            return { ms, day: dayUtc(ms) };
          }
          const days = (s.shards ?? [])
            .map((x) => x.day)
            .filter((d) => d !== 'legacy')
            .sort();
          if (days.length === 0) return { ms: 0, day: null };
          const day = days[0]!;
          return { ms: Date.parse(`${day}T00:00:00Z`), day };
        } catch {
          return { ms: 0, day: null };
        }
      })();
    }
    return oldestPromise;
  }

  async function fetchOwnChunk(startSec: number, endSec: number, kindFilter: 'vessel' | null): Promise<Track[]> {
    const key = `own:${startSec}:${kindFilter ?? 'all'}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return (cached as Track[] | null) ?? [];
    const kindQ = kindFilter ? `&kind=${kindFilter}` : '';
    const bboxQ = bboxQueryParam(widenedViewDeg(viewer));
    try {
      const r = await apiFetch(
        `/api/history/tracks?from_ts=${startSec}&to_ts=${endSec}&limit_ids=2000${kindQ}${bboxQ}`,
      );
      if (!r.ok) {
        cacheSet(key, null);
        return [];
      }
      const data = (await r.json()) as TracksResponse;
      const list = data.tracks ?? [];
      cacheSet(key, list);
      return list;
    } catch {
      cacheSet(key, null);
      return [];
    }
  }

  async function fetchUpstreamChunk(day: string, index: number): Promise<DecodedHeatmapChunk | null> {
    const key = `upstream:${day} ${index}`;
    const cached = cacheGet(key);
    if (cached !== undefined) return cached as DecodedHeatmapChunk | null;
    try {
      const r = await apiFetch(`/api/history/upstream/chunk?day=${day}&index=${index}`);
      if (!r.ok) {
        cacheSet(key, null);
        return null;
      }
      const buf = await r.arrayBuffer();
      const decoded = await decoder.decode(buf);
      cacheSet(key, decoded);
      return decoded;
    } catch {
      cacheSet(key, null);
      return null;
    }
  }

  function sourceLabel(oldestDay: string | null): string {
    return oldestDay
      ? `aircraft · adsb.fi archive · vessels · own archive since ${oldestDay}`
      : `aircraft · adsb.fi archive · vessels · own archive`;
  }
  let staticLabel = sourceLabel(null);

  function buildInfo(source: PlaybackSource, from: number, to: number): PlaybackInfo {
    return {
      tracks: tracks.size,
      points: totalPointsAppended,
      from,
      to,
      source,
      label: staticLabel,
      maxMultiplier: source === 'upstream' || source === 'mixed' ? 600 : 3600,
    };
  }

  /** Fetch + append one half hour's data. In-view filtering (1.2x-widened
   *  camera rect) applies to the upstream global chunk only — the own-archive
   *  fetch is already server-side bbox filtered. A pan mid-chunk is not
   *  retroactively re-filtered until the next chunk boundary (named
   *  simplification, not a re-render loop). */
  async function loadChunkInto(
    day: string,
    index: number,
    aircraftFromUpstream: boolean,
  ): Promise<{ source: PlaybackSource }> {
    const startSec = chunkStartMs(day, index) / 1000;
    const endSec = startSec + CHUNK_SEC;
    let sawOwn = false;
    let sawUpstream = false;

    const ownTracks = await fetchOwnChunk(startSec, endSec, aircraftFromUpstream ? 'vessel' : null);
    for (const tr of ownTracks) {
      for (const [lon, lat, t, trackDeg] of tr.points) {
        upsertSample(tr.id, tr.kind, lon, lat, t, trackDeg ?? null, CHUNK_SEC);
        sawOwn = true;
      }
    }

    if (aircraftFromUpstream) {
      const decoded = await fetchUpstreamChunk(day, index);
      if (decoded) {
        const rect = widenedViewDeg(viewer);
        for (const p of decoded.positions) {
          if (rect && (p.lon < rect[0] || p.lon > rect[2] || p.lat < rect[1] || p.lat > rect[3])) continue;
          upsertSample(`aircraft:${p.hex}`, 'aircraft', p.lon, p.lat, p.t / 1000, p.track, CHUNK_SEC);
          sawUpstream = true;
        }
      }
    }

    const source: PlaybackSource = sawOwn && sawUpstream ? 'mixed' : sawUpstream ? 'upstream' : sawOwn ? 'own' : 'none';
    return { source };
  }

  function ensureTickListener(): void {
    if (onTickRemover) return;
    const off = viewer.clock.onTick.addEventListener((clock: Cesium.Clock) => {
      if (!chunkActive) return;
      const ms = Cesium.JulianDate.toDate(clock.currentTime).getTime();
      const { day, index } = chunkKeyForMs(ms);
      const key = `${day} ${index}`;
      if (key === currentKey) return;
      currentKey = key;
      void (async () => {
        const oldest = await resolveOldest();
        const startMs = chunkStartMs(day, index);
        const result = await loadChunkInto(day, index, startMs < oldest.ms);
        viewer.scene.requestRender();
        if (onInfoCb) onInfoCb(buildInfo(result.source, startMs / 1000, (startMs + CHUNK_MS) / 1000));
      })();
      const nxt = nextChunk(day, index);
      void (async () => {
        const oldest = await resolveOldest();
        if (chunkStartMs(nxt.day, nxt.index) < oldest.ms) void fetchUpstreamChunk(nxt.day, nxt.index);
      })();
    });
    onTickRemover = () => off();
  }

  async function loadAt(
    startMs: number,
    endMs: number,
    onInfo?: (info: PlaybackInfo) => void,
  ): Promise<PlaybackInfo | null> {
    // A deliberate jump to a new time context (day/time picker), distinct from
    // the automatic chunk-to-chunk advance in ensureTickListener() above,
    // which never clears.
    resetTracks();
    currentKey = null;
    onInfoCb = onInfo ?? null;

    saveClockPolicyOnce();
    viewer.clock.startTime = julian(startMs / 1000);
    viewer.clock.stopTime = julian(endMs / 1000);
    viewer.clock.currentTime = julian(startMs / 1000);
    viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;
    viewer.clock.shouldAnimate = true;
    viewer.scene.maximumRenderTimeChange = 0.2;

    hideLive();
    active = true;
    chunkActive = true;
    ensureTickListener();

    const oldest = await resolveOldest();
    staticLabel = sourceLabel(oldest.day);

    const { day, index } = chunkKeyForMs(startMs);
    currentKey = `${day} ${index}`;
    const result = await loadChunkInto(day, index, chunkStartMs(day, index) < oldest.ms);
    const nxt = nextChunk(day, index);
    if (chunkStartMs(nxt.day, nxt.index) < oldest.ms) void fetchUpstreamChunk(nxt.day, nxt.index);

    viewer.scene.requestRender();
    return buildInfo(result.source, startMs / 1000, endMs / 1000);
  }

  function clear(): void {
    resetTracks();
    currentKey = null;
    chunkActive = false;
    onInfoCb = null;
    restoreLive();
    viewer.clock.clockRange = savedClockRange ?? Cesium.ClockRange.UNBOUNDED;
    viewer.clock.currentTime = Cesium.JulianDate.now();
    viewer.clock.shouldAnimate = true;
    viewer.scene.maximumRenderTimeChange = savedMaxRenderTimeChange ?? 0;
    policySaved = false;
    active = false;
    viewer.scene.requestRender();
  }

  function destroy(): void {
    // Runs from TimeDock's effect cleanup, which can fire after the viewer is
    // already destroyed (HMR teardown / globe ErrorBoundary). A destroyed
    // viewer disposes its data sources for us and throws on access — bail.
    // The Worker is ours, not the viewer's: terminate it BEFORE the bail or
    // the thread (and its bundled module graph) outlives the component on
    // exactly the teardown path this early return covers.
    decoder.terminate();
    if (viewer.isDestroyed()) return;
    if (active) clear();
    if (onTickRemover) {
      onTickRemover();
      onTickRemover = null;
    }
    viewer.dataSources.remove(ds, true);
  }

  return { load, loadAt, clear, isActive: () => active, destroy };
}
