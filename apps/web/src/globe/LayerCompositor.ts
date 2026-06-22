import * as Cesium from 'cesium';
import type { LayerDescriptor } from '@osint/shared';
import type { LayerRegistry } from '../registry/LayerRegistry.js';
import { useFeeds } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { isMobileDevice } from '../shell/device.js';
import type { LayerAdapter, AdapterCtx, StatusReporter } from './adapters/types.js';
import { PollGeoJsonAdapter, type StyleKind } from './adapters/PollGeoJsonAdapter.js';
import { AisWsAdapter } from './adapters/AisWsAdapter.js';
import { CablesAdapter } from './adapters/CablesAdapter.js';
import { SatelliteAdapter } from './adapters/SatelliteAdapter.js';
import { MilSymbolAdapter } from './adapters/MilSymbolAdapter.js';

// AOI-aware bbox helper used by all adapters that accept a bbox query.
function aoiBboxQuery(): string | null {
  const aoi = useAoi.getState().active;
  if (!aoi) return null;
  const [w, s, e, n] = aoi.bbox;
  return `lamin=${s}&lomin=${w}&lamax=${n}&lomax=${e}`;
}

// Camera-viewport bbox provider for the high-volume layers (global ADS-B + AIS).
// Returns a lamin/lomin/lamax/lomax + limit query so the backend serves ONLY
// on-screen contacts — the per-poll upsert + re-cluster of the full ~30k entity
// set is the web UI's real cost (the GPU render itself is ~8 ms). At near-global
// zoom it drops the bbox and just caps + decimates, since everything is on
// screen anyway.
function viewportQuery(
  viewer: Cesium.Viewer,
  limit: number,
  worldLimit: number = limit,
  // Mobile: NEVER take the no-bbox world path (the backend serves the full ~13k
  // pre-built blob there). Always send a bbox + low limit so the backend
  // decimates server-side and the phone gets a small payload it can actually
  // render + animate. The (near-)global bbox below routes through viewport_filter.
  alwaysBbox = false,
): () => string | null {
  const GLOBAL_BBOX = `lamin=-85&lomin=-180&lamax=85&lomax=180&limit=${limit}`;
  return () => {
    const rect = viewer.camera.computeViewRectangle();
    if (rect) {
      const s = Cesium.Math.toDegrees(rect.south);
      const n = Cesium.Math.toDegrees(rect.north);
      const w = Cesium.Math.toDegrees(rect.west);
      const e = Cesium.Math.toDegrees(rect.east);
      const widthDeg = ((e - w) % 360 + 360) % 360;
      // ~world view: there's no bbox to scope by, and 14k individual dots are
      // visually indistinguishable at this zoom, so cap to worldLimit to keep the
      // entity-update loop cheap. Zooming in drops below the threshold and loads
      // the FULL local traffic (up to `limit`) for the viewport — so China/Russia
      // etc. show everything when you actually look at them.
      if (widthDeg > 170 || n - s > 140) return alwaysBbox ? GLOBAL_BBOX : `limit=${worldLimit}`;
      // Pad ~15% so contacts just outside the frame are loaded before they
      // scroll in; clamp to the backend's accepted ranges.
      const padLat = (n - s) * 0.15;
      const padLon = widthDeg * 0.15;
      const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
      const S = clamp(s - padLat, -90, 90).toFixed(3);
      const N = clamp(n + padLat, -90, 90).toFixed(3);
      const W = clamp(w - padLon, -180, 180).toFixed(3);
      const E = clamp(e + padLon, -180, 180).toFixed(3);
      return `lamin=${S}&lomin=${W}&lamax=${N}&lomax=${E}&limit=${limit}`;
    }
    // computeViewRectangle() returns undefined when the globe doesn't cleanly
    // fill the frame — a TILTED / oblique view with the horizon or sky visible,
    // the common case the moment you zoom in and pitch the camera. Falling back
    // to the global `limit=worldLimit` subset then served the sparse ~4000
    // worldwide sample over your local area → "zoom in and planes don't load".
    // Derive a LOCAL bbox from the globe point under the screen centre + the
    // camera height instead, so a zoomed-in oblique view always loads its own
    // traffic. Only when the screen centre misses the globe (pointed at space)
    // do we keep the world fallback.
    return cameraCenterBbox(viewer, limit) ?? (alwaysBbox ? GLOBAL_BBOX : `limit=${worldLimit}`);
  };
}

