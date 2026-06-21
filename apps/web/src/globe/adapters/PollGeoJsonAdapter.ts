import * as Cesium from 'cesium';
import type { LayerAdapter, AdapterCtx } from './types.js';
import {
  aircraftStyle,
  cameraStyle,
  fireStyle,
  jammingPolygonStyle,
  quakeStyle,
  vesselStyle,
} from './styles.js';
import { labelFor, aircraftLabelText, vesselLabelText } from './labelStyle.js';
import { tracks } from '../../intel/tracks.js';
import { aircraftDedup } from '../../intel/registry.js';
import { isMobileDevice } from '../../shell/device.js';
import { useSelection } from '../../state/stores.js';
import { apiFetch, withWsKey } from '../../transport/http.js';

// Minimum-perceptible deltas for billboard updates. Cesium reloads the
// underlying GPU resource whenever a billboard property is *reassigned* —
// even when the new value is identical to the current one. At 4 s polls
// over 8 K aircraft that turns into a constant icon reload storm: icons
// blink off then on while the data URI re-decodes. We diff against the
// current value and skip the assignment when the change is below the
// noise floor.
const ROT_EPSILON = 0.01; // ~0.57°
const SCALE_EPSILON = 0.02;

// Minimum delay the grid scheduler will book between polls. Not a cadence
// target — only a yield so a re-anchor after an overrun can't fire back-to-back
// polls and starve the main thread.
const GRID_MIN_GAP_MS = 100;

// Per-frame upsert budget (ms). A payload of ~8-13k entities is applied in
// slices of at most this long so no single frame blocks — the cure for the
// periodic "stop" when a push lands. ~6ms leaves the rest of the 16ms frame for
// Cesium's own render of the interpolated billboards. A full world payload drains
// over ~12-22 frames (~200-370ms), comfortably inside the ~2s push interval.
const DRAIN_BUDGET_MS = 6;

// First-payload budget: the very first world snapshot has nothing animating yet,
// so spend a bigger one-time slice to place all ~13k icons in ~3 frames instead
// of dribbling them in over ~30 (the "takes a while to load all the planes in"
// report). Subsequent live pushes revert to DRAIN_BUDGET_MS so a push never
// blocks a frame mid-animation.
const FIRST_DRAIN_BUDGET_MS = 50;


// Initial great-circle bearing (deg, 0=N) from point 1 to point 2. Used as a
// heading fallback so an icon whose feed omits track/cog still points the way
// it's actually moving instead of freezing pointing north.
function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const phi1 = Cesium.Math.toRadians(lat1);
  const phi2 = Cesium.Math.toRadians(lat2);
  const dLambda = Cesium.Math.toRadians(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Cesium.Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
}

// Read a Cesium property's *current* value. Works for ConstantProperty,
// CallbackProperty, etc. Returns undefined if the property is unset.
function currentValue<T>(prop: Cesium.Property | undefined): T | undefined {
  if (!prop) return undefined;
  try {
    return prop.getValue(Cesium.JulianDate.now()) as T | undefined;
  } catch {
    return undefined;
  }
}

// Inflate a gzip-compressed WS frame to text. The /ws/adsb push reuses the exact
// gzipped bytes the HTTP route serves (one artifact, two transports); the browser
// inflates them with the native DecompressionStream — no library, no main-thread
// gunzip loop. Supported in all current evergreen browsers.
async function gunzipToText(buf: ArrayBuffer): Promise<string> {
  const stream = new Response(buf).body;
  if (!stream || typeof DecompressionStream === 'undefined') {
    // ponytail: no DecompressionStream → caller can still handle a text frame.
    throw new Error('gzip inflate unavailable');
  }
  const inflated = stream.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(inflated).text();
}

export type StyleKind = 'quake' | 'aircraft' | 'fire' | 'vessel' | 'jamming' | 'camera' | 'generic';

interface Props {
  ctx: AdapterCtx;
  endpoint: string;
  intervalSec: number;
  styleKind: StyleKind;
  // Optional bbox provider — re-evaluated every poll so AOI changes propagate
  // without recreating the adapter.
  bboxQuery?: () => string | null;
  // When true, re-poll on camera moveEnd (debounced) so a viewport-scoped
  // query loads the newly-revealed area immediately instead of after the next
  // timer tick. Used by the high-volume viewport layers (global ADS-B + AIS).
  refreshOnMove?: boolean;
  // Optional WebSocket endpoint for server-pushed world-view updates (ADS-B).
  // When set, the adapter renders the push at world view (steady, server-timed
  // cadence — no request round-trip in the loop) and falls back to the HTTP poll
  // on disconnect OR when zoomed in (the push carries only the world-view blob;
  // a bbox view needs the per-viewport poll).
  ws?: string;
}

interface PointGeometry {
  type: 'Point';
  coordinates: [number, number] | [number, number, number];
}

interface PolygonGeometry {
  type: 'Polygon';
  /** Outer ring first. Each position is [lon, lat] or [lon, lat, alt]. */
  coordinates: Array<Array<[number, number] | [number, number, number]>>;
}

interface Feature {
  type: 'Feature';
  id?: string | number;
  geometry: PointGeometry | PolygonGeometry;
  properties: Record<string, unknown>;
}

interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
  // The backend uses this field to signal "no data, not no contacts":
  // - missing API key
  // - upstream rate-limited
  // - other operational reasons the feed cannot deliver right now
  note?: string;
}

// Per-layer entity cap removed — clustering at world/continent scale means
// unlimited entities stay responsive. Clustering aggregates far-away entities
// into count bubbles; individual icons appear only when zoomed in.
const MAX_PER_LAYER = Number.MAX_SAFE_INTEGER;

// djb2 string hash → unsigned 32-bit, base36 for compact ids. Used only to
// synthesise a stable id when the upstream feature carries no id but does
// carry identifying properties (callsign/icao24/mmsi/source). The hash is
// deterministic across polls, so the same physical contact lands on the
// same entity slot even as its position changes — without this, a moving
// aircraft would create a new entity every tick.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Per-layer render budget on phones. A phone can't hold 5k vessels + 4k sats +
// 2k aircraft (12k+ entities = the overheating). Cap EACH layer to a STABLE
// subset — keyed by a hash of the feature id so the SAME contacts persist across
// polls (a random per-poll subset would churn the upsert and freeze motion, see
// CLAUDE.md world-view decimation lesson). Desktop is uncapped (Infinity).
const MOBILE_LAYER_CAP = isMobileDevice() ? 2000 : Number.POSITIVE_INFINITY;

function stableSubset(feats: Feature[], cap: number): Feature[] {
  if (feats.length <= cap) return feats;
  const scored = feats.map((f) => {
    const p = (f.properties ?? {}) as Record<string, unknown>;
    const key = String(f.id ?? p['icao24'] ?? p['mmsi'] ?? p['id'] ?? '');
    return { h: djb2(key), f };
  });
  // djb2 returns a base-36 string; lexical sort is deterministic → stable subset.
  scored.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  return scored.slice(0, cap).map((s) => s.f);
}

// Pull a stable identity key from a feature's properties. We accept anything
// that uniquely names a contact: callsign + icao24 + source for aircraft,
// mmsi for vessels, id for everything else. Returns null when nothing
// identifying is present, in which case the caller falls back to coords.
function identityKey(props: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const callsign = props['callsign'];
  const icao24 = props['icao24'];
  const mmsi = props['mmsi'];
  const src = props['source'];
  if (typeof callsign === 'string' && callsign.length > 0) parts.push(`cs:${callsign}`);
  if (typeof icao24 === 'string' && icao24.length > 0) parts.push(`ic:${icao24}`);
  if (mmsi != null) parts.push(`mm:${mmsi}`);
  if (typeof src === 'string' && src.length > 0) parts.push(`sr:${src}`);
  return parts.length > 0 ? parts.join('|') : null;
}

