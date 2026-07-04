import * as Cesium from 'cesium';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { vesselStyle } from './styles.js';
import { labelFor, vesselLabelText } from './labelStyle.js';
import { intel } from '../../intel/registry.js';
import { tracks } from '../../intel/tracks.js';
import { useSelection } from '../../state/stores.js';
import { withWsKey } from '../../transport/http.js';

// Read a Cesium property's current value. Used to diff billboard fields so
// we only reassign when the value actually changed — repeatedly assigning
// the same data: URI causes Cesium to re-decode the image and the icon
// blinks off for a frame.
function currentValue<T>(prop: Cesium.Property | undefined): T | undefined {
  if (!prop) return undefined;
  try {
    return prop.getValue(Cesium.JulianDate.now()) as T | undefined;
  } catch {
    return undefined;
  }
}

interface VesselMsg {
  kind: 'vessel' | 'info';
  id?: string;
  mmsi?: number;
  name?: string | null;
  lat?: number;
  lon?: number;
  sog?: number;
  cog?: number;
  heading?: number;
  // ITU-R M.1371 ship type code (0-99); backend caches it across messages
  // and includes it on every vessel frame once known.
  shipType?: number | null;
  // Originating keyless feed (kystverket | digitraffic | kystdatahuset) or
  // aisstream. Surfaced on the entity panel so an analyst can tell which
  // upstream a contact came from. Optional — older frames omit it.
  source?: string;
  message?: string;
}

interface Props {
  ctx: AdapterCtx;
  url: string;
}

const MAX_VESSELS = 8000;
const PRUNE_AFTER_MS = 60 * 60 * 1000;

export class AisWsAdapter implements LayerAdapter {
  // Public so LayerCompositor can apply per-layer policy (EntityCluster
  // configuration, opacity walks). Mirrors PollGeoJsonAdapter, which also
  // exposes its data source for the same reason — clustering is a layer
  // policy, not an adapter concern.
  public ds: Cesium.CustomDataSource;
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private lastSeen = new Map<string, number>();
  private pruneTimer: number | null = null;
  private destroyed = false;