// Local bbox centred on the globe point under the screen centre, sized from the
// camera height. Used when computeViewRectangle() can't return a rectangle.
function cameraCenterBbox(viewer: Cesium.Viewer, limit: number): string | null {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const cw = canvas.clientWidth || canvas.width;
  const ch = canvas.clientHeight || canvas.height;
  if (!cw || !ch) return null;
  const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(cw / 2, ch / 2));
  if (!ray) return null;
  const hit = scene.globe.pick(ray, scene);
  if (!hit) return null; // screen centre is on the sky → keep the world fallback
  const carto = Cesium.Cartographic.fromCartesian(hit);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const height = viewer.camera.positionCartographic?.height ?? 500_000;
  // Half-span (deg) from camera height. A tilted view sees far ahead of the
  // ground point, so be generous; clamp so we never effectively go global.
  const spanDeg = Math.min(40, Math.max(0.5, height / 60_000));
  const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
  const padLon = spanDeg / Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  const S = clamp(lat - spanDeg, -90, 90).toFixed(3);
  const N = clamp(lat + spanDeg, -90, 90).toFixed(3);
  const W = clamp(lon - padLon, -180, 180).toFixed(3);
  const E = clamp(lon + padLon, -180, 180).toFixed(3);
  return `lamin=${S}&lomin=${W}&lamax=${N}&lomax=${E}&limit=${limit}`;
}

// Bridges LayerRegistry → Cesium. One adapter per enabled layer.
export class LayerCompositor {
  private adapters = new Map<string, LayerAdapter>();
  private unsubscribe: (() => void) | null = null;
  // Layer id → desired opacity. Needed because adapters add entities on
  // every poll AFTER spawn() ran — a one-shot walk at spawn time hit an
  // empty datasource and the descriptor's opacity silently never applied.
  private desiredOpacity = new Map<string, number>();
  // Layer id → detach function for the collectionChanged listener that
  // re-applies opacity to late-added entities.
  private opacityListeners = new Map<string, () => void>();

  constructor(
    private readonly registry: LayerRegistry,
    private readonly viewer: Cesium.Viewer,
  ) {}

  private unsubAoi: (() => void) | null = null;