// Polls a GeoJSON endpoint and upserts entities by id. Old entities that
// disappeared in the latest poll are removed. This avoids the removeAll +
// re-create churn that produces flicker and GC pressure at 8K+ aircraft.
//
// Feed health is reported truthfully:
// - 200 with note + empty features → amber (no data, not no contacts)
// - 200 with features → green (last-seen = now)
// - non-200 or transport error → red
// - 200 with empty features and no note → green ("no contacts" is fresh data)
export class PollGeoJsonAdapter implements LayerAdapter {
  private ds: Cesium.CustomDataSource;
  private timer: number | null = null;
  private aborter: AbortController | null = null;
  private detached = false;
  // entityId → icao24 for aircraft entities currently owned by this layer.
  // Used during the prune phase to release dedup claims when an aircraft
  // disappears from the upstream feed (so a lower-priority layer can take
  // over rendering it).
  private ownedIcao = new Map<string, string>();
  // entityId → epoch seconds of the newest position fix we've sampled.
  // entityId → last anchored [lon, lat, wallClockMs]. A new fix is detected by
  // position change (the feed re-sends the same fix each poll and seen_at is
  // usually absent), so an unchanged position HOLDs instead of re-anchoring —
  // the cure for the per-poll oscillation that looked like looping/teleporting.
  // The timestamp lets us glide each move over the REAL interval since the last
  // fix, so motion matches the aircraft's true speed instead of rushing.
  private lastAnchorLL = new Map<string, [number, number, number]>();
  // entityId → last [lon, lat], so we can derive a heading from movement when
  // the feed doesn't carry track/cog (otherwise the icon points north).
  private lastPos = new Map<string, [number, number]>();
  // Absolute wall-clock target (ms) for the next poll. The grid scheduler books
  // ticks against this fixed timeline so cadence stays steady regardless of how
  // long each poll's fetch + render took. 0 = uninitialised (set on first tick).
  private nextAt = 0;
  // Last ETag seen on a world-view response — sent back as If-None-Match so a
  // poll landing inside the same 2s backend cycle gets a 304 and skips the
  // parse + entity walk entirely (null when zoomed: the bbox path has no ETag).
  private lastEtag: string | null = null;
  // WebSocket push (ADS-B world view). wsActive gates the HTTP poll: while the
  // socket is healthy AND we're at world view, the pushed blob already carries
  // the data so the poll no-ops; the poll resumes immediately on disconnect or
  // zoom-in. reconnect delay backs off 1s→30s like AisWsAdapter.
  private wsConn: WebSocket | null = null;
  private wsReconnectDelay = 1000;
  private wsActive = false;
  // Time-sliced upsert queue. render() enqueues the latest payload; drain()
  // applies a budgeted slice per animation frame so a big batch never freezes a
  // frame. A new payload replaces the queue (latest wins); the full-scan prune at
  // pass end keeps an interrupted pass from leaking entities.
  private pendingFeats: Feature[] = [];
  private pendingIds = new Set<string>();
  private pendingIdx = 0;
  private drainHandle: number | null = null;
  // True until the first full payload is placed; gates FIRST_DRAIN_BUDGET_MS.
  private firstDrain = true;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  // Detach handle for the camera moveEnd listener (viewport layers only).
  private detachMove: (() => void) | null = null;

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    // The await above yields — the viewer can be torn down before we resume
    // (HMR / rapid layer toggle). Bail if so; accessing viewer.camera on a
    // destroyed viewer throws "Cannot read properties of undefined".
    if (this.detached || viewer.isDestroyed()) return;
    if (this.props.refreshOnMove) {
      // Debounce so a multi-step zoom/pan coalesces into one re-poll of the
      // new viewport (not one per intermediate camera event).
      let t: number | null = null;
      const onMove = (): void => {
        if (t != null) window.clearTimeout(t);
        t = window.setTimeout(() => this.refresh(), 200);
      };
      viewer.camera.moveEnd.addEventListener(onMove);
      this.detachMove = () => {
        if (t != null) window.clearTimeout(t);
        if (!viewer.isDestroyed()) viewer.camera.moveEnd.removeEventListener(onMove);
      };
    }
    // Server push (ADS-B): connect the socket for steady world-view updates. The
    // poll loop still starts — it gives instant first paint before the socket
    // opens and is the fallback while the socket is down / when zoomed in.
    if (this.props.ws) this.connectWs();
    this.scheduleNext(0);
  }

  // Forced re-poll — used when the AOI changes so the bbox query updates
  // without waiting for the next scheduled tick.
  refresh(): void {
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext(0);
  }

  detach(): void {
    this.detached = true;
    this.detachMove?.();
    this.detachMove = null;
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.aborter?.abort();
    if (this.drainHandle != null) {
      window.cancelAnimationFrame(this.drainHandle);
      this.drainHandle = null;
    }
    this.wsActive = false;
    try {
      this.wsConn?.close();
    } catch {
      /* already closing */
    }
    this.wsConn = null;
    // Release every dedup claim this layer was holding so other layers can
    // take over rendering the affected icao24s on their next poll.
    const layerId = this.props.ctx.descriptor.id;
    for (const icao of this.ownedIcao.values()) {
      aircraftDedup.release(icao, layerId);
    }
    this.ownedIcao.clear();
    this.lastAnchorLL.clear();
    this.lastPos.clear();
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* viewer destroyed */
    }
  }

  // Fixed-rate poll pinned to an ABSOLUTE wall-clock grid. The old scheduler
  // booked the next tick at max(ttl - elapsed, 250ms), so `elapsed` — fetch +
  // the synchronous render of up to 20k entities — leaked straight into the
  // cadence: a slow poll stretched the gap and the refresh visibly ran
  // short-long-short-long. Here each tick targets the next ttl boundary on a
  // fixed timeline (`nextAt += ttl`) independent of how long the poll took, so
  // the beat stays steady as long as a poll finishes within ttl. If a poll
  // overruns, or the tab was backgrounded and we fell more than one interval
  // behind, re-anchor to now (one GRID_MIN_GAP catch-up) instead of a sprint.
  private scheduleNext(delayMs: number): void {
    if (this.detached) return;
    this.timer = window.setTimeout(() => {
      if (this.nextAt === 0) this.nextAt = Date.now();
      void this.poll().finally(() => {
        const ttl = this.props.intervalSec * 1000;
        const now = Date.now();
        this.nextAt += ttl;
        if (this.nextAt < now) this.nextAt = now; // fell behind → re-anchor, no sprint
        this.scheduleNext(Math.max(this.nextAt - now, GRID_MIN_GAP_MS));
      });
    }, delayMs);
  }

  private buildUrl(): string {
    const bbox = this.props.bboxQuery?.();
    if (!bbox) return this.props.endpoint;
    const sep = this.props.endpoint.includes('?') ? '&' : '?';
    return `${this.props.endpoint}${sep}${bbox}`;
  }

  private async poll(): Promise<void> {
    // While the WS push is healthy AND we're at world view, the pushed blob
    // already carries this data — skip the redundant fetch + render. When zoomed
    // in the push (world-view subset) is insufficient, so the bbox poll runs even
    // with the socket open.
    if (this.wsActive && this.isWorldView()) {
      this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
      return;
    }
    this.aborter?.abort();
    this.aborter = new AbortController();
    const worldView = this.isWorldView();
    try {
      const headers: Record<string, string> = {};
      // Conditional request only at world view (the only response carrying an
      // ETag): an unchanged blob returns 304 and we skip the parse + entity walk
      // entirely. The bbox path has no ETag, so it always renders.
      if (worldView && this.lastEtag) headers['If-None-Match'] = this.lastEtag;
      const r = await apiFetch(this.buildUrl(), { signal: this.aborter.signal, headers });
      if (r.status === 304) {
        this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
        return;
      }
      if (!r.ok) {
        this.props.ctx.reportStatus({ status: 'red', note: `upstream ${r.status}` });
        return;
      }
      this.lastEtag = worldView ? r.headers.get('etag') : null;
      const data = (await r.json()) as FeatureCollection;
      this.render(data);
      const note = data.note;
      if (note) {
        // Backend explicitly said it cannot deliver — that's "no data".
        this.props.ctx.reportStatus({ status: 'amber', note });
      } else {
        this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
      }
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return;
      this.props.ctx.reportStatus({ status: 'red', note: 'transport error' });
    }
  }

  // World view = the query the WS push serves (no bbox; just `limit=…`). A
  // zoomed/bbox query carries `lamin=`, so the push is suppressed and the bbox
  // poll owns the entities. No coupling to the literal world cap value.
  private isWorldView(): boolean {
    const q = this.props.bboxQuery?.();
    return !q || !q.includes('lamin');
  }

  // Open the server-push socket and route inflated frames into the SAME render()
  // path as the poll, so the icon/label/glide guardrails keep a single owner.
  private connectWs(): void {
    if (this.detached || !this.props.ws) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const base = this.props.ws.startsWith('ws')
      ? this.props.ws
      : `${proto}://${window.location.host}${this.props.ws}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(withWsKey(base));
    } catch {
      this.scheduleWsReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.wsConn = ws;
    ws.onopen = () => {
      this.wsReconnectDelay = 1000;
      this.wsActive = true;
    };
    ws.onmessage = (ev) => {
      void this.onWsFrame(ev.data);
    };
    ws.onclose = () => {
      // Drop to the poll fallback (its next grid tick fetches) and retry the WS.
      this.wsActive = false;
      this.wsConn = null;
      this.scheduleWsReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
  }

  private scheduleWsReconnect(): void {
    if (this.detached) return;
    window.setTimeout(() => this.connectWs(), this.wsReconnectDelay);
    this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 30_000);
  }

  private async onWsFrame(data: unknown): Promise<void> {
    // Only the world view is pushed; if the user has zoomed in, the bbox poll
    // owns the entities — dropping the frame avoids the world subset clobbering
    // the detailed local set.
    if (!this.isWorldView()) return;
    try {
      let text: string;
      if (data instanceof ArrayBuffer) {
        text = await gunzipToText(data);
      } else if (typeof data === 'string') {
        text = data; // ponytail: text-frame fallback if the push is ever uncompressed
      } else {
        return;
      }
      const fc = JSON.parse(text) as FeatureCollection;
      this.render(fc);
      this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
    } catch {
      /* drop a bad/partial frame; the next push or the poll fallback recovers */
    }
  }

  private render(fc: FeatureCollection): void {
    // Time-slice the upsert across animation frames so applying ~8-13k entities
    // never blocks a single frame — that synchronous batch was the periodic
    // "stop" felt the moment each push landed. Enqueue this payload (replacing
    // any still draining; latest wins) and drain a budgeted slice per frame.
    const incoming = fc.features ?? [];
    const capped = incoming.length > MOBILE_LAYER_CAP ? stableSubset(incoming, MOBILE_LAYER_CAP) : incoming;
    this.pendingFeats = capped.slice(0, MAX_PER_LAYER);
    this.pendingIds = new Set<string>();
    this.pendingIdx = 0;
    if (this.drainHandle == null) {
      this.drainHandle = window.requestAnimationFrame(() => this.drain());
    }
  }

  private drain(): void {
    this.drainHandle = null;
    if (this.detached) return;
    const entities = this.ds.entities;
    const feats = this.pendingFeats;
    const nextIds = this.pendingIds;
    const deadline =
      performance.now() + (this.firstDrain ? FIRST_DRAIN_BUDGET_MS : DRAIN_BUDGET_MS);
    entities.suspendEvents();
    while (this.pendingIdx < feats.length && performance.now() < deadline) {
      const f = feats[this.pendingIdx++];
      if (!f || !f.geometry) continue;
      const props = f.properties as Record<string, unknown>;

      // --- Polygon path (e.g. jamming hexagons) ---
      if (f.geometry.type === 'Polygon') {
        let id: string;
        if (f.id != null) {
          id = String(f.id);
        } else {
          const key = identityKey(props);
          id = key
            ? `${this.props.ctx.descriptor.id}:${djb2(key)}`
            : `${this.props.ctx.descriptor.id}:poly:${JSON.stringify((f.geometry as PolygonGeometry).coordinates[0]?.[0])}`;
        }
        nextIds.add(id);

        const existing = entities.getById(id);
        if (existing) {
          existing.properties = new Cesium.PropertyBag(props);
          this.refreshStyle(existing, props);
        } else {
          const opts: Cesium.Entity.ConstructorOptions = { id, properties: props };
          this.applyStyle(opts, props, f.geometry as PolygonGeometry);
          entities.add(opts);
        }
        continue;
      }

      // --- Point path (default) ---
      const coords = (f.geometry as PointGeometry).coordinates;
      if (!coords) continue;
      const [lon, lat, alt] = coords;

      // Stable id: prefer the upstream-provided f.id, then a content hash of
      // identifying properties (so the SAME aircraft keeps the same entity
      // across polls even though its lon/lat changes every tick), and only
      // fall back to coord-based id when the feature is anonymous.
      let id: string;
      if (f.id != null) {
        id = String(f.id);
      } else {
        const key = identityKey(props);
        id = key
          ? `${this.props.ctx.descriptor.id}:${djb2(key)}`
          : `${this.props.ctx.descriptor.id}:${lon},${lat}`;
      }

      // Cross-layer aircraft dedup. When the user has e.g. mil + global
      // enabled, an Air Force aircraft shows up in BOTH feeds — without this
      // guard each layer's CustomDataSource adds its own entity for the same
      // icao24 and the operator sees stacked icons. Highest-priority layer
      // wins; lower-priority layers skip render AND drop any prior entity
      // they were holding for this aircraft so the icon disappears from the
      // loser-layer immediately.
      const layerId = this.props.ctx.descriptor.id;
      const icao24 = props['icao24'];
      if (this.props.styleKind === 'aircraft' && typeof icao24 === 'string' && icao24.length > 0) {
        const key = icao24.toLowerCase();
        const owner = aircraftDedup.claim(key, layerId);
        if (owner !== layerId) {
          // Another layer with >= priority owns this aircraft. If we were
          // previously rendering it (e.g. priority order changed because the
          // other layer just attached) drop our entity now. Do NOT add to
          // nextIds — the prune phase below will remove the stale entity.
          if (this.ownedIcao.has(id)) {
            entities.removeById(id);
            this.ownedIcao.delete(id);
          }
          continue;
        }
        // We own it this tick. Remember the icao for release-on-prune.
        this.ownedIcao.set(id, key);
      }

      nextIds.add(id);

      // Heading fallback: when the feed omits track/cog, derive it from the
      // direction of actual movement (bearing from the previous fix) and write
      // it back into props so BOTH the icon rotation (aircraftStyle/vesselStyle)
      // and the dead-reckoning vector use it. Without this a vectorless contact
      // froze pointing north.
      if (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') {
        const hdgKey = this.props.styleKind === 'aircraft' ? 'track_deg' : 'cog';
        const prev = this.lastPos.get(id);
        if (typeof props[hdgKey] !== 'number' && prev) {
          const [plon, plat] = prev;
          if (Math.abs(plon - lon) > 1e-6 || Math.abs(plat - lat) > 1e-6) {
            props[hdgKey] = bearingDeg(plon, plat, lon, lat);
          }
        }
        this.lastPos.set(id, [lon, lat]);
      }

      // Feed track ring for the entity-panel sparkline
      if (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') {
        // Track points are stamped with the fix's true OBSERVATION time, not
        // receipt time — under bursty refresh, receipt-time stamps bunched
        // fixes together and the trail polyline drew stair-steps. Observation
        // time = seen_at − seen_pos_s (how old the POSITION is), so a stale
        // source that wins a poll lands at its real (earlier) time and the
        // trail's time-regression guard drops it instead of drawing a backward
        // spike.
        const seenAtProp = props['seen_at'];
        const seenPosProp = props['seen_pos_s'];
        const obsSec =
          typeof seenAtProp === 'number'
            ? seenAtProp - (typeof seenPosProp === 'number' ? seenPosProp : 0)
            : null;
        const tp: { t: number; lon: number; lat: number; alt: number; sog?: number; track?: number } = {
          t: obsSec != null ? obsSec * 1000 : Date.now(),
          lon,
          lat,
          alt: alt ?? 0,
        };
        // Aircraft feeds use OpenSky-style `velocity_ms` / `track_deg`; vessel
        // feeds use AIS `sog` / `cog`. Read whichever is present so the
        // entity-panel sparkline shows real speed+heading for vessels too —
        // before this, every Digitraffic ship plotted as a flat-zero spark.
        const sog =
          (props['velocity_ms'] as number | null | undefined) ??
          (props['sog'] as number | null | undefined);
        const trk =
          (props['track_deg'] as number | null | undefined) ??
          (props['cog'] as number | null | undefined);
        if (sog != null) tp.sog = sog;
        if (trk != null) tp.track = trk;
        // The currently-selected entity bypasses dedup so the magenta
        // polyline gains a new fix on every poll (2s cadence → 30 points in
        // 60s) instead of looking like a straight line for slow movers.
        const force = useSelection.getState().selectedEntityId === id;
        tracks.push(id, tp, { force });
      }

      const existing = entities.getById(id);
      const newPos = Cesium.Cartesian3.fromDegrees(lon, lat, alt ?? 0);
      const isTrackable = this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel';
      if (existing) {
        if (this.props.styleKind === 'aircraft') {
          // TELEPORT mode (operator request 2026-06-21, overriding the prior
          // glide guardrail): snap the aircraft straight to each new REAL fix —
          // no interpolation — so the icon shows the latest reported position
          // instantly, like a raw ADS-B map. Still real-data-only (no synthesis
          // / dead-reckon). The glide model `upsertAircraftSamples` is kept below
          // but intentionally UNCALLED so reverting is a one-line swap.
          existing.position = new Cesium.ConstantPositionProperty(newPos);
        } else if (isTrackable) {
          // Stationary-entity bypass: if the new position is within 100m of
          // the previous one (parked aircraft, anchored vessel), don't churn
          // a SampledPositionProperty for it — keep a ConstantPositionProperty
          // so the interpolator doesn't allocate samples for entities that
          // aren't moving.
          const t0 = this.props.ctx.viewer.clock.currentTime;
          const prevPos = existing.position?.getValue(t0) as Cesium.Cartesian3 | undefined;
          if (
            prevPos &&
            Cesium.Cartesian3.distance(prevPos, newPos) < 100 &&
            !(existing.position instanceof Cesium.SampledPositionProperty)
          ) {
            existing.position = new Cesium.ConstantPositionProperty(newPos);
          } else {
            // Smoothly interpolate between the previous fix and this one by
            // appending to a SampledPositionProperty. For AIRCRAFT we use a
            // degree-2 Lagrange polynomial across the last 3 samples so the
            // tweener produces a curve through successive fixes instead of
            // straight line segments — at 250 m/s a 2 s gap is ~500 m, and
            // a linear interp shows visible "kinks" at each fix. Vessels
            // stay on Linear because their motion is slow enough that a
            // higher-order interp would overshoot into bizarre wakes.
            let sampled = existing.position as Cesium.SampledPositionProperty | undefined;
            if (!(sampled instanceof Cesium.SampledPositionProperty)) {
              sampled = new Cesium.SampledPositionProperty();
              // Vessels stay on Linear — slow movers; a higher-order interp
              // would overshoot into bizarre wakes. (Aircraft are snapped to each
              // fix in the teleport branch above and never reach this branch.)
              sampled.setInterpolationOptions({
                interpolationAlgorithm: Cesium.LinearApproximation,
                interpolationDegree: 1,
              });
              sampled.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
              sampled.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
              // Seed with current Cesium clock time at the existing pos
              const old = existing.position?.getValue(t0);
              if (old) sampled.addSample(t0, old);
              existing.position = sampled;
            }
            // Sample with the Cesium clock's current time (not wall-clock).
            // Cesium's interpolator only fires when the simulation clock
            // advances past a sample's JulianDate — using new Date() ties
            // the swap to wall-clock and breaks paused/scrubbed playback.
            const tNow = this.props.ctx.viewer.clock.currentTime.clone();
            // Decimate near-duplicate samples: if the entity barely moved
            // since the last fix (<50 m) AND it's been less than 60 s, skip
            // the addSample. Without this an anchored vessel at a 30s poll
            // cadence accumulates ~1 sample/poll forever — SampledPosition-
            // Property's internal arrays grow without bound and the
            // interpolator slows linearly.
            const prevForDecimation = sampled.getValue(t0) as Cesium.Cartesian3 | undefined;
            let skip = false;
            if (prevForDecimation) {
              const movedM = Cesium.Cartesian3.distance(prevForDecimation, newPos);
              const elapsedSec = Math.abs(Cesium.JulianDate.secondsDifference(tNow, t0));
              if (movedM < 50 && elapsedSec < 60) skip = true;
            }
            if (!skip) {
              sampled.addSample(tNow, newPos);
              // Prune anything older than 5 minutes. Very aggressive memory
              // management: keeps only recent history for sparklines while
              // staying responsive at 10k+ entity scale.
              const cutoff = Cesium.JulianDate.addSeconds(tNow, -300, new Cesium.JulianDate());
              sampled.removeSamples(
                new Cesium.TimeInterval({
                  start: Cesium.JulianDate.fromIso8601('1970-01-01T00:00:00Z'),
                  stop: cutoff,
                  isStartIncluded: true,
                  isStopIncluded: false,
                }),
              );
            }
          }
        } else {
          existing.position = new Cesium.ConstantPositionProperty(newPos);
        }
        existing.properties = new Cesium.PropertyBag(props);
        this.refreshStyle(existing, props);
      } else {
        const opts: Cesium.Entity.ConstructorOptions = {
          id,
          position: newPos,
          properties: props,
        };
        this.applyStyle(opts, props);
        // TELEPORT mode: the entity is created at newPos (a ConstantPosition-
        // Property), i.e. already snapped to the latest real fix — no glide seed
        // needed. (Glide model `upsertAircraftSamples` retained, uncalled.)
        entities.add(opts);
      }
    }
    entities.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();

    if (this.pendingIdx < feats.length) {
      // More of this payload to apply — yield, continue next frame.
      this.drainHandle = window.requestAnimationFrame(() => this.drain());
      return;
    }
    // First full payload is placed — drop to the small per-frame budget so
    // subsequent live pushes never block a frame mid-animation.
    this.firstDrain = false;

    // Payload fully applied: prune entities absent from it and release their
    // dedup claims. Full scan of the datasource (not a seenIds diff) so a pass
    // interrupted by a fresh payload can't leak an entity the new payload omits.
    const layerIdForPrune = this.props.ctx.descriptor.id;
    const stale: string[] = [];
    for (const e of entities.values) {
      if (!nextIds.has(e.id)) stale.push(e.id);
    }
    if (stale.length > 0) {
      entities.suspendEvents();
      for (const oldId of stale) {
        entities.removeById(oldId);
        this.lastAnchorLL.delete(oldId);
        this.lastPos.delete(oldId);
        const icao = this.ownedIcao.get(oldId);
        if (icao) {
          aircraftDedup.release(icao, layerIdForPrune);
          this.ownedIcao.delete(oldId);
        }
      }
      entities.resumeEvents();
      this.props.ctx.viewer.scene.requestRender();
    }
  }

  private applyStyle(
    opts: Cesium.Entity.ConstructorOptions,
    props: Record<string, unknown>,
    polygon?: PolygonGeometry,
  ): void {
    // Polygon geometry path: only jamming uses this today.
    if (polygon && this.props.styleKind === 'jamming') {
      const { fillColor, outlineColor, alpha } = jammingPolygonStyle(props);
      const outerRing = polygon.coordinates[0] ?? [];
      // Flatten [lon, lat] pairs into the flat array Cesium.Cartesian3.fromDegreesArray expects.
      const flat = outerRing.flatMap(([pLon, pLat]) => [pLon, pLat]);
      opts.polygon = {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
        material: Cesium.Color.fromCssColorString(fillColor).withAlpha(alpha),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(outlineColor),
        height: 0,
        classificationType: Cesium.ClassificationType.TERRAIN,
      };
      return;
    }

    switch (this.props.styleKind) {
      case 'aircraft': {
        const s = aircraftStyle(props);
        // Hard invariant: aircraft NEVER render as a Cesium point. If the
        // style somehow produced an empty imageUri, the billboard would
        // silently fall back to nothing and Cesium would show its default
        // primitive (a tiny dot). aircraftStyle's branches all return a
        // cached data: URI today, but this guard makes the invariant
        // explicit and future-proof.
        if (!s.imageUri) {
          throw new Error('aircraftStyle returned empty imageUri — icon factory is broken');
        }
        opts.billboard = aircraftBillboard(s);
        // Explicitly do NOT set opts.point — see CLAUDE.md invariant.
        // Always show *something* — analysts complained that bare icons left
        // them guessing which dot was which. Fallback chain: human-readable
        // callsign → tail-number registration → ICAO 24-bit hex (uppercased).
        const labelText = aircraftLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'vessel': {
        const s = vesselStyle(props);
        if (!s.imageUri) {
          throw new Error('vesselStyle returned empty imageUri — icon factory is broken');
        }
        opts.billboard = vesselBillboard(s);
        // Digitraffic vessels arrive without a name field but with an MMSI —
        // surface "MMSI 231695000" so the icon is identifiable instead of
        // anonymous. Real names from AIS still take precedence.
        const labelText = vesselLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'fire': {
        const s = fireStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8_000_000),
        };
        break;
      }
      case 'quake': {
        const mag = (props['mag'] as number | null) ?? null;
        const { color, pixelSize } = quakeStyle(mag);
        opts.point = {
          color,
          pixelSize,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          translucencyByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 4.0e7, 0.35),
        };
        break;
      }
      case 'jamming': {
        // GPS jamming cell — translucent red point sized by aircraft count,
        // alpha by percent_bad. Severity tints the hue between warn and alert
        // so a quick visual scan reads "this cell is bad". 1° cells render
        // big enough that pixelSize alone is the right primitive — drawing
        // an ellipse() at world scale would just be a blob.
        const { color, pixelSize } = jammingStyle(props);
        opts.point = {
          color,
          pixelSize,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          translucencyByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 4.0e7, 0.35),
        };
        break;
      }
      case 'camera': {
        const s = cameraStyle();
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Cams are dense city furniture — only paint below ~4,000 km.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4_000_000),
        };
        const name = props['name'];
        if (typeof name === 'string' && name.length > 0) {
          opts.label = labelFor(name);
          opts.name = name;
        }
        break;
      }
      default:
        opts.point = { color: Cesium.Color.WHITE, pixelSize: 4 };
    }
  }

  private refreshStyle(e: Cesium.Entity, props: Record<string, unknown>): void {
    switch (this.props.styleKind) {
      case 'aircraft': {
        const s = aircraftStyle(props);
        // Invariant: never let an aircraft entity lose its billboard image.
        // If the style accidentally returned a falsy URI we keep the current
        // image rather than blanking it out (which would let Cesium fall
        // back to a default point).
        if (e.billboard && s.imageUri) {
          updateBillboardImage(e.billboard, s.imageUri);
          updateRotation(e.billboard, s.rotationRad);
          updateScale(e.billboard, s.scale);
        }
        // Late-arriving callsigns are common — the first hit from many feeds
        // is ICAO24 only, then the callsign fills in a few seconds later.
        // Keep the on-screen label in sync so the user sees the upgrade.
        const labelText = aircraftLabelText(props);
        if (labelText && e.label) {
          const current = currentValue<string>(e.label.text);
          if (current !== labelText) {
            e.label.text = new Cesium.ConstantProperty(labelText);
          }
          if (e.name !== labelText) e.name = labelText;
        }
        break;
      }
      case 'vessel': {
        const s = vesselStyle(props);
        if (e.billboard && s.imageUri) {
          updateBillboardImage(e.billboard, s.imageUri);
          updateRotation(e.billboard, s.rotationRad);
          updateScale(e.billboard, s.scale);
        }
        const labelText = vesselLabelText(props);
        if (labelText && e.label) {
          const current = currentValue<string>(e.label.text);
          if (current !== labelText) {
            e.label.text = new Cesium.ConstantProperty(labelText);
          }
          if (e.name !== labelText) e.name = labelText;
        }
        break;
      }
      case 'jamming': {
        if (e.polygon) {
          // Polygon (hexagon) entity — update fill material and outline colour.
          const { fillColor, outlineColor, alpha } = jammingPolygonStyle(props);
          e.polygon.material = new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(fillColor).withAlpha(alpha),
          );
          e.polygon.outlineColor = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString(outlineColor),
          );
        } else if (e.point) {
          // Fallback: legacy Point entities (should not appear once all cells
          // are emitted as Polygons, but kept for safety).
          const { color, pixelSize } = jammingStyle(props);
          e.point.color = new Cesium.ConstantProperty(color);
          e.point.pixelSize = new Cesium.ConstantProperty(pixelSize);
        }
        break;
      }
    }
  }
}

// Reassign billboard.image only when the new URI actually differs from the
// current one. Cesium treats a fresh ConstantProperty as "value changed" and
// re-decodes the data: URI from scratch every time — at 4 s polls that
// causes the icon to blank out for a frame, which the operator reports as
// "icons disappear and come back" / "icons revert to a blue dot".
function updateBillboardImage(
  bb: Cesium.BillboardGraphics,
  nextUri: string,
): void {
  const current = currentValue<string>(bb.image);
  if (current === nextUri) return;
  bb.image = new Cesium.ConstantProperty(nextUri);
}

function updateRotation(bb: Cesium.BillboardGraphics, nextRad: number): void {
  const current = currentValue<number>(bb.rotation);
  if (current != null && Math.abs(current - nextRad) < ROT_EPSILON) return;
  bb.rotation = new Cesium.ConstantProperty(nextRad);
}

function updateScale(bb: Cesium.BillboardGraphics, nextScale: number): void {
  const current = currentValue<number>(bb.scale);
  if (current != null && Math.abs(current - nextScale) < SCALE_EPSILON) return;
  bb.scale = new Cesium.ConstantProperty(nextScale);
}

// Map a jamming-cell feature to its (color, pixelSize). Severity gates the
// hue (warn → alert as the bad fraction climbs), aircraft count gates the
// radius (log scale so a 50-aircraft hot cell doesn't paint over the whole
// continent). Alpha tracks percent_bad so a 30% cell is visibly fainter
// than a 90% cell at the same population.
function jammingStyle(props: Record<string, unknown>): {
  color: Cesium.Color;
  pixelSize: number;
} {
  const total = Number(props['total'] ?? 1);
  const pct = Number(props['percent_bad'] ?? 0);
  const severity = (props['severity'] as string | undefined) ?? 'low';
  // Hue: low/medium = warn (#f59e0b), high = alert (#ef4444).
  const hex = severity === 'high' ? '#ef4444' : '#f59e0b';
  const base = Cesium.Color.fromCssColorString(hex);
  // Alpha from 0.35 (just visible) to 0.85 (saturated) as pct goes 0 → 100.
  const alpha = 0.35 + 0.5 * Math.min(1, Math.max(0, pct / 100));
  const color = base.withAlpha(alpha);
  // pixelSize: 8 px floor, +4 per ln(total). 3 ac → ~12 px, 25 ac → ~21 px,
  // 200 ac → ~29 px. Clamped at 36 so a megacluster doesn't take over.
  const pixelSize = Math.max(8, Math.min(36, 8 + 4 * Math.log(Math.max(1, total))));
  return { color, pixelSize };
}

function aircraftBillboard(
  s: ReturnType<typeof aircraftStyle>,
): Cesium.BillboardGraphics.ConstructorOptions {
  return {
    image: s.imageUri,
    scale: s.scale,
    rotation: s.rotationRad,
    alignedAxis: Cesium.Cartesian3.UNIT_Z,
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    heightReference: Cesium.HeightReference.NONE,
    // 40M m ceiling so the default boot camera (20M m altitude) still shows
    // aircraft icons. The previous 12M m cut-off meant analysts saw a blank
    // globe on first paint until they zoomed in.
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 40_000_000),
    // Scale with camera distance: ~1.7x base when close (≤10 km), ~0.5x when far
    // (≥5000 km), so icons grow as you zoom in and don't clutter at world scale.
    scaleByDistance: new Cesium.NearFarScalar(10_000, 1.7, 5_000_000, 0.5),
    ...(s.emergency && {
      color: new Cesium.CallbackProperty(
        () =>
          Cesium.Color.fromCssColorString('#ef4444').withAlpha(
            0.6 + 0.4 * Math.abs(Math.sin(Date.now() / 250)),
          ),
        false,
      ) as unknown as Cesium.Property,
    }),
  };
}

function vesselBillboard(
  s: ReturnType<typeof vesselStyle>,
): Cesium.BillboardGraphics.ConstructorOptions {
  // Individual vessel icons only paint when the camera is below ~600 km — at
  // world / continent scale the EntityCluster aggregate stands in for them so
  // the Baltic doesn't render as a single green blob. The NearFarScalar fades
  // alpha from 1.0 at 150 km down to 0 by 600 km so the handoff to the cluster
  // billboards is a soft cross-fade, not a pop.
  return {
    image: s.imageUri,
    scale: s.scale,
    rotation: s.rotationRad,
    alignedAxis: Cesium.Cartesian3.UNIT_Z,
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 600_000),
    translucencyByDistance: new Cesium.NearFarScalar(150_000, 1.0, 600_000, 0.0),
    // Grow as you zoom into a port (~1.7x ≤5 km) and shrink at range (~0.6x).
    scaleByDistance: new Cesium.NearFarScalar(5_000, 1.7, 400_000, 0.6),
  };
}

