import * as Cesium from 'cesium';
import type { LayerAdapter, AdapterCtx } from './types.js';
import {
  aircraftStyle,
  airportStyle,
  baseStyle,
  cameraStyle,
  facilityStyle,
  fireStyle,
  hazardPolygonStyle,
  hazardStyle,
  jammingPolygonStyle,
  portStyle,
  quakeStyle,
  tfrPolygonStyle,
  vesselStyle,
  warningStyle,
} from './styles.js';
import {
  labelFor,
  aircraftLabelText,
  airportLabelText,
  baseLabelText,
  facilityLabelText,
  portLabelText,
  tfrLabelText,
  vesselLabelText,
  warningLabelText,
} from './labelStyle.js';
import {
  resolveAircraftFamily,
  aircraftSilhouette,
  vesselSilhouette,
} from '../../entity-panel/silhouettes.js';
import { PrimitiveEntityLayer } from './PrimitiveEntityLayer.js';
import { ingestFix, projectAt, type DrFix, type DrState } from './deadReckon.js';
import { frameBudgetRemaining, recordFrameSpend } from '../frameBudget.js';
import { perfSetDrain } from '../perf.js';
import { isCameraMoving, cameraMovingForMs } from '../cameraMotion.js';
import { VesselClusterPrimitive } from './VesselClusterPrimitive.js';
import { tracks } from '../../intel/tracks.js';
import { aircraftDedup } from '../../intel/registry.js';
import { isMobileDevice } from '../../shell/device.js';
import { presetKnobs } from '../qualityPresets.js';
import { useSelection, useFilters } from '../../state/stores.js';
import { useSettings } from '../../state/settings.js';
import { entityPassesFilter } from '../../explorer/HistogramPanel.js';
import { apiFetch, withWsKey } from '../../transport/http.js';

// Alpha applied to a billboard the active map-side filter (useFilters /
// HistogramPanel) excludes. The icon stays DRAWN (same SVG image, same
// rotation/scale, still upserted by id — never removed, never swapped to a
// point) but fades to near-invisible so the matching contacts pop. 1.0 =
// full opacity for matching/unfiltered entities.
const FILTER_DIM_ALPHA = 0.1;

// Minimum delay the grid scheduler will book between polls. Not a cadence
// target — only a yield so a re-anchor after an overrun can't fire back-to-back
// polls and starve the main thread.
const GRID_MIN_GAP_MS = 100;

// Hard ceiling on a single poll's fetch. scheduleNext re-arms the loop ONLY in
// poll()'s .finally, and the previous request is aborted only at the START of
// the NEXT poll — so a fetch that never settles (dev proxy out of sockets,
// upstream stalled) leaves .finally unreached and the whole layer's poll loop
// dead until a camera move / tab refocus manually calls refresh(). This
// watchdog aborts a hung fetch so poll() always settles and the grid re-arms.
// 15s is far above the hot route p50 (~4ms) and bbox p99 (seconds).
const POLL_WATCHDOG_MS = 15_000;

// A WS push older than this (6× the 1s cadence) means the socket has gone quiet
// — the tab was backgrounded (browsers freeze rAF + throttle timers, so frames
// stop applying and reconnects stall) or the socket went zombie (onclose never
// fired). Past this the poll STOPS being suppressed and refetches over HTTP, so
// the map self-heals without a manual refresh. A healthy 1s socket never trips it.
const WS_STALE_MS = 6000;

// Per-frame upsert budget (ms). A payload of ~8-13k entities is applied in
// slices of at most this long so no single frame blocks — the cure for the
// periodic "stop" when a push lands. ~6ms leaves the rest of the 16ms frame for
// Cesium's own render of the interpolated billboards. A full world payload drains
// over ~12-22 frames (~200-370ms), comfortably inside the ~2s push interval.
const DRAIN_BUDGET_MS = 6;
// Floor a budgeted slice never drops below, so a frame already spent by another
// adapter can't stall this drain entirely — we always make a little progress.
const DRAIN_MIN_SLICE_MS = 2;

// First-payload budget: the very first world snapshot has nothing animating yet,
// so spend a bigger one-time slice to place all ~13k icons in ~3 frames instead
// of dribbling them in over ~30 (the "takes a while to load all the planes in"
// report). Subsequent live pushes revert to DRAIN_BUDGET_MS so a push never
// blocks a frame mid-animation.
const FIRST_DRAIN_BUDGET_MS = 50;

// Aircraft syncAll (steady poll) per-frame CEILING. The unchanged-skip keeps a
// normal poll's apply well under this (~4-6ms) so the whole payload still
// teleports in ONE frame — in sync, no ripple, the guardrail case preserved.
// A BULK change (a zoom bbox refetch, or a burst poll where thousands got fresh
// fixes at once) that would otherwise block the frame for ~640ms instead spills
// to the next frame via the reschedule at the drain tail — the map stays
// interactive and the newly-revealed icons ripple in over ~0.5s instead of a
// hard freeze. ~1.5 frames of headroom so normal polls never trip it.
const SYNC_ALL_CEILING_MS = 24;

// Aircraft world pushes apply in ONE frame (operator request 2026-06-27: "all in
// sync") instead of the time-sliced ripple, so every aircraft that moved this
// push teleports in the SAME render. To keep that single frame cheap we SKIP
// aircraft whose reported position is unchanged since last push (the bulk — only
// the feed slices that refreshed carry a new fix), so per-push work ∝ moved
// aircraft, not the whole ~13k union. Skip is suppressed while a map filter is
// active (a filter toggle must re-evaluate every icon's dim). Vessels are
// untouched — they glide via SampledPositionProperty and stay time-sliced.
const AIRCRAFT_POS_EPSILON_M = 8; // ≈ ADS-B position noise floor; below this = didn't move
// Same idea for the world-freeze vessel branch: an anchored/moored/re-reporting
// ship whose fix moved less than this didn't visibly move at world zoom, so its
// restyle (styleFn + billboard GPU write) can be skipped like the aircraft
// teleport path. 25 m covers AIS lat/lon quantisation + at-anchor swing; the
// freeze branch only runs above VESSEL_GLIDE_FREEZE_ALTITUDE_M where 25 m is
// sub-pixel, and glide+restyle resume on zoom-in so any held rotation corrects.
const VESSEL_FREEZE_POS_EPSILON_M = 25;