  constructor(private readonly props: Props) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    this.connect();
    this.pruneTimer = window.setInterval(() => this.prune(), 60_000);
  }

  detach(): void {
    this.destroyed = true;
    this.ws?.close();
    this.ws = null;
    if (this.pruneTimer != null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* gone */
    }
  }

  private connect(): void {
    if (this.destroyed) return;
    const ws = new WebSocket(withWsKey(this.props.url));
    this.ws = ws;
    this.props.ctx.reportStatus({ status: 'amber', note: 'connecting' });

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.props.ctx.reportStatus({ status: 'green', lastSeen: Date.now() });
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as VesselMsg;
        if (msg.kind === 'info') {
          this.props.ctx.reportStatus({
            status: 'amber',
            note: msg.message ?? 'upstream signalled no data',
          });
          return;
        }
        if (msg.kind === 'vessel' && msg.id && msg.lat != null && msg.lon != null) {
          this.upsert(msg as Required<Pick<VesselMsg, 'id' | 'lat' | 'lon'>> & VesselMsg);
        }
      } catch {
        /* drop bad frame */
      }
    };
    ws.onclose = () => {
      this.props.ctx.reportStatus({ status: 'red', note: 'websocket closed' });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.props.ctx.reportStatus({ status: 'red', note: 'websocket error' });
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    window.setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private upsert(m: VesselMsg & { id: string; lat: number; lon: number }): void {
    const now = Date.now();
    const entities = this.ds.entities;
    let e = entities.getById(m.id);
    const pos = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, 0);
    const props: Record<string, unknown> = {
      mmsi: m.mmsi,
      name: m.name,
      sog: m.sog,
      cog: m.cog,
      heading: m.heading,
      shipType: m.shipType ?? null,
      source: m.source,
      kind: 'vessel',
    };
    const s = vesselStyle(props);
    if (!s.imageUri) {
      // vesselStyle guarantees a non-empty data: URI for every code path;
      // refuse to render a bare-dot fallback if that invariant ever breaks.
      return;
    }
    // Pick the best identifier: real AIS name when broadcast, MMSI otherwise.
    // Without this, vessels rendered as anonymous boat icons — analysts had
    // no way to tell two ships apart from the map alone. Shared helper keeps
    // the polling adapter and this websocket adapter in lockstep.
    const labelText = vesselLabelText(props);
    if (e) {
      this.updatePosition(e, pos);
      if (e.billboard) {
        // Diff before reassigning — a fresh ConstantProperty re-decodes the
        // data: URI on every WS frame and produces visible blink-off-then-on
        // flicker. Only assign when the value actually changed.
        const curImg = currentValue<string>(e.billboard.image);
        if (curImg !== s.imageUri) {
          e.billboard.image = new Cesium.ConstantProperty(s.imageUri);
        }
        const curRot = currentValue<number>(e.billboard.rotation);
        if (curRot == null || Math.abs(curRot - s.rotationRad) >= 0.01) {
          e.billboard.rotation = new Cesium.ConstantProperty(s.rotationRad);
        }
        // Ship type often arrives only after the first ShipStaticData frame —
        // the category (and with it the icon scale) upgrades mid-session.
        const curScale = currentValue<number>(e.billboard.scale);
        if (curScale == null || Math.abs(curScale - s.scale) >= 0.02) {
          e.billboard.scale = new Cesium.ConstantProperty(s.scale);
        }
      }
      // Keep label in sync when a previously-anonymous vessel later
      // broadcasts its name (or vice versa).
      if (labelText && e.label) {
        const current = currentValue<string>(e.label.text);
        if (current !== labelText) {
          e.label.text = new Cesium.ConstantProperty(labelText);
        }
      }
      // refresh properties so the entity panel reflects latest sog/cog
      e.properties = new Cesium.PropertyBag(props);
    } else {
      if (entities.values.length >= MAX_VESSELS) this.dropOldest();
      e = entities.add({
        id: m.id,
        position: pos,
        billboard: {
          image: s.imageUri,
          scale: s.scale,
          rotation: s.rotationRad,
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          // Match the polling adapter's vessel treatment exactly (see
          // vesselBillboard in PollGeoJsonAdapter): icons paint below
          // ~600 km and cross-fade to the cluster bubbles above that.
          // The old 3,000 km cutoff here made AISStream vessels pop in/out
          // at a different zoom band than Digitraffic ones.
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 600_000),
          translucencyByDistance: new Cesium.NearFarScalar(150_000, 1.0, 600_000, 0.0),
          // Scale with distance, matching the polling adapter's vessels.
          scaleByDistance: new Cesium.NearFarScalar(5_000, 1.7, 400_000, 0.6),
        },
        ...(labelText && { label: labelFor(labelText) }),
        properties: props,
      });
    }
    if (labelText) e.name = labelText;
    this.lastSeen.set(m.id, now);
    // feed the intel tracker
    const fix: { mmsi: string; lat: number; lon: number; t: number; name?: string | null; sog?: number | null } = {
      mmsi: String(m.mmsi ?? m.id),
      lat: m.lat,
      lon: m.lon,
      t: now,
    };
    if (m.name != null) fix.name = m.name;
    if (m.sog != null) fix.sog = m.sog;
    intel.darkVessels.observe(fix);
    const tp: { t: number; lon: number; lat: number; alt: number; sog?: number; track?: number } = {
      t: now,
      lon: m.lon,
      lat: m.lat,
      alt: 0,
    };
    if (m.sog != null) tp.sog = m.sog;
    if (m.cog != null) tp.track = m.cog;
    // Selected vessel bypasses dedup so the magenta polyline gains a fresh
    // fix on every WS frame regardless of whether the vessel is moving —
    // anchored ships still get a dense track for visual confirmation that
    // the selection is being tracked.
    const force = useSelection.getState().selectedEntityId === m.id;
    tracks.push(m.id, tp, { force });
    this.props.ctx.viewer.scene.requestRender();
  }

  // Smooth position updates — CLAUDE.md: vessels must update in place via
  // SampledPositionProperty + LinearApproximation, never be snapped with a
  // fresh ConstantPositionProperty on an existing entity (icons jump).
  // Mirrors PollGeoJsonAdapter's vessel branch: stationary bypass, linear
  // interpolation, near-duplicate decimation, 5-minute sample pruning.
  private updatePosition(e: Cesium.Entity, newPos: Cesium.Cartesian3): void {
    const t0 = this.props.ctx.viewer.clock.currentTime;
    const prevPos = e.position?.getValue(t0) as Cesium.Cartesian3 | undefined;
    if (
      prevPos &&
      Cesium.Cartesian3.distance(prevPos, newPos) < 100 &&
      !(e.position instanceof Cesium.SampledPositionProperty)
    ) {
      // Anchored / moored — keep the cheap constant property.
      e.position = new Cesium.ConstantPositionProperty(newPos);
      return;
    }
    let sampled = e.position as Cesium.SampledPositionProperty | undefined;
    if (!(sampled instanceof Cesium.SampledPositionProperty)) {
      sampled = new Cesium.SampledPositionProperty();
      sampled.setInterpolationOptions({
        interpolationAlgorithm: Cesium.LinearApproximation,
        interpolationDegree: 1,
      });
      sampled.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      sampled.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
      if (prevPos) sampled.addSample(t0, prevPos);
      e.position = sampled;
    }
    const tNow = t0.clone();
    // Decimate: skip near-duplicate samples (<50 m within 60 s) so an
    // anchored vessel doesn't grow its sample array on every WS frame.
    const prevSample = sampled.getValue(t0) as Cesium.Cartesian3 | undefined;
    if (prevSample) {
      const movedM = Cesium.Cartesian3.distance(prevSample, newPos);
      if (movedM < 50) return;
    }
    sampled.addSample(tNow, newPos);
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

  private prune(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    const entities = this.ds.entities;
    for (const [id, t] of this.lastSeen) {
      if (t < cutoff) {
        entities.removeById(id);
        this.lastSeen.delete(id);
      }
    }
    // Bound the dark-vessel tracker too: candidates only ever come from
    // fixes ≤ gap+lookback (90 min) old, so anything past 2h is dead weight.
    // Without this the per-MMSI map grew unbounded over long sessions.
    intel.darkVessels.prune(2 * 60 * 60 * 1000);
    this.props.ctx.viewer.scene.requestRender();
  }

  private dropOldest(): void {
    const sorted = [...this.lastSeen.entries()].sort((a, b) => a[1] - b[1]);
    const drop = Math.max(1, Math.floor(sorted.length * 0.1));
    for (let i = 0; i < drop; i++) {
      const entry = sorted[i];
      if (!entry) continue;
      const [id] = entry;
      this.ds.entities.removeById(id);
      this.lastSeen.delete(id);
    }
  }
}