  start(): void {
    this.unsubscribe = this.registry.subscribe((e) => {
      if (e.type === 'register' && this.registry.isEnabled(e.layer.id)) {
        this.spawn(e.layer);
      } else if (e.type === 'enable') {
        const d = this.registry.get(e.id);
        if (d) this.spawn(d);
      } else if (e.type === 'disable' || e.type === 'unregister') {
        this.kill(e.id);
      } else if (e.type === 'opacity') {
        this.setOpacity(e.id, e.opacity);
      }
    });
    for (const d of this.registry.list()) {
      if (this.registry.isEnabled(d.id)) this.spawn(d);
    }
    // Re-poll all bbox-aware adapters when the AOI changes.
    this.unsubAoi = useAoi.subscribe(() => {
      for (const [, a] of this.adapters) {
        if ('refresh' in a && typeof (a as unknown as { refresh: () => void }).refresh === 'function') {
          (a as unknown as { refresh: () => void }).refresh();
        }
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubAoi?.();
    this.unsubAoi = null;
    for (const id of [...this.adapters.keys()]) this.kill(id);
  }

  private spawn(d: LayerDescriptor): void {
    if (this.adapters.has(d.id)) return;
    const reportStatus: StatusReporter = (s) => {
      useFeeds.getState().setFeed({
        id: d.id,
        label: d.title,
        status: s.status,
        ...(s.lastSeen !== undefined && { lastSeen: s.lastSeen }),
        ...(s.note !== undefined && { note: s.note }),
      });
    };
    const ctx: AdapterCtx = { viewer: this.viewer, descriptor: d, reportStatus };
    const adapter = this.makeAdapter(d, ctx);
    if (!adapter) return;
    this.adapters.set(d.id, adapter);
    void adapter.attach(this.viewer);
    reportStatus({ status: 'amber', note: 'connecting' });
    this.setOpacity(d.id, d.opacity);
    // Entities arrive on every poll/WS frame AFTER this point — keep the
    // layer's opacity applied to them as they are added.
    const ds = (adapter as { ds?: Cesium.CustomDataSource }).ds;
    if (ds) {
      const onChanged = (
        _c: Cesium.EntityCollection,
        added: Cesium.Entity[],
      ): void => {
        const opacity = this.desiredOpacity.get(d.id);
        if (opacity == null || opacity >= 1) return;
        for (const e of added) applyEntityOpacity(e, opacity);
      };
      ds.entities.collectionChanged.addEventListener(onChanged);
      this.opacityListeners.set(d.id, () =>
        ds.entities.collectionChanged.removeEventListener(onChanged),
      );
    }
  }

  private kill(id: string): void {
    const a = this.adapters.get(id);
    if (!a) return;
    this.opacityListeners.get(id)?.();
    this.opacityListeners.delete(id);
    this.desiredOpacity.delete(id);
    a.detach();
    this.adapters.delete(id);
    useFeeds.getState().setFeed({ id, label: id, status: 'unknown' });
  }

  private setOpacity(id: string, opacity: number): void {
    // CustomDataSource doesn't have a single opacity knob, so we walk the
    // entities and set billboard/point alpha (and a collectionChanged
    // listener installed at spawn() applies the same to entities added by
    // later polls). Polyline cables override.
    this.desiredOpacity.set(id, opacity);
    const a = this.adapters.get(id);
    if (!a) return;
    const ds = (a as { ds?: Cesium.CustomDataSource | Cesium.GeoJsonDataSource }).ds;
    if (!ds) return;
    for (const e of ds.entities.values) {
      applyEntityOpacity(e, opacity);
    }
    this.viewer.scene.requestRender();
  }

  private makeAdapter(d: LayerDescriptor, ctx: AdapterCtx): LayerAdapter | null {
    // MIL-STD-2525 COP overlay — self-contained CustomDataSource, dispatched by
    // id so it never reaches the geojson/aircraft styling path (icon guardrail).
    if (d.id.startsWith('mil.cop.')) {
      return new MilSymbolAdapter({ ctx });
    }
    // websocket layers
    if (d.kind === 'websocket' && d.id === 'maritime.aisstream') {
      const adapter = new AisWsAdapter({ ctx, url: d.endpoint });
      // AISStream is a global vessel firehose — without EntityCluster on its
      // CustomDataSource the world view paints as one smeared green blob over
      // every major shipping lane. Mirror the polling-adapter vessel branch
      // so AISStream and Digitraffic get the same low-zoom decluttering.
      configureVesselClustering(adapter.ds);
      return adapter;
    }
    // satellites — any CelesTrak group layer (stations/starlink/gps/visual/…).
    // The group is encoded in the endpoint query; each enabled layer is its own
    // adapter instance with the SampledPositionProperty motion model.
    if (d.group === 'space' && d.id.startsWith('space.celestrak.')) {
      const group =
        new URLSearchParams(d.endpoint.split('?')[1] ?? '').get('group') ?? 'active';
      return new SatelliteAdapter({
        ctx,
        endpoint: d.endpoint,
        group,
        refreshSec: d.refresh.ttlSec ?? 7200,
      });
    }
    // submarine cables — polyline rendering
    if (d.id === 'infra.cables.lines') {
      return new CablesAdapter({ ctx, endpoint: d.endpoint, kind: 'lines' });
    }
    if (d.id === 'infra.cables.landings') {
      return new CablesAdapter({ ctx, endpoint: d.endpoint, kind: 'landings' });
    }
    // GeoJSON point layers — style derived from the emits tag
    if (d.kind === 'geojson') {
      // Layer-id override for sources that share an emits kind but want a
      // distinct visual treatment. The jamming heat layer emits 'outage'
      // semantically (it's a GNSS service degradation) but renders as a
      // sized translucent point, not the generic outage icon.
      const style: StyleKind =
        d.id === 'env.jamming.nacp' ? 'jamming' : styleFromEmits(d.emits);
      const ttl = d.refresh.ttlSec ?? 30;
      // A phone can't render/upsert the full ~13k world view every ~2 s (it
      // overheats and the main thread is too busy to interpolate, so planes
      // freeze). Mobile clients get a small server-decimated payload (always a
      // bbox + low limit), no WS firehose (it ships the whole blob), and a
      // slower poll so the main thread has frames left to animate the gliding.
      const mobile = isMobileDevice();
      const interval = mobile ? Math.max(ttl, 4) : ttl;
      // Bbox scoping (lamin/lomin/lamax/lomax). The two high-volume layers use a
      // CAMERA-VIEWPORT query + cap so only on-screen contacts are instantiated
      // (the fix for web-UI lag); OpenSky uses the AOI bbox; everything else is
      // global. refreshOnMove re-polls the viewport layers on camera moveEnd.
      let bboxQuery: (() => string | null) | undefined;
      let refreshOnMove = false;
      let wsEndpoint: string | undefined;
      if (d.id === 'aviation.opensky.states') {
        bboxQuery = aoiBboxQuery;
      } else if (d.id === 'aviation.adsb.global') {
        // Desktop: up to 20000 (full union, served from the pre-built blob + WS
        // push). Mobile: always a bbox + 2000 cap so the backend decimates and
        // the phone gets a payload it can render and animate; no WS firehose.
        bboxQuery = viewportQuery(ctx.viewer, mobile ? 2000 : 20000, mobile ? 2000 : 20000, mobile);
        refreshOnMove = true;
        if (!mobile) wsEndpoint = '/ws/adsb';
      } else if (d.id === 'maritime.digitraffic') {
        bboxQuery = viewportQuery(ctx.viewer, mobile ? 1500 : 6000, undefined, mobile);
        refreshOnMove = true;
      } else if (d.id === 'maritime.keyless' && mobile) {
        // The default global vessel layer (~5k). The endpoint honours ?limit, so
        // cap the payload on mobile (the render path also caps as a safety net).
        bboxQuery = () => 'limit=2000';
      }
      const adapter = new PollGeoJsonAdapter({
        ctx,
        endpoint: d.endpoint,
        intervalSec: interval,
        styleKind: style,
        ...(bboxQuery && { bboxQuery }),
        ...(refreshOnMove && { refreshOnMove }),
        ...(wsEndpoint && { ws: wsEndpoint }),
      });
      // Vessels cluster to declutter shipping lanes at world scale. Aircraft do
      // NOT: Cesium re-clusters over EVERY entity on each camera move, which ran
      // on the main thread and was the source of the drag-lag (the GPU sits ~0%
      // — the wall was JS, not raster). The world-view aircraft count is already
      // capped (viewportQuery worldLimit), so individual billboards draw cheaply
      // and the per-move re-cluster cost is gone.
      if (style === 'vessel') {
        const ds = (adapter as unknown as { ds?: Cesium.CustomDataSource }).ds;
        if (ds) configureVesselClustering(ds);
      }
      return adapter;
    }
    return null;
  }
}

// Apply a layer-level opacity to one entity's renderable bits.
//
// CRITICAL: when an entity's billboard.color is a CallbackProperty (the
// emergency-squawk pulse for aircraft, see aircraftBillboard) we MUST NOT
// replace it — overwriting with a static white-with-alpha kills the pulse
// and leaves the icon a flat colour forever. For non-callback colours we
// preserve the existing tint and only mutate the alpha.
function applyEntityOpacity(e: Cesium.Entity, opacity: number): void {
  if (e.billboard) {
    const cur = e.billboard.color;
    if (cur instanceof Cesium.CallbackProperty) {
      // Emergency pulse — leave it alone.
    } else if (cur) {
      const orig = cur.getValue(Cesium.JulianDate.now()) as Cesium.Color | undefined;
      if (orig) {
        e.billboard.color = new Cesium.ConstantProperty(orig.withAlpha(opacity));
      }
    } else {
      e.billboard.color = new Cesium.ConstantProperty(Cesium.Color.WHITE.withAlpha(opacity));
    }
  }
  if (e.point && e.point.color) {
    if (e.point.color instanceof Cesium.CallbackProperty) {
      // Pulsing point colour — preserve.
    } else {
      const orig = e.point.color.getValue(Cesium.JulianDate.now()) as Cesium.Color | undefined;
      if (orig) e.point.color = new Cesium.ConstantProperty(orig.withAlpha(opacity));
    }
  }
  if (e.polyline?.material) {
    e.polyline.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString('#2dd4bf').withAlpha(opacity),
    );
  }
}

// Cluster styling for vessel layers. Matches the accent-ring aesthetic used
// elsewhere — a translucent teal disc with a thin outline and the count in
// the center. We rebuild the billboard image on every clustering event
// because Cesium hands us the live event payload with the merged entities.
function configureVesselClustering(ds: Cesium.CustomDataSource): void {
  ds.clustering.enabled = true;
  // Aggressive enough to declutter at globe scale, lax enough that close-up
  // (port view) shows individual ship icons instead of one big cluster blob.
  // pixelRange = 24 only merges entities ~24px apart; minimumClusterSize = 16
  // is the audit-tightened floor (was 8) — at 8, tight ports painted a wall
  // of overlapping bubbles instead of letting individual vessels through.
  ds.clustering.pixelRange = 24;
  ds.clustering.minimumClusterSize = 16;
  ds.clustering.clusterBillboards = true;
  ds.clustering.clusterLabels = true;
  // Vessel entities never use Cesium points (they render as billboard icons),
  // so clusterPoints would only enable the aggregator to also fold in stray
  // point primitives we don't have. Off keeps the cluster pipeline focused
  // on the billboards + labels we actually emit.
  ds.clustering.clusterPoints = false;
  ds.clustering.clusterEvent.addEventListener((_clustered, cluster) => {
    cluster.label.show = true;
    cluster.label.text = String(cluster.label.text);
    cluster.label.font = '11px "IBM Plex Mono", monospace';
    cluster.label.fillColor = Cesium.Color.fromCssColorString('#0b0e14');
    cluster.label.showBackground = false;
    cluster.label.pixelOffset = new Cesium.Cartesian2(0, 0);
    cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.billboard.show = true;
    cluster.billboard.image = vesselClusterRing();
    cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.billboard.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
    // Smooth handoff to individual ship icons. Individual vessel billboards
    // fade in from 150 km → 600 km (see vesselBillboard.translucencyByDistance).
    // We invert that here: the cluster bubble is fully opaque at world / continent
    // scale, then fades out from 650 km → 350 km as the camera dives in. The
    // 350–600 km overlap band gives a soft cross-fade with the individual ship
    // billboards without a long stretch of double-rendered clusters + icons
    // (the old 250k→800k band had a 450 km overlap that visibly painted both
    // primitives at the same time at continent-to-region zoom).
    cluster.billboard.translucencyByDistance = new Cesium.NearFarScalar(
      350_000,
      0.0,
      650_000,
      1.0,
    );
    cluster.label.translucencyByDistance = new Cesium.NearFarScalar(
      350_000,
      0.0,
      650_000,
      1.0,
    );
    cluster.point.show = false;
  });
}

let cachedClusterRing: string | null = null;
function vesselClusterRing(): string {
  if (cachedClusterRing) return cachedClusterRing;
  const canvas = document.createElement('canvas');
  canvas.width = 28;
  canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.beginPath();
    ctx.arc(14, 14, 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.55)';
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = '#0b0e14';
    ctx.stroke();
  }
  cachedClusterRing = canvas.toDataURL('image/png');
  return cachedClusterRing;
}

function styleFromEmits(emits: readonly string[] | undefined): StyleKind {
  if (!emits || emits.length === 0) return 'generic';
  const e = emits[0];
  if (e === 'aircraft') return 'aircraft';
  if (e === 'vessel') return 'vessel';
  if (e === 'fire') return 'fire';
  if (e === 'quake') return 'quake';
  if (e === 'camera') return 'camera';
  return 'generic';
}