// ── FlightRadar24-style dead-reckoning (operator opt-in 2026-06-28) ──────────
// OFF by default; gated entirely on `useSettings().aircraftDeadReckon`. The
// default aircraft path TELEPORTS to each real fix and forbids extrapolation
// (CLAUDE.md). When the operator opts in, each REAL fix becomes a motion ANCHOR
// and the icon's position is a pure function of that anchor + the clock:
//
//     position(t) = advance(anchor, track_deg, velocity_ms * max(0, t - t0))
//
// The model lives in deadReckon.ts (pure + unit-tested); this file only supplies
// fixes and owns the Cesium property. Positions while ON are ESTIMATED, not
// observed — the PredictedMotionBadge says so.
//
// REWRITTEN 2026-07-14 against two operator requirements: the icon must move at
// the ACTUAL reported speed, and must NEVER go in reverse. Both are now
// structural (see deadReckon.ts), and the sampled-glide history below is exactly
// why — do not reintroduce any of it:
//   - Cut 1 re-created a 2-sample property anchored at a fake 90 s-projected
//     point every poll, so a resent fix snapped the icon BACK.
//   - Cut 2 derived velocity from consecutive noisy fixes → overshoot + snap-back.
//     (Measured 2026-07-14: only 13.5% of consecutive fix pairs give a speed
//     within ±10% of the reported velocity_ms. Never fit velocity from fixes.)
//   - Cut 3 dropped projection entirely (HOLD only) → contacts froze between
//     fixes: the "keep planes moving doesn't" report.
//   - Cut 4 (this rewrite's predecessor) EASED from the rendered position to the
//     new fix over the inter-fix gap, then projected past it. That glide's
//     apparent speed was dist/gap — arbitrary, NOT velocity_ms (requirement 1
//     broken) — and when a stale fix landed behind the icon it GLIDED backwards
//     over up to 30 s (requirement 2 broken). This is what the operator saw.
//
// The `drLastReal` gate in drain() stays load-bearing: only a fix whose reported
// position actually MOVED becomes a new anchor. The feed repeats the last
// position until a fresh one lands, and its seen_pos_s does not always grow with
// it, so re-anchoring on a resend would restart the projection from the old
// position — snapping the icon backwards.
//
// NOTE: the reverse the operator reported was ALSO being fed by the backend —
// the snapshot tier merge served fixes that regressed along track (measured 9.2%
// of airborne moves, median -3.8 km). Fixed in routes/adsb.py (_merge_raw_into
// freshest-wins + the _regresses guard). No frontend model can fix a feed that
// moves aircraft backwards; both halves are required.

// Camera altitude (m) above which vessel glide is FROZEN. WHY: vessels glide via
// SampledPositionProperty, which Cesium re-evaluates every frame the clock
// advances — and the DataSourceDisplay visualizer update is O(all entities), so
// ~10k+ gliding vessels re-dirty the whole scene every frame → measured 5-9 FPS
// at world view (GPU idle; the wall is JS). Above this altitude a vessel's
// between-fix glide offset projects to << 1px, so freezing it to a
// ConstantPositionProperty (snap to the real fix, like aircraft teleport) is
// visually identical but lets requestRenderMode quiet the scene between polls.
// Operator-approved 2026-06-28: "quick stopgap, but when zoom out it must
// immediately snap into POS without user seeing" — hence the moveEnd reconcile.
// Below this altitude vessels glide normally (few on screen → cheap).
const VESSEL_GLIDE_FREEZE_ALTITUDE_M = 2_000_000; // 2,000 km
// Hysteresis band below the freeze altitude. Once vessels are frozen (world view)
// they stay frozen until the camera drops clearly below the threshold, so a pan
// that grazes the boundary doesn't thrash ~6k SampledPositionProperty re-evals.
const VESSEL_FREEZE_HYSTERESIS_M = 250_000; // 250 km

// World-view render cap for vessels comes from the map-quality preset
// (globe/qualityPresets.ts: vesselCap — 6000 high / 4000 balanced / 2000
// performance). The keyless feed returns ~21k vessels; at world view they
// collapse into cluster bubbles anyway, so a deterministic stable subset (djb2-
// keyed — same ships persist across polls, no churn) keeps the per-poll O(n)
// apply + render bounded. Lifts when zoomed in past the freeze altitude. No
// operator minimum exists for vessels (unlike the ≥8000 aircraft invariant), so
// this is safe to cap.


// Initial great-circle bearing (deg, 0=N) from point 1 to point 2. Used as a
// heading fallback so an icon whose feed omits track/cog still points the way
// it's actually moving instead of freezing pointing north.
// §5.3.1: refresh a Cesium PropertyBag's values IN PLACE (no allocation). Cesium
// stores each raw JSON value behind a getter/setter — assigning `bag[key] = v`
// swaps the backing field and raises definitionChanged, so getValue()/facets/
// EntityPanel stay live. Exported so the freshness invariant the 2026-06-30
// guardrail depends on can be unit-tested (propertyBagRefresh.test.ts).
export function refreshBagInPlace(bag: Cesium.PropertyBag, props: Record<string, unknown>): void {
  const raw = bag as unknown as Record<string, unknown>;
  for (const key in props) {
    if (bag.hasProperty(key)) raw[key] = props[key];
    else bag.addProperty(key, props[key]);
  }
}

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

export type StyleKind =
  | 'quake'
  | 'aircraft'
  | 'fire'
  | 'vessel'
  | 'jamming'
  | 'camera'
  | 'airport'
  | 'port'
  | 'tfr'
  | 'base'
  | 'warning'
  | 'facility'
  | 'hazard'
  | 'hazardpoly'
  | 'generic';

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
// CLAUDE.md world-view decimation lesson). Sanctioned mobile cap = 2000.
const MOBILE_LAYER_CAP = isMobileDevice() ? 2000 : Number.POSITIVE_INFINITY;

// Effective per-layer render cap = the sanctioned mobile cap AND the map-quality
// preset's non-aircraft layer cap (Infinity except under 'performance', where a
// weak DESKTOP GPU also gets the stable-subset decimation). AIRCRAFT stay exempt
// on desktop — the operator invariant requires the desktop world view to carry
// ≥ 8000 aircraft; only the separately-sanctioned mobile cap touches them. A
// desktop that still can't cope is what the low-end 2D suggestion is for.
// Reference kinds (billboard + Cesium Label each) are capped on EVERY preset:
// labels are per-glyph GPU textures, and ten facility layers over a dense
// metro without a ceiling was a VRAM OOM (context loss / tab death), not a
// slowdown. 1500/layer stays far above what a metro view usefully shows;
// decimation past the cap is the sanctioned stableSubset.
const REFERENCE_LAYER_CAP = 1500;
const REFERENCE_KINDS: ReadonlySet<string> = new Set(['facility', 'airport', 'port', 'base']);

