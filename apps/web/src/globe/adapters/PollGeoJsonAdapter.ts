import * as Cesium from 'cesium';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { aircraftStyle, fireStyle, jammingPolygonStyle, quakeStyle, vesselStyle } from './styles.js';
import { labelFor, aircraftLabelText, vesselLabelText } from './labelStyle.js';
import { tracks } from '../../intel/tracks.js';
import { aircraftDedup } from '../../intel/registry.js';
import { useSelection } from '../../state/stores.js';
import { apiFetch } from '../../transport/http.js';

// Minimum-perceptible deltas for billboard updates. Cesium reloads the
// underlying GPU resource whenever a billboard property is *reassigned* —
// even when the new value is identical to the current one. At 4 s polls
// over 8 K aircraft that turns into a constant icon reload storm: icons
// blink off then on while the data URI re-decodes. We diff against the
// current value and skip the assignment when the change is below the
// noise floor.
const ROT_EPSILON = 0.01; // ~0.57°
const SCALE_EPSILON = 0.02;

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

export type StyleKind = 'quake' | 'aircraft' | 'fire' | 'vessel' | 'jamming' | 'generic';

interface Props {
  ctx: AdapterCtx;
  endpoint: string;
  intervalSec: number;
  styleKind: StyleKind;
  // Optional bbox provider — re-evaluated every poll so AOI changes propagate
  // without recreating the adapter.
  bboxQuery?: () => string | null;
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

// Per-layer entity cap. Bumped from 12 000 → 25 000 so Digitraffic Finland's
// ~18 400-vessel global snapshot lands in full instead of being silently
// truncated by ~6 000 contacts. 25k upserts under Cesium's PropertyBag +
// SampledPositionProperty path stays well under one render frame on a
// reference desktop GPU; the heaviest cost is the icon-data-URI decode
// path, which is amortised by the diffed billboard updates above.
const MAX_PER_LAYER = 25_000;

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
  // Track ids seen on the previous poll so we can prune those that vanished.
  private seenIds = new Set<string>();
  // entityId → icao24 for aircraft entities currently owned by this layer.
  // Used during the prune phase to release dedup claims when an aircraft
  // disappears from the upstream feed (so a lower-priority layer can take
  // over rendering it).
  private ownedIcao = new Map<string, string>();

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
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
    if (this.timer != null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.aborter?.abort();
    // Release every dedup claim this layer was holding so other layers can
    // take over rendering the affected icao24s on their next poll.
    const layerId = this.props.ctx.descriptor.id;
    for (const icao of this.ownedIcao.values()) {
      aircraftDedup.release(icao, layerId);
    }
    this.ownedIcao.clear();
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* viewer destroyed */
    }
  }

  // Chained-setTimeout poller. `setInterval(poll, ttl)` schedules every ttl ms
  // regardless of how long the previous poll took; under congestion (slow
  // backend, big response, paused tab catching up) polls stack and the
  // in-flight aborter cancels them, but the new fetch fires immediately —
  // producing a tight retry storm against the upstream. We instead measure
  // the actual elapsed time and book the next tick at max(ttl - elapsed,
  // 250ms). The floor prevents a busy-loop if upstream is instant (cache
  // hits) AND keeps a paused-then-resumed tab from issuing a sprint of
  // catch-up polls.
  private scheduleNext(delayMs: number): void {
    if (this.detached) return;
    this.timer = window.setTimeout(() => {
      const started = Date.now();
      void this.poll().finally(() => {
        const elapsed = Date.now() - started;
        const ttl = this.props.intervalSec * 1000;
        const next = Math.max(ttl - elapsed, 250);
        this.scheduleNext(next);
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
    this.aborter?.abort();
    this.aborter = new AbortController();
    try {
      const r = await apiFetch(this.buildUrl(), { signal: this.aborter.signal });
      if (!r.ok) {
        this.props.ctx.reportStatus({ status: 'red', note: `upstream ${r.status}` });
        return;
      }
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

  private render(fc: FeatureCollection): void {
    const entities = this.ds.entities;
    entities.suspendEvents();

    const nextIds = new Set<string>();
    const feats = (fc.features ?? []).slice(0, MAX_PER_LAYER);
    for (const f of feats) {
      if (!f.geometry) continue;
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

      // Feed track ring for the entity-panel sparkline
      if (this.props.styleKind === 'aircraft' || this.props.styleKind === 'vessel') {
        const tp: { t: number; lon: number; lat: number; alt: number; sog?: number; track?: number } = {
          t: Date.now(),
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
        if (isTrackable) {
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
              if (this.props.styleKind === 'aircraft') {
                sampled.setInterpolationOptions({
                  interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
                  interpolationDegree: 2,
                });
              } else {
                sampled.setInterpolationOptions({
                  interpolationAlgorithm: Cesium.LinearApproximation,
                  interpolationDegree: 1,
                });
              }
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
              // Prune anything older than 30 minutes so the in-memory sample
              // array stays bounded regardless of session length. 30 min is
              // long enough that the past-trail polyline (entity panel) still
              // shows a useful track, short enough that we don't carry a
              // session's worth of fixes per vessel forever.
              const cutoff = Cesium.JulianDate.addSeconds(tNow, -1800, new Cesium.JulianDate());
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
        entities.add(opts);
      }
    }

    // Prune entities that disappeared from the upstream payload. For aircraft
    // also release our dedup claim so a lower-priority layer can pick the
    // icao24 up on its next poll.
    const layerIdForPrune = this.props.ctx.descriptor.id;
    for (const oldId of this.seenIds) {
      if (!nextIds.has(oldId)) {
        entities.removeById(oldId);
        const icao = this.ownedIcao.get(oldId);
        if (icao) {
          aircraftDedup.release(icao, layerIdForPrune);
          this.ownedIcao.delete(oldId);
        }
      }
    }
    this.seenIds = nextIds;

    entities.resumeEvents();
    this.props.ctx.viewer.scene.requestRender();
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

function aircraftBillboard(s: ReturnType<typeof aircraftStyle>): Cesium.BillboardGraphics.ConstructorOptions {
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

function vesselBillboard(s: ReturnType<typeof vesselStyle>): Cesium.BillboardGraphics.ConstructorOptions {
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
  };
}