function effectiveLayerCap(styleKind: string): number {
  const presetLayer =
    styleKind === 'aircraft' && !isMobileDevice()
      ? Number.POSITIVE_INFINITY
      : presetKnobs(useSettings.getState().mapQuality).layerCap;
  const reference = REFERENCE_KINDS.has(styleKind)
    ? REFERENCE_LAYER_CAP
    : Number.POSITIVE_INFINITY;
  return Math.min(MOBILE_LAYER_CAP, presetLayer, reference);
}

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
  // Aircraft + vessels: renders the icons+labels as batched primitives off the
  // (graphics-less) entities, killing the per-frame billboard/label visualizer
  // walk that was the world-view drag-lag. null for jamming/etc. — those keep
  // their per-entity Cesium graphics. One adapter instance is a single styleKind,
  // so this serves whichever (aircraft or vessel) needs it.
  private primRenderer: PrimitiveEntityLayer | null = null;
  // Vessels only: world-view count bubbles (replaces Cesium EntityCluster, which
  // needed the entity billboards that are now graphics-less).
  private vesselCluster: VesselClusterPrimitive | null = null;
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
  // §5.3.2: last wall-clock ms we pushed a track point per id, for the 30 s
  // heartbeat that keeps a parked contact's ring alive without pushing all ~13k
  // contacts every poll.
  private lastTrackPushMs = new Map<string, number>();
  // Dead-reckon only: last REAL fix position per id (Cartesian). Used to detect
  // a resent/stale fix (same position) so we DON'T re-anchor on it. This gate is
  // load-bearing: the feed repeats the last position until a fresh one lands, and
  // its `seen_pos_s` does NOT always grow with it. Re-anchoring on a resend would
  // restart the projection from the OLD position — i.e. snap the icon backwards.
  private drLastReal = new Map<string, Cesium.Cartesian3>();
  // Dead-reckon only: per-contact motion anchor (see deadReckon.ts). The icon's
  // position is a pure function of this + the clock, so it always moves at the
  // reported ground speed along the reported track, and never backwards.
  private drState = new Map<string, DrState>();
  // Dead-reckon only: the CallbackPositionProperty per id. Kept so a new fix
  // mutates the anchor a live property already reads, rather than swapping the
  // property (which would re-dirty the entity every poll).
  private drProp = new Map<string, Cesium.CallbackPositionProperty>();
  // Fixed origin for sim-clock→seconds. JulianDate.secondsDifference against a
  // stable epoch keeps the motion model in plain seconds; the epoch cancels out.
  private drEpoch: Cesium.JulianDate | null = null;

  /** Sim-clock JulianDate → seconds since this adapter's epoch. */
  private drSecs(t: Cesium.JulianDate): number {
    if (!this.drEpoch) this.drEpoch = t.clone();
    return Cesium.JulianDate.secondsDifference(t, this.drEpoch);
  }

  // FR24-style dead-reckoning: hand the fix to the motion model (deadReckon.ts)
  // and let the icon's position be a pure function of the anchor + the clock.
  //
  // The property is a CallbackPositionProperty rather than a SampledPosition-
  // Property because the motion is ANALYTIC, not sampled: there is nothing to
  // interpolate between. That is what makes the two operator requirements
  // structural rather than tuned — the icon moves at exactly `velocity_ms` along
  // exactly `track_deg`, and cannot move backwards. The old sampled glide eased
  // from the current render position TO the new fix over the inter-fix gap, so its
  // apparent speed was dist/gap (arbitrary, unrelated to velocity_ms) and a stale
  // fix landing behind the icon was GLIDED to — the reported reverse.
  private deadReckonPosition(
    id: string,
    t: Cesium.JulianDate,
    fix: DrFix,
  ): Cesium.CallbackPositionProperty {
    this.drState.set(id, ingestFix(this.drState.get(id), fix, this.drSecs(t)));
    let prop = this.drProp.get(id);
    if (!prop) {
      // isConstant=false: Cesium must re-evaluate every frame the clock advances.
      prop = new Cesium.CallbackPositionProperty((time, result) => {
        const s = this.drState.get(id);
        if (!s || !time) return undefined;
        const p = projectAt(s, this.drSecs(time));
        return Cesium.Cartesian3.fromRadians(p.lonRad, p.latRad, s.altM, undefined, result);
      }, false) as Cesium.CallbackPositionProperty;
      this.drProp.set(id, prop);
    }
    return prop;
  }

  /** Build a motion-model fix from a feed feature's property bag. */
  private drFixFrom(props: Record<string, unknown>, lon: number, lat: number, alt: number): DrFix {
    // Position age = now - (seen_at - seen_pos_s). seen_at is when the BACKEND
    // received the body; seen_pos_s is how old the position already was inside
    // it. Same derivation the track-trail push uses.
    const seenAt = props['seen_at'];
    const seenPos = props['seen_pos_s'];
    const obsSec =
      typeof seenAt === 'number' ? seenAt - (typeof seenPos === 'number' ? seenPos : 0) : null;
    return {
      lonDeg: lon,
      latDeg: lat,
      altM: alt,
      trackDeg: typeof props['track_deg'] === 'number' ? props['track_deg'] : null,
      speedMs: typeof props['velocity_ms'] === 'number' ? props['velocity_ms'] : null,
      ageS: obsSec != null ? Math.max(0, Date.now() / 1000 - obsSec) : 0,
      onGround: props['on_ground'] === true,
    };
  }

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
  private lastWsMs = 0; // §5.6.3: wall-clock of the last applied WS frame
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
  // Last vessel glide-freeze state (camera above/below the freeze altitude). Only
  // a threshold CROSSING does work in reconcileGlideForZoom.
  private lastFreezeState: boolean | null = null;
  // Hysteretic mirror of the freeze state used by the drain's per-vessel branch
  // (distinct from lastFreezeState, which reconcileGlideForZoom uses as a raw
  // threshold-crossing detector).
  private vesselFreezeHyst = false;
  private detachZoom: (() => void) | null = null;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  // Detach handle for the camera moveEnd listener (viewport layers only).
  private detachMove: (() => void) | null = null;

  // Detach handle for the tab-visibility listener (forces a refetch + socket
  // rebuild when the tab returns to the foreground after a background freeze).
  private detachVis: (() => void) | null = null;

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    // The await above yields — the viewer can be torn down before we resume
    // (HMR / rapid layer toggle). Bail if so; accessing viewer.camera on a
    // destroyed viewer throws "Cannot read properties of undefined".
    if (this.detached || viewer.isDestroyed()) return;
    // Aircraft render as batched primitives (see PrimitiveEntityLayer). The
    // entities still hold position/name/props for watchbox/histogram/selection;
    // only the pixels move to the collection. Dead-reckon + clock read live.
    if (this.props.styleKind === 'aircraft') {
      this.primRenderer = new PrimitiveEntityLayer(viewer.scene, {
        styleFn: (props) => {
          const s = aircraftStyle(props);
          // No color → white tint (the SVG already carries the category colour;
          // dim/pulse own the alpha). emergency drives the red pulse.
          return { imageUri: s.imageUri, scale: s.scale, rotationRad: s.rotationRad, emergency: s.emergency };
        },
        // Tilt the camera toward the horizon → swap to the airframe side profile,
        // tinted the SAME category colour as the top-down icon (yellow airliner,
        // orange military …) so the side view stays as readable as the top view.
        sideStyleFn: (props) => {
          const fam = resolveAircraftFamily(
            (typeof props['type'] === 'string' ? props['type'] : null) ??
              (typeof props['icao_type'] === 'string' ? props['icao_type'] : null),
            typeof props['category'] === 'string' ? props['category'] : null,
          );
          const hex = aircraftStyle(props).color.toCssHexString().slice(0, 7);
          return { imageUri: aircraftSilhouette(fam ?? 'narrowbody', hex), scale: 0.62 };
        },
        labelFn: aircraftLabelText,
        billboardBase: () => ({
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.NONE,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 40_000_000),
          scaleByDistance: new Cesium.NearFarScalar(10_000, 1.7, 5_000_000, 0.5),
        }),
        labelBase: (text) => labelFor(text) as unknown as Cesium.Label.ConstructorOptions,
        getClock: () => viewer.clock.currentTime,
        shouldAnimate: () => useSettings.getState().aircraftDeadReckon,
        pulse: true,
        filter: true,
      });
    } else if (this.props.styleKind === 'vessel') {
      this.primRenderer = new PrimitiveEntityLayer(viewer.scene, {
        styleFn: (props) => {
          const s = vesselStyle(props);
          // No color → white tint (the SVG carries the category / dark-vessel red).
          return { imageUri: s.imageUri, scale: s.scale, rotationRad: s.rotationRad };
        },
        // Tilt the camera toward the horizon → swap to the hull side profile,
        // tinted the vessel's category colour (cargo teal, tanker amber …).
        sideStyleFn: (props) => {
          const hex = vesselStyle(props).color.toCssHexString().slice(0, 7);
          return { imageUri: vesselSilhouette(hex), scale: 0.62 };
        },
        labelFn: vesselLabelText,
        billboardBase: () => ({
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Same fade as the old vesselBillboard: individual icons live 0→600 km
          // (culled above), translucency 150→600 km — the world-view handoff to
          // the count bubbles (VesselClusterPrimitive).
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 600_000),
          translucencyByDistance: new Cesium.NearFarScalar(150_000, 1.0, 600_000, 0.0),
          scaleByDistance: new Cesium.NearFarScalar(5_000, 1.7, 400_000, 0.6),
        }),
        labelBase: (text) => labelFor(text) as unknown as Cesium.Label.ConstructorOptions,
        getClock: () => viewer.clock.currentTime,
        // Vessels glide below the freeze altitude → mirror each frame; above it
        // they teleport-freeze (constant position) so the mirror idles.
        shouldAnimate: () =>
          viewer.camera.positionCartographic.height <= VESSEL_GLIDE_FREEZE_ALTITUDE_M,
        pulse: false,
        filter: true,
      });
      this.vesselCluster = new VesselClusterPrimitive(viewer, () => {
        const t = viewer.clock.currentTime;
        const out: Array<{ lon: number; lat: number }> = [];
        for (const e of this.ds.entities.values) {
          const p = e.position?.getValue(t) as Cesium.Cartesian3 | undefined;
          if (!p) continue;
          const c = Cesium.Cartographic.fromCartesian(p);
          out.push({ lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) });
        }
        return out;
      });
    }
    if (this.props.refreshOnMove) {
      // Debounce so a multi-step zoom/pan coalesces into one re-poll of the
      // new viewport (not one per intermediate camera event).
      let t: number | null = null;
      const onMove = (): void => {
        if (t != null) window.clearTimeout(t);
        t = window.setTimeout(() => {
          // §5.6.3: skip the moveEnd re-poll when the WS push owns this view and a
          // frame landed <1 s ago — it's already fresher than an HTTP poll. Zoomed-in
          // (bbox) views still poll: WS is suppressed there and the bbox just changed.
          if (this.wsActive && this.isWorldView() && Date.now() - this.lastWsMs < 1000) return;
          this.refresh();
        }, 200);
      };
      viewer.camera.moveEnd.addEventListener(onMove);
      this.detachMove = () => {
        if (t != null) window.clearTimeout(t);
        if (!viewer.isDestroyed()) viewer.camera.moveEnd.removeEventListener(onMove);
      };
    }
    // Vessel layers: on camera moveEnd, if we just crossed ABOVE the glide-freeze
    // altitude, snap every still-gliding vessel to its current position NOW (don't
    // wait for the next poll) so the per-frame SampledPosition re-eval — the
    // world-view lag — stops the instant the user finishes zooming out. The snap
    // is sub-pixel at this altitude, so the operator never sees a jump.
    if (this.props.styleKind === 'vessel') {
      const onZoom = (): void => this.reconcileGlideForZoom();
      viewer.camera.moveEnd.addEventListener(onZoom);
      this.detachZoom = () => {
        if (!viewer.isDestroyed()) viewer.camera.moveEnd.removeEventListener(onZoom);
      };
    }
    // Tab refocus: a backgrounded tab freezes rAF (drain never paints) and
    // throttles the poll/reconnect timers, and the WS can go zombie with wsActive
    // still true. On return to the foreground, force an immediate refetch and, if
    // the socket has gone quiet, tear it down so onclose → reconnect fires — the
    // map catches up in one tick instead of needing a manual page refresh.
    const onVisible = (): void => {
      if (document.hidden) return;
      if (this.wsActive && Date.now() - this.lastWsMs >= WS_STALE_MS) {
        try {
          this.wsConn?.close();
        } catch {
          /* already closing; onclose will reconnect */
        }
      }
      this.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.detachVis = () => document.removeEventListener('visibilitychange', onVisible);
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

  // Layer-opacity slider hook for aircraft. The compositor dims most layers by
  // walking ds.entities and setting billboard alpha, but aircraft icons live in
  // a primitive collection the entity walk can't reach — so the compositor calls
  // this. No-op (null renderer) for every other styleKind.
  setLayerOpacity(opacity: number): void {
    this.primRenderer?.setLayerOpacity(opacity);
  }

  detach(): void {
    this.detached = true;
    this.detachMove?.();
    this.detachMove = null;
    this.detachZoom?.();
    this.detachZoom = null;
    this.detachVis?.();
    this.detachVis = null;
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
    this.lastTrackPushMs.clear();
    this.drLastReal.clear();
    this.drState.clear();
    this.drProp.clear();
    this.primRenderer?.destroy();
    this.primRenderer = null;
    this.vesselCluster?.destroy();
    this.vesselCluster = null;
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
    if (this.detached || this.props.ctx.viewer.isDestroyed()) return;
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
    // Viewer destroyed out from under a pending timer (teardown race): every
    // camera/scene/clock access below throws "_cesiumWidget is undefined".
    // Bail; scheduleNext stops the loop too.
    if (this.detached || this.props.ctx.viewer.isDestroyed()) return;
    // While the WS push is healthy AND we're at world view, the pushed blob
    // already carries this data — skip the redundant fetch + render. When zoomed
    // in the push (world-view subset) is insufficient, so the bbox poll runs even
    // with the socket open. Freshness guard: if the socket has gone quiet for
    // WS_STALE_MS (backgrounded/zombie), stop suppressing and let the poll refetch
    // so the map recovers without a manual refresh.
    if (this.wsActive && this.isWorldView() && Date.now() - this.lastWsMs < WS_STALE_MS) {
      this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
      return;
    }
    this.aborter?.abort();
    this.aborter = new AbortController();
    const ac = this.aborter; // local capture: a stale watchdog must not abort a newer controller
    const watchdog = window.setTimeout(() => ac.abort(), POLL_WATCHDOG_MS);
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
    } finally {
      clearTimeout(watchdog);
    }
  }

  // World view = the query the WS push serves (no bbox; just `limit=…`). A
  // zoomed/bbox query carries `lamin=`, so the push is suppressed and the bbox
  // poll owns the entities. No coupling to the literal world cap value.
  private isWorldView(): boolean {
    const q = this.props.bboxQuery?.();
    return !q || !q.includes('lamin');
  }

  // On a zoom-out crossing ABOVE VESSEL_GLIDE_FREEZE_ALTITUDE_M, convert every
  // gliding vessel (SampledPositionProperty) to a ConstantPositionProperty at its
  // current value so the scene stops re-evaluating thousands of glide curves every
  // frame (the world-view lag). Cheap + idempotent — only fires on a threshold
  // crossing. Zoom IN does nothing here: the next poll's glide branch re-seeds
  // SampledPositionProperty below the altitude.
  private reconcileGlideForZoom(): void {
    if (this.props.styleKind !== 'vessel' || this.detached) return;
    const frozen =
      this.props.ctx.viewer.camera.positionCartographic.height > VESSEL_GLIDE_FREEZE_ALTITUDE_M;
    if (frozen === this.lastFreezeState) return;
    this.lastFreezeState = frozen;
    if (!frozen) return; // zoom IN: glide resumes on the next poll
    const t = this.props.ctx.viewer.clock.currentTime;
    const ents = this.ds.entities;
    ents.suspendEvents();
    for (const e of ents.values) {
      if (e.position instanceof Cesium.SampledPositionProperty) {
        const v = e.position.getValue(t);
        if (v) e.position = new Cesium.ConstantPositionProperty(v);
      }
    }
    ents.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();
  }

  // Open the server-push socket and route inflated frames into the SAME render()
  // path as the poll, so the icon/label/glide guardrails keep a single owner.
  private connectWs(): void {
    if (this.detached || !this.props.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(withWsKey(this.props.ws));
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
      this.lastWsMs = Date.now();
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
    // Bound the world-view vessel set (they cluster at this zoom anyway). djb2-
    // keyed stableSubset → the same ships persist across polls, so the upsert-by-id
    // never churns. Lifts when zoomed in past the freeze altitude.
    let cap = effectiveLayerCap(this.props.styleKind);
    if (
      this.props.styleKind === 'vessel' &&
      this.props.ctx.viewer.camera.positionCartographic.height > VESSEL_GLIDE_FREEZE_ALTITUDE_M
    ) {
      cap = Math.min(cap, presetKnobs(useSettings.getState().mapQuality).vesselCap);
    }
    const capped = incoming.length > cap ? stableSubset(incoming, cap) : incoming;
    this.pendingFeats = capped.slice(0, MAX_PER_LAYER);
    this.pendingIds = new Set<string>();
    this.pendingIdx = 0;
    if (this.drainHandle == null) {
      this.drainHandle = window.requestAnimationFrame((ts) => this.drain(ts));
    }
  }

  private drain(ts = performance.now()): void {
    this.drainHandle = null;
    if (this.detached) return;
    // §5.2.1 defer the heavy aircraft syncAll while the operator is actively
    // dragging/zooming — the 13k-contact single-frame teleport is THE mid-pan
    // long task. render() keeps replacing pendingFeats (latest-wins), so waiting
    // for the camera to settle loses nothing. Escape hatch: apply anyway once a
    // continuous drag exceeds 2.5 s so a long slow pan still refreshes. Aircraft
    // only (vessels are already budget-sliced); guarded to the START of a drain
    // (pendingIdx 0) so we never stall a slice mid-flight.
    if (
      this.props.styleKind === 'aircraft' &&
      !this.firstDrain &&
      this.pendingIdx === 0 &&
      isCameraMoving() &&
      cameraMovingForMs() < 2500
    ) {
      this.drainHandle = window.requestAnimationFrame((t) => this.drain(t));
      return;
    }
    const entities = this.ds.entities;
    const feats = this.pendingFeats;
    const nextIds = this.pendingIds;
    // Aircraft (after the first load) apply the WHOLE payload this frame so every
    // moved icon teleports in sync — not in a ~300ms ripple. The unchanged-skip
    // below keeps that one frame cheap. Vessels + the first load stay budget-sliced.
    const syncAll = this.props.styleKind === 'aircraft' && !this.firstDrain;
    // FR24-style dead-reckoning opt-in (off by default). Read once per drain so
    // a mid-flight toggle takes effect on the next poll. Aircraft only.
    const deadReckon =
      this.props.styleKind === 'aircraft' && useSettings.getState().aircraftDeadReckon;
    // World-view vessels TELEPORT (snap to each real fix) instead of gliding, so
    // the per-frame SampledPositionProperty re-eval that pinned world view to
    // ~9 FPS stops. Hysteresis around the altitude threshold (frozen until the
    // camera drops clearly below it) keeps a pan that grazes the boundary from
    // flip-flopping ~6k vessels between teleport and glide every poll.
    let vesselFreeze = false;
    if (this.props.styleKind === 'vessel') {
      const h = this.props.ctx.viewer.camera.positionCartographic.height;
      if (this.vesselFreezeHyst) {
        if (h < VESSEL_GLIDE_FREEZE_ALTITUDE_M - VESSEL_FREEZE_HYSTERESIS_M) this.vesselFreezeHyst = false;
      } else if (h > VESSEL_GLIDE_FREEZE_ALTITUDE_M) {
        this.vesselFreezeHyst = true;
      }
      vesselFreeze = this.vesselFreezeHyst;
    }
    // Per-frame slice. First load + aircraft sync-all are EXEMPT from the shared
    // cooperative budget: first paint must place ~13k icons fast, and aircraft
    // teleport in a single frame by design (operator guardrail). Steady-state
    // vessel/other slices shrink to what's left of this frame's budget so two
    // adapters draining in the same frame don't overrun it (the pan stutter).
    const startMs = performance.now();
    let budgetMs = this.firstDrain ? FIRST_DRAIN_BUDGET_MS : DRAIN_BUDGET_MS;
    if (syncAll) {
      // Generous ceiling, not unbounded: a normal poll finishes under it in one
      // frame (guardrail-preserved), a bulk change spills to the next frame
      // instead of freezing (see SYNC_ALL_CEILING_MS).
      budgetMs = SYNC_ALL_CEILING_MS;
    } else if (!this.firstDrain) {
      budgetMs = Math.min(budgetMs, Math.max(DRAIN_MIN_SLICE_MS, frameBudgetRemaining(ts)));
    }
    const deadline = startMs + budgetMs;
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
          this.refreshBag(existing, props);
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
            this.primRenderer?.remove(id);
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
      // Did this contact actually move since the last poll? Computed once here
      // (reading lastPos BEFORE the set below) and reused by both the heading
      // fallback and the §5.3.2 track-push gate. ~1e-4° ≈ 10 m.
      let movedTrk = true;
      if (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') {
        const hdgKey = this.props.styleKind === 'aircraft' ? 'track_deg' : 'cog';
        const prev = this.lastPos.get(id);
        movedTrk = !prev || Math.abs(prev[0] - lon) > 1e-4 || Math.abs(prev[1] - lat) > 1e-4;
        if (typeof props[hdgKey] !== 'number' && prev) {
          const [plon, plat] = prev;
          if (Math.abs(plon - lon) > 1e-6 || Math.abs(plat - lat) > 1e-6) {
            props[hdgKey] = bearingDeg(plon, plat, lon, lat);
          }
        }
        this.lastPos.set(id, [lon, lat]);
      }

      // Feed track ring for the entity-panel sparkline.
      // §5.3.2: skip the push CALL (tp alloc + map ops) for a non-selected,
      // unmoved contact — but keep a 30 s heartbeat so a parked contact still
      // lands occasional history. The SELECTED entity always pushes (force=true),
      // so the ≥2-points-in-~5-8s selection-polyline guarantee is untouched.
      const trackSelected = useSelection.getState().selectedEntityId === id;
      const trackHeartbeat = Date.now() - (this.lastTrackPushMs.get(id) ?? 0) > 30_000;
      if (
        (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') &&
        (trackSelected || movedTrk || trackHeartbeat)
      ) {
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
        tracks.push(id, tp, { force: trackSelected });
        this.lastTrackPushMs.set(id, Date.now());
      }

      const existing = entities.getById(id);
      const newPos = Cesium.Cartesian3.fromDegrees(lon, lat, alt ?? 0);
      const isTrackable = this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel';
      if (existing) {
        if (this.props.styleKind === 'aircraft') {
          if (deadReckon) {
            // Dead-reckon: add a sample ONLY for a genuinely fresh fix (moved
            // ≥ epsilon vs the last REAL fix). A resend (the feed repeats the
            // last position until a new one lands) is left alone so the
            // persistent property keeps extrapolating forward — re-adding it
            // would zero the velocity and snap the icon back (the reverse bug).
            const lastReal = this.drLastReal.get(id);
            const fresh =
              !lastReal || Cesium.Cartesian3.distance(lastReal, newPos) >= AIRCRAFT_POS_EPSILON_M;
            if (!fresh) {
              // No new position — let the dead-reckon glide keep extrapolating, but
              // STILL refresh the property bag so freshness counters (seen_pos_s/
              // seen_at/last_contact) stay LIVE for the entity panel + histogram.
              // (Skipping the bag here froze "Last seen" for any contact that
              // resends the same position.) Skip only the restyle — the icon is
              // glide-owned; filter re-dim is handled by reapplyDim.
              this.refreshBag(existing, props);
              continue;
            } else {
              existing.position = this.deadReckonPosition(
                id,
                this.props.ctx.viewer.clock.currentTime,
                this.drFixFrom(props, lon, lat, alt ?? 0),
              );
              this.drLastReal.set(id, newPos.clone());
            }
          } else {
            // TELEPORT mode (operator request 2026-06-21, overriding the prior
            // glide guardrail): snap the aircraft straight to each new REAL fix —
            // no interpolation — so the icon shows the latest reported position
            // instantly, like a raw ADS-B map.
            const prev = currentValue<Cesium.Cartesian3>(existing.position);
            if (prev && Cesium.Cartesian3.distance(prev, newPos) < AIRCRAFT_POS_EPSILON_M) {
              // Position unchanged (cached/slow/parked contact). STILL refresh the
              // property bag so freshness counters (seen_pos_s/seen_at/last_contact)
              // and facet fields stay LIVE for the entity panel, histogram and
              // watchbox — the backend keeps aging these even when the lat/lon is
              // identical. Only skip the EXPENSIVE restyle (styleFn + dim recompute
              // + billboard GPU write), which is what A4 actually optimises; the icon
              // didn't move so its pixels don't need touching. (Skipping the bag too
              // was the "aircraft last-seen never updates" regression.) Filter re-dim
              // is still handled once-per-toggle by PrimitiveEntityLayer.reapplyDim.
              this.refreshBag(existing, props);
              continue;
            }
            existing.position = new Cesium.ConstantPositionProperty(newPos);
          }
        } else if (vesselFreeze) {
          // World-view vessel TELEPORT: snap straight to the real fix, no glide —
          // same model as the aircraft teleport above. This is what stops the
          // every-frame SampledPositionProperty re-eval that pinned world view to
          // ~9 FPS. Still real-data-only (no synthesis). Glide resumes when the
          // camera drops below VESSEL_GLIDE_FREEZE_ALTITUDE_M (the next poll, or
          // immediately via reconcileGlideForZoom on zoom-out).
          const prev = currentValue<Cesium.Cartesian3>(existing.position);
          if (prev && Cesium.Cartesian3.distance(prev, newPos) < VESSEL_FREEZE_POS_EPSILON_M) {
            // Position unchanged (anchored/moored/re-reporting vessel). Mirror the
            // aircraft teleport skip: STILL refresh the property bag so freshness
            // counters + facet fields stay LIVE, but skip the EXPENSIVE restyle
            // (styleFn + dim recompute + billboard GPU write) — the icon didn't
            // move at world zoom so its pixels don't need touching. Held rotation
            // is sub-pixel here and corrects on zoom-in when glide+restyle resume.
            this.refreshBag(existing, props);
            continue;
          }
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
        this.refreshBag(existing, props);
        this.refreshStyle(existing, props);
      } else {
        const opts: Cesium.Entity.ConstructorOptions = {
          id,
          position: deadReckon
            ? this.deadReckonPosition(
                id,
                this.props.ctx.viewer.clock.currentTime,
                this.drFixFrom(props, lon, lat, alt ?? 0),
              )
            : newPos,
          properties: props,
        };
        if (deadReckon) this.drLastReal.set(id, newPos.clone());
        this.applyStyle(opts, props);
        // TELEPORT mode: the entity is created at newPos (a ConstantPosition-
        // Property), already snapped to the latest real fix — no glide seed
        // needed. With dead-reckon ON it starts on a single-sample property that
        // begins gliding once the 2nd real fix arrives.
        const added = entities.add(opts);
        // Aircraft/vessel pixels live in the primitive collection — paint the
        // icon+label for the freshly-created (graphics-less) entity.
        if (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') {
          this.primRenderer?.sync(added, props);
        }
      }
    }
    // Charge this drain's main-thread time against the frame's shared budget so a
    // sibling adapter draining in the same frame yields. First load is exempt.
    if (!this.firstDrain) recordFrameSpend(ts, performance.now() - startMs);
    entities.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();

    if (this.pendingIdx < feats.length) {
      // More of this payload to apply — yield, continue next frame.
      this.drainHandle = window.requestAnimationFrame((ts) => this.drain(ts));
      return;
    }
    // First full payload is placed — drop to the small per-frame budget so
    // subsequent live pushes never block a frame mid-animation.
    this.firstDrain = false;
    // Perf instrument (§5.7): a steady poll finishes under SYNC_ALL_CEILING_MS so
    // this is the whole push-application (drain) cost. A bulk change that spilled
    // across frames reports only the FINAL slice here — the earlier slices already
    // painted, which is the point (no single blocking frame).
    if (this.props.styleKind === 'aircraft') perfSetDrain(performance.now() - startMs);

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
        this.primRenderer?.remove(oldId);
        this.lastAnchorLL.delete(oldId);
        this.lastPos.delete(oldId);
        this.lastTrackPushMs.delete(oldId);
        this.drLastReal.delete(oldId);
        this.drState.delete(oldId);
        this.drProp.delete(oldId);
        const icao = this.ownedIcao.get(oldId);
        if (icao) {
          aircraftDedup.release(icao, layerIdForPrune);
          this.ownedIcao.delete(oldId);
        }
      }
      entities.resumeEvents();
      this.props.ctx.viewer.scene.requestRender();
    }
    // Re-bin the world-view count bubbles now positions for this payload are in
    // (no-op unless this is the vessel layer + camera is zoomed out).
    this.vesselCluster?.refresh();
  }

  private applyStyle(
    opts: Cesium.Entity.ConstructorOptions,
    props: Record<string, unknown>,
    polygon?: PolygonGeometry,
  ): void {
    // Polygon geometry path: jamming cells + TFR airspace restrictions.
    if (
      polygon &&
      (this.props.styleKind === 'jamming' ||
        this.props.styleKind === 'tfr' ||
        this.props.styleKind === 'hazardpoly')
    ) {
      const { fillColor, outlineColor, alpha } =
        this.props.styleKind === 'tfr'
          ? tfrPolygonStyle(props)
          : this.props.styleKind === 'hazardpoly'
            ? hazardPolygonStyle(props)
            : jammingPolygonStyle(props);
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
      // TFR polygons carry a small facility/notam_id label (jamming cells stay
      // unlabeled — hundreds of overlapping hexagons would be unreadable text
      // soup). `kind: 'tfr'` already rides along in `properties: props` above
      // (the backend stamps it), so the entity stays clickable/identifiable in
      // the EntityPanel exactly like every other layer.
      if (this.props.styleKind === 'tfr') {
        const labelText = tfrLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
      } else if (this.props.styleKind === 'hazardpoly') {
        const labelText =
          (props['name'] as string | undefined) ?? (props['hazard'] as string | undefined);
        if (labelText) opts.name = labelText;
      }
      return;
    }

    switch (this.props.styleKind) {
      case 'aircraft': {
        // Aircraft entities are intentionally GRAPHICS-LESS: the SVG icon + the
        // callsign label are painted by PrimitiveEntityLayer (batched
        // BillboardCollection/LabelCollection), called from the point path right
        // after this entity is added. We keep ONLY position + name + properties
        // on the entity so watchbox/histogram/counts/selection still read it.
        // name = the human-readable label so the watchbox evaluator (which reads
        // e.name) still identifies the contact. Icon guardrail is enforced in the
        // renderer (aircraftStyle always returns a cached SVG data URI).
        const labelText = aircraftLabelText(props);
        if (labelText) opts.name = labelText;
        break;
      }
      case 'vessel': {
        // Graphics-less, like aircraft: the SVG icon + name label are painted by
        // the batched primitive layer (synced right after entities.add). Keep
        // name on the entity so the watchbox evaluator (reads e.name) and the
        // count-bubble aggregator identify the contact. MMSI fallback preserved.
        const labelText = vesselLabelText(props);
        if (labelText) opts.name = labelText;
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
      case 'airport': {
        // FR24-style airport tile. Static reference marker (no rotation, no
        // per-poll restyle — see refreshStyle). Zoom-gating is enforced in the
        // compositor's placesBboxQuery (world/continental view → empty payload);
        // the DDC here is belt-and-suspenders so a stray marker never paints
        // from continental altitude even if a bbox request slips through.
        const s = airportStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_500_000),
        };
        const labelText = airportLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'port': {
        // FR24/marine-style port tile. Static reference marker (same zoom-gate +
        // belt DDC as airport). No rotation, no per-poll restyle.
        const s = portStyle();
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_500_000),
        };
        const labelText = portLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'base': {
        // Military base — category SVG by branch (air/naval/army), same
        // zoom-gated static-reference-marker treatment as airport/port.
        const s = baseStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_500_000),
        };
        const labelText = baseLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'facility': {
        // Critical-infrastructure / military-installation facility — category
        // SVG dispatched on props.category (power/nuclear/water/datacenter/
        // telecom/ground_station/telescope/launch/military_*), same zoom-gated
        // static-reference-marker treatment as airport/port/base.
        const s = facilityStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1_500_000),
        };
        const labelText = facilityLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'warning': {
        // NGA naval broadcast warning — triangle glyph, distinct red mine
        // glyph when props.mine is true. Global layer (no zoom-gate DDC —
        // 386 active warnings worldwide is cheap to keep resident).
        const s = warningStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        };
        const labelText = warningLabelText(props);
        if (labelText) {
          opts.label = labelFor(labelText);
          opts.name = labelText;
        }
        break;
      }
      case 'hazard': {
        // 2026-07-14 keyless data-layers wave — disaster/cyclone/volcano/
        // radiation/relief/chokepoint/buoy/airquality/aurora. Category tile SVG
        // dispatched on props.kind. Global layers (no zoom-gate DDC): counts are
        // in the hundreds, cheap to keep resident.
        const s = hazardStyle(props);
        opts.billboard = {
          image: s.imageUri,
          scale: s.scale,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        };
        const name = props['name'];
        if (typeof name === 'string' && name.length > 0) opts.name = name;
        break;
      }
      default:
        opts.point = { color: Cesium.Color.WHITE, pixelSize: 4 };
    }

    // Map-side filter (HistogramPanel ↔ useFilters): a contact the active filter
    // excludes is born dimmed. Only aircraft/vessel billboards are facet-able;
    // everything else (and the no-filter case) is created at full opacity. This
    // sets the INITIAL color on the constructor billboard — the icon image is
    // untouched, so the entity still renders its SVG, just translucent.
    if (
      opts.billboard &&
      (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel')
    ) {
      const clauses = activeFilterClauses();
      if (clauses.length > 0 && !entityPassesFilter(props, clauses)) {
        const base =
          opts.billboard.color instanceof Cesium.Color
            ? opts.billboard.color
            : Cesium.Color.WHITE;
        opts.billboard.color = Cesium.Color.fromAlpha(base, FILTER_DIM_ALPHA);
      }
    }
  }

  // §5.3.1 push diet: refresh an entity's PropertyBag IN PLACE instead of
  // allocating `new Cesium.PropertyBag(props)` per contact per push. Cesium wraps
  // each raw JSON value in a "raw property" whose SETTER just swaps the backing
  // field (no allocation) and raises definitionChanged — so getValue()/facets/
  // EntityPanel/histogram/watchbox all stay live. The 2026-06-30 freshness
  // guardrail requires the bag's VALUES to be current, not its object identity;
  // this keeps them current while removing ~200k PropertyBag+ConstantProperty
  // allocations/s (13k contacts × ~10 keys × 1 Hz) of GC churn.
  // ponytail: keys are stable per feed source, so a key that DISAPPEARS keeps its
  // last value. Upgrade path: track+removeProperty vanished keys if a feed ever
  // ships variadic schemas.
  private refreshBag(e: Cesium.Entity, props: Record<string, unknown>): void {
    const bag = e.properties;
    if (!bag) {
      e.properties = new Cesium.PropertyBag(props);
      return;
    }
    refreshBagInPlace(bag, props);
  }

  private refreshStyle(e: Cesium.Entity, props: Record<string, unknown>): void {
    switch (this.props.styleKind) {
      case 'aircraft': {
        // Pixels live in the batched primitive collection — upsert icon image /
        // rotation / scale / filter-dim / label text there. The entity stays
        // graphics-less; we only keep e.name fresh so the watchbox evaluator
        // (which reads e.name) reflects a late-arriving callsign.
        this.primRenderer?.sync(e, props);
        const labelText = aircraftLabelText(props);
        if (labelText && e.name !== labelText) e.name = labelText;
        break;
      }
      case 'vessel': {
        // Pixels live in the batched primitive layer — upsert icon / rotation /
        // scale / filter-dim / label there. Keep e.name fresh for watchbox + the
        // count-bubble aggregator (a late AIS name upgrades the MMSI fallback).
        this.primRenderer?.sync(e, props);
        const labelText = vesselLabelText(props);
        if (labelText && e.name !== labelText) e.name = labelText;
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
      case 'tfr': {
        if (e.polygon) {
          const { fillColor, outlineColor, alpha } = tfrPolygonStyle(props);
          e.polygon.material = new Cesium.ColorMaterialProperty(
            Cesium.Color.fromCssColorString(fillColor).withAlpha(alpha),
          );
          e.polygon.outlineColor = new Cesium.ConstantProperty(
            Cesium.Color.fromCssColorString(outlineColor),
          );
        }
        const labelText = tfrLabelText(props);
        if (labelText && e.name !== labelText) {
          if (e.label) {
            e.label.text = new Cesium.ConstantProperty(labelText);
          } else {
            e.label = new Cesium.LabelGraphics(labelFor(labelText));
          }
          e.name = labelText;
        }
        break;
      }
    }
  }
}

// Read the active filter clause list once per drain pass. Pulled out so the
// hot per-entity loop calls a plain function (no zustand subscription churn).
function activeFilterClauses(): readonly import('../../state/stores.js').FilterClause[] {
  return useFilters.getState().clauses;
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

// aircraftBillboard + vesselBillboard removed — aircraft AND vessel icons are now
// batched primitives built in PrimitiveEntityLayer (the per-Entity billboard +
// label visualizer walk was the world-view drag-lag). The vessel billboard's
// 0→600 km ddc + 150→600 km translucency now live in the vessel PrimitiveEntity-
// Layer config (attach), and the world-view count bubbles in VesselClusterPrimitive.
