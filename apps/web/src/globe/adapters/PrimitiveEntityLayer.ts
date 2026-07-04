import * as Cesium from 'cesium';
import { useFilters } from '../../state/stores.js';
import { entityPassesFilter } from '../../explorer/HistogramPanel.js';
import { setRenderNeed } from '../renderNeeds.js';
import { useSelection } from '../../state/stores.js';
import { perfSetAnimated } from '../perf.js';

// Generic batched-primitive renderer for high-count map layers. Renders icons +
// labels as ONE Cesium.BillboardCollection + ONE Cesium.LabelCollection
// (GPU-instanced, one draw call) instead of one Cesium.Entity billboard/label
// per contact.
//
// WHY: at thousands of contacts the Entity path makes DataSourceDisplay's
// BillboardVisualizer/LabelVisualizer walk every icon on the CPU each frame the
// camera moves (O(all entities)); the GPU sits ~0% — that JS walk is the
// world-view drag-lag (docs/frontend.md:121 "≤5k entities; degrade to
// primitives"). A collection uploads each distinct icon once and the GPU
// computes screen positions in the vertex shader, so a pan no longer touches the
// main thread per icon.
//
// The owning adapter keeps a GRAPHICS-LESS Cesium.Entity per contact (position +
// name + properties, no billboard/label) so everything that reads
// ds.entities — watchbox evaluator, histogram facets, layer/contact counts,
// selection's getById (reticle / camera fly-to / overlays / projection) — keeps
// working unchanged. We render the PIXELS off the entity; the entity stays the
// data + position source of truth. Because we read entity.position, teleport
// (ConstantPositionProperty), glide (SampledPositionProperty), and SGP4 orbit
// windows all drive the icon with zero changes to the adapter's position logic.
//
// Used by: aircraft (PollGeoJsonAdapter), satellites (SatelliteAdapter), vessels.

// Map-side filter dim alpha — an excluded contact stays DRAWN (same icon /
// rotation / scale) but fades so matching ones pop.
const FILTER_DIM_ALPHA = 0.1;
// Below-the-noise-floor deltas: a BillboardCollection re-uploads the changed
// billboard's vertex slice on any property write, so skip writes that wouldn't
// move a pixel.
const ROT_EPSILON = 0.01;
const SCALE_EPSILON = 0.02;
const EMERGENCY_RED = '#ef4444';

// Stand-up ("see it from the side") mode. Camera pitch runs −π/2 (straight down)
// → 0 (horizon). Past this threshold toward the horizon we swap each icon for
// its side-profile silhouette standing vertically on its point, so a ctrl-drag
// tilt shows the plane/ship from the side instead of just spinning the flat
// top-down sprite. ponytail: one global pitch proxy, not a per-icon horizon
// angle — exact enough at any focused view; upgrade to per-entity if world-edge
// icons ever need it.
const STANDUP_PITCH = -Cesium.Math.PI_OVER_FOUR; // −45°
// Only stand the icons up when the camera is reasonably close — at world-view
// altitude an oblique tilt packs thousands of side profiles into a smear, so
// keep the clean top-down icons up there.
const STANDUP_MAX_HEIGHT_M = 2_500_000; // ~2500 km
// §5.5 lazy labels: only materialize a Cesium Label when the camera is within the
// label ddc DRAW window (labelStyle.ts uses DistanceDisplayCondition(0, 400 km)),
// so world view maintains ~0 labels instead of 13k invisible ones. Threshold ==
// the ddc far bound → the visible set is pixel-identical to today. Selected +
// emergency contacts are always materialized regardless of zoom.
const LABEL_MATERIALIZE_ALT_M = 400_000;
// §5.4 animated-mirror LOD: rebuild the frustum-visible set at 2 Hz; between
// rebuilds, mirror only visible prims each frame. Off-screen prims refresh at 2 Hz
// (a vessel at ≤15 m/s moves ≤7.5 m in 500 ms — invisible when it scrolls in).
const VISIBLE_RECOMPUTE_MS = 500;
// Hard cap on prims mirrored per frame — a backstop for a pathological
// everything-on-screen case; capped by stable Map insertion order (no churn).
const MAX_ANIMATED = 4000;
const _cullSphere = new Cesium.BoundingSphere();
const _upScratch = new Cesium.Cartesian3();

export interface PrimitiveStyle {
  imageUri: string;
  scale: number;
  rotationRad?: number;
  // Billboard tint (multiplied onto the SVG). Default white = no tint (the SVG
  // already carries its colour); satellites pass an accent tint.
  color?: Cesium.Color;
  // Honoured only when opts.pulse — drives the red emergency-squawk pulse.
  emergency?: boolean;
}

export interface PrimitiveLayerOpts {
  styleFn: (props: Record<string, unknown>) => PrimitiveStyle;
  labelFn: (props: Record<string, unknown>) => string | null;
  // Static per-billboard options (ddc, scaleByDistance, origins, alignedAxis,
  // translucencyByDistance…). Returned fresh per call so value objects aren't
  // shared across billboards. position/image/scale/rotation/color/id are added
  // by sync(), so this is the partial of the remaining static fields.
  billboardBase: () => Partial<Cesium.Billboard.ConstructorOptions>;
  // Same label style for every contact in the layer (the shared labelStyle.ts).
  labelBase: (text: string) => Cesium.Label.ConstructorOptions;
  getClock: () => Cesium.JulianDate;
  // Run the per-frame position mirror (icons that move between syncs: orbiting
  // satellites, gliding vessels, dead-reckoned aircraft). Omit/false → positions
  // only update on sync() (teleport), keeping requestRenderMode idle.
  shouldAnimate?: () => boolean;
  // Enable the emergency-squawk red pulse for styles with emergency=true.
  pulse?: boolean;
  // Apply the map-side filter dim (aircraft/vessel facets). Off for satellites.
  filter?: boolean;
  // When set, the layer "stands up" its icons and shows this side-profile style
  // while the camera is tilted toward the horizon, so you see the plane/ship
  // from the side. Omit for layers that must stay flat (satellites).
  sideStyleFn?: (props: Record<string, unknown>) => PrimitiveStyle;
}

interface Prim {
  bb: Cesium.Billboard;
  lbl: Cesium.Label | null;
  entity: Cesium.Entity;
  // Last props synced for this icon — kept so a filter toggle can recompute the
  // dim of EVERY icon once (reapplyDim) without re-reading the PropertyBag, and
  // without the adapter having to re-sync stationary contacts every poll.
  props: Record<string, unknown>;
  emergency: boolean;
  dimFactor: number;
  labelText: string | null;
  tint: Cesium.Color;
  // Cached top-down vs side-profile looks so the tilt toggle can swap between
  // them without re-running styleFn. side is null when no sideStyleFn.
  topImage: string;
  topRot: number;
  topScale: number;
  sideImage: string | null;
  sideScale: number;
}

export class PrimitiveEntityLayer {
  private static seq = 0;
  private readonly bbColl: Cesium.BillboardCollection;
  private readonly lblColl: Cesium.LabelCollection;
  private readonly prims = new Map<string, Prim>();
  private readonly emergencyIds = new Set<string>();
  // §5.1 render-governor need: unique per instance so multiple aircraft tiers
  // don't clobber each other's pulse flag. Only re-registered on transition.
  private readonly pulseNeedKey = `pulse:${PrimitiveEntityLayer.seq++}`;
  private lastPulseNeed = false;
  // §5.4 animated-mirror LOD state.
  private readonly visibleIds = new Set<string>();
  private lastVisibleMs = 0;
  private wasAnimating = false;
  private layerOpacity = 1;
  private removePreUpdate: (() => void) | null = null;
  private removeCameraChanged: (() => void) | null = null;
  private removeFilterSub: (() => void) | null = null;
  // Camera tilted toward the horizon → icons stand up as side silhouettes.
  private tiltActive = false;

  constructor(
    private readonly scene: Cesium.Scene,
    private readonly opts: PrimitiveLayerOpts,
  ) {
    this.bbColl = new Cesium.BillboardCollection({ scene });
    this.lblColl = new Cesium.LabelCollection({ scene });
    scene.primitives.add(this.bbColl);
    scene.primitives.add(this.lblColl);
    if (opts.sideStyleFn) {
      // Re-evaluate stand-up mode whenever the camera moves (ctrl-drag tilt).
      // §5.2.2: 0.15 (was 0.05) — 0.05 fired camera.changed every ~5% viewport
      // shift, storming EVERY listener (tilt check, google-gate, GlobeOverlays)
      // through a drag. 0.15 still catches a tilt-threshold crossing but cuts the
      // event rate ~3×. Only raise it; never below the Cesium 0.5 default's intent.
      if (scene.camera.percentageChanged > 0.15) scene.camera.percentageChanged = 0.15;
      this.tiltActive = this.computeTilt();
      const onCam = (): void => {
        const next = this.computeTilt();
        if (next === this.tiltActive) return;
        this.tiltActive = next;
        this.applyTiltToAll();
        scene.requestRender();
      };
      scene.camera.changed.addEventListener(onCam);
      this.removeCameraChanged = () => scene.camera.changed.removeEventListener(onCam);
    }
    // Mirror moving icons (orbiting sats, gliding vessels, dead-reckoned aircraft)
    // and tick the emergency pulse on the scene's OWN render cadence — when the
    // clock animates, requestRenderMode + maximumRenderTimeChange:0 renders every
    // frame and preUpdate fires there, so we add NO forced renders and idle to
    // zero when the clock is paused (requestRenderMode keeps the GPU quiet).
    if (opts.shouldAnimate || opts.pulse) {
      this.removePreUpdate = scene.preUpdate.addEventListener(() => this.onPreUpdate());
    }
    // Re-dim every icon ONCE when the map filter changes, instead of the adapter
    // re-styling all ~13k contacts on every poll while a filter is active (the
    // "filter toggle freezes the map" spike). With this, the adapter's
    // unchanged-position skip can run filter-independently — a stationary contact
    // is never re-synced just to keep its dim correct; the dim is corrected here.
    if (opts.filter) {
      this.removeFilterSub = useFilters.subscribe((st, prev) => {
        if (st.clauses !== prev.clauses) this.reapplyDim();
      });
    }
  }

  // Recompute the filter dim of every icon from its last-synced props and update
  // only the billboards whose dim actually changed. O(n) but runs once per filter
  // toggle, not once per poll. (Cesium's color setter no-ops an unchanged value,
  // so the guard is mostly to skip the allocation + requestRender when nothing
  // flipped.)
  private reapplyDim(): void {
    if (!this.opts.filter) return;
    const clauses = useFilters.getState().clauses;
    const active = clauses.length > 0;
    let changed = false;
    for (const p of this.prims.values()) {
      const dim = active && !entityPassesFilter(p.props, clauses) ? FILTER_DIM_ALPHA : 1;
      if (dim === p.dimFactor) continue;
      p.dimFactor = dim;
      changed = true;
      if (!(this.opts.pulse && p.emergency)) p.bb.color = p.tint.withAlpha(this.layerOpacity * dim);
    }
    if (changed) this.scene.requestRender();
  }

  private posOf(entity: Cesium.Entity): Cesium.Cartesian3 | undefined {
    try {
      return entity.position?.getValue(this.opts.getClock()) as Cesium.Cartesian3 | undefined;
    } catch {
      return undefined;
    }
  }

  private dimFactorFor(props: Record<string, unknown>): number {
    if (!this.opts.filter) return 1;
    const clauses = useFilters.getState().clauses;
    return clauses.length > 0 && !entityPassesFilter(props, clauses) ? FILTER_DIM_ALPHA : 1;
  }

  // §5.5: should this contact's label be materialized right now? Inside the ddc
  // draw window (< 400 km) always; selected + emergency contacts always (cheap
  // insurance — the label spec is preserved for every contact via labelFn).
  private wantLabel(id: string, emergency: boolean): boolean {
    if (emergency) return true;
    if (useSelection.getState().selectedEntityId === id) return true;
    return this.scene.camera.positionCartographic.height < LABEL_MATERIALIZE_ALT_M;
  }

  // Upsert the icon + label for one contact entity. Position is read from the
  // entity, so teleport / glide / orbit all Just Work.
  sync(entity: Cesium.Entity, props: Record<string, unknown>): void {
    const id = String(entity.id);
    const pos = this.posOf(entity);
    if (!pos) return;
    const s = this.opts.styleFn(props);
    const tint = s.color ?? Cesium.Color.WHITE;
    const rot = s.rotationRad ?? 0;
    const dimFactor = this.dimFactorFor(props);
    const labelText = this.opts.labelFn(props);
    // §5.3.3: only run sideStyleFn when tilt (stand-up) mode is actually active —
    // the default top-down view never shows the side sprite, so computing it every
    // sync for ~13k moved contacts was wasted. applyTiltToAll() lazily computes +
    // caches the side sprite the moment tilt engages.
    const side = this.opts.sideStyleFn && this.tiltActive ? this.opts.sideStyleFn(props) : null;

    let p = this.prims.get(id);
    if (!p) {
      const bb = this.bbColl.add({
        ...this.opts.billboardBase(),
        position: pos,
        image: s.imageUri,
        scale: s.scale,
        rotation: rot,
        color: tint.withAlpha(this.layerOpacity * dimFactor),
        // Picking: GlobeCanvas reads picked.id.id, so wrap the string id in an
        // object exactly like a Cesium.Entity exposes entity.id.
        id: { id },
      });
      let lbl: Cesium.Label | null = null;
      if (labelText && this.wantLabel(id, !!s.emergency))
        lbl = this.lblColl.add({ ...this.opts.labelBase(labelText), position: pos, id: { id } });
      p = {
        bb, lbl, entity, props, emergency: !!s.emergency, dimFactor, labelText, tint,
        topImage: s.imageUri, topRot: rot, topScale: s.scale,
        sideImage: side?.imageUri ?? null, sideScale: side?.scale ?? s.scale,
      };
      this.prims.set(id, p);
      if (side) this.orient(p, pos); // apply current tilt mode to the new icon
    } else {
      p.entity = entity;
      p.props = props;
      p.tint = tint;
      p.bb.position = pos;
      p.topImage = s.imageUri;
      p.topRot = rot;
      p.topScale = s.scale;
      if (side) { p.sideImage = side.imageUri; p.sideScale = side.scale; }
      if (side) {
        // Stand-up layer: orient() owns image / rotation / scale per tilt mode.
        this.orient(p, pos);
      } else {
        if (p.bb.image !== s.imageUri) p.bb.image = s.imageUri;
        if (Math.abs(p.bb.rotation - rot) >= ROT_EPSILON) p.bb.rotation = rot;
        if (Math.abs(p.bb.scale - s.scale) >= SCALE_EPSILON) p.bb.scale = s.scale;
      }
      p.dimFactor = dimFactor;
      // Non-emergency colour is static here; emergency colour is owned by the
      // pulse rAF so we don't fight it every sync.
      if (!(this.opts.pulse && s.emergency)) p.bb.color = tint.withAlpha(this.layerOpacity * dimFactor);
      // §5.5: materialize the Cesium Label only inside the ddc draw window (or for
      // selected/emergency). Beyond it, destroy the label so world view holds ~0
      // labels. Recreated lazily on zoom-in — same visible set as today.
      if (labelText && this.wantLabel(id, !!s.emergency)) {
        if (!p.lbl) p.lbl = this.lblColl.add({ ...this.opts.labelBase(labelText), position: pos, id: { id } });
        else {
          p.lbl.position = pos;
          if (p.labelText !== labelText) p.lbl.text = labelText;
        }
      } else if (p.lbl) {
        this.lblColl.remove(p.lbl);
        p.lbl = null;
      }
      p.labelText = labelText;
      p.emergency = !!s.emergency;
    }
    if (this.opts.pulse && s.emergency) this.emergencyIds.add(id);
    else this.emergencyIds.delete(id);
    this.syncPulseNeed();
  }

  // Keep the render governor rendering every frame while any emergency pulse is
  // live on this layer. Only touches the registry on a transition (not per sync).
  private syncPulseNeed(): void {
    const need = this.opts.pulse === true && this.emergencyIds.size > 0;
    if (need !== this.lastPulseNeed) {
      this.lastPulseNeed = need;
      setRenderNeed(this.pulseNeedKey, need);
    }
  }

  remove(id: string): void {
    const p = this.prims.get(id);
    if (!p) return;
    this.bbColl.remove(p.bb);
    if (p.lbl) this.lblColl.remove(p.lbl);
    this.prims.delete(id);
    this.emergencyIds.delete(id);
    this.syncPulseNeed();
  }

  setLayerOpacity(a: number): void {
    this.layerOpacity = a;
    for (const p of this.prims.values()) {
      if (!(this.opts.pulse && p.emergency)) p.bb.color = p.tint.withAlpha(a * p.dimFactor);
    }
    this.scene.requestRender();
  }

  private computeTilt(): boolean {
    // pitch: −π/2 straight down → 0 at the horizon. Stand icons up only when
    // tilted past STANDUP_PITCH AND zoomed in below STANDUP_MAX_HEIGHT_M.
    const cam = this.scene.camera;
    return cam.pitch > STANDUP_PITCH && cam.positionCartographic.height < STANDUP_MAX_HEIGHT_M;
  }

  // Swap one icon between its flat top-down look and its upright side profile,
  // per the current tilt mode. Only called for stand-up layers (sideStyleFn set).
  private orient(p: Prim, pos: Cesium.Cartesian3): void {
    const bb = p.bb;
    if (this.tiltActive && p.sideImage) {
      // Billboard up = local geodetic up → the sprite stands vertically on its
      // point and rotates around up to face the camera, so a tilt shows its side.
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, _upScratch);
      if (up) bb.alignedAxis = up; // setter clones, so the scratch is safe to reuse
      bb.verticalOrigin = Cesium.VerticalOrigin.BOTTOM;
      if (bb.image !== p.sideImage) bb.image = p.sideImage;
      if (bb.rotation !== 0) bb.rotation = 0;
      if (Math.abs(bb.scale - p.sideScale) >= SCALE_EPSILON) bb.scale = p.sideScale;
    } else {
      // Restore the flat top-down look (the billboardBase orientation).
      bb.alignedAxis = Cesium.Cartesian3.UNIT_Z;
      bb.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      if (bb.image !== p.topImage) bb.image = p.topImage;
      if (Math.abs(bb.rotation - p.topRot) >= ROT_EPSILON) bb.rotation = p.topRot;
      if (Math.abs(bb.scale - p.topScale) >= SCALE_EPSILON) bb.scale = p.topScale;
    }
  }

  private applyTiltToAll(): void {
    const sideFn = this.opts.sideStyleFn;
    if (!sideFn) return;
    const t = this.opts.getClock();
    for (const p of this.prims.values()) {
      // §5.3.3: sync() skips sideStyleFn while tilt is off, so a prim first seen
      // in top-down view has no cached side sprite. Compute + cache it now that
      // tilt has engaged (recompute always so a category change since the last
      // stand-up is reflected).
      if (this.tiltActive) {
        const side = sideFn(p.props);
        p.sideImage = side.imageUri;
        p.sideScale = side.scale;
      }
      let pos: Cesium.Cartesian3 | undefined;
      try { pos = p.entity.position?.getValue(t) as Cesium.Cartesian3 | undefined; } catch { pos = undefined; }
      if (pos) this.orient(p, pos);
    }
  }

  destroy(): void {
    this.removePreUpdate?.();
    this.removePreUpdate = null;
    this.removeCameraChanged?.();
    this.removeCameraChanged = null;
    this.removeFilterSub?.();
    this.removeFilterSub = null;
    try { this.scene.primitives.remove(this.bbColl); } catch { /* viewer gone */ }
    try { this.scene.primitives.remove(this.lblColl); } catch { /* viewer gone */ }
    this.prims.clear();
    this.emergencyIds.clear();
    this.lastPulseNeed = false;
    setRenderNeed(this.pulseNeedKey, false);
  }

  // Runs once per render frame (only while the scene is actually rendering — i.e.
  // the clock is animating or something requested a render). Cheap early-out when
  // this layer has nothing moving and nothing pulsing.
  private onPreUpdate(): void {
    const animate = this.opts.shouldAnimate?.() ?? false;
    const pulsing = this.opts.pulse === true && this.emergencyIds.size > 0;
    if (!animate) this.wasAnimating = false;
    if (!animate && !pulsing) return;
    if (animate) {
      const t = this.opts.getClock();
      const now = performance.now();
      // Motion just started (zoom crossed the glide altitude / deadReckon toggled
      // on): force a full pass NOW so the visible set isn't empty for up to 500 ms.
      if (!this.wasAnimating) { this.wasAnimating = true; this.lastVisibleMs = 0; }
      // §5.4 animated-mirror LOD: the expensive part is getValue() on each prim's
      // SampledPositionProperty (interpolation) + the position writes. Every ~500 ms
      // do a FULL pass — refresh every prim (so off-screen ones stay ≤2 Hz fresh) and
      // rebuild the frustum-visible set. Between passes, mirror ONLY the visible set
      // each frame. On-screen motion is pixel-identical; off-screen (invisible) prims
      // just update at 2 Hz instead of 60 Hz. Cap the visible set at MAX_ANIMATED via
      // a djb2-stable order so a pathological "everything visible" case can't blow the
      // per-frame budget (stable = no churn, honouring the decimation-stability lesson).
      const fullPass = now - this.lastVisibleMs >= VISIBLE_RECOMPUTE_MS;
      if (fullPass) {
        this.lastVisibleMs = now;
        this.visibleIds.clear();
        const cam = this.scene.camera;
        const cv = cam.frustum.computeCullingVolume(cam.positionWC, cam.directionWC, cam.upWC);
        for (const [id, p] of this.prims) {
          let pos: Cesium.Cartesian3 | undefined;
          try { pos = p.entity.position?.getValue(t) as Cesium.Cartesian3 | undefined; } catch { pos = undefined; }
          if (!pos) continue;
          p.bb.position = pos;
          if (p.lbl) p.lbl.position = pos;
          _cullSphere.center = pos;
          _cullSphere.radius = 6000; // icon envelope so edge prims aren't culled early
          if (cv.computeVisibility(_cullSphere) !== Cesium.Intersect.OUTSIDE) {
            if (this.visibleIds.size < MAX_ANIMATED) this.visibleIds.add(id);
          }
        }
        perfSetAnimated(this.visibleIds.size);
      } else {
        for (const id of this.visibleIds) {
          const p = this.prims.get(id);
          if (!p) continue;
          let pos: Cesium.Cartesian3 | undefined;
          try { pos = p.entity.position?.getValue(t) as Cesium.Cartesian3 | undefined; } catch { pos = undefined; }
          if (pos) { p.bb.position = pos; if (p.lbl) p.lbl.position = pos; }
        }
      }
    }
    if (pulsing) {
      const a = 0.6 + 0.4 * Math.abs(Math.sin(Date.now() / 250)); // matches the old CallbackProperty
      for (const id of this.emergencyIds) {
        const p = this.prims.get(id);
        if (p) p.bb.color = Cesium.Color.fromCssColorString(EMERGENCY_RED).withAlpha(a * this.layerOpacity * p.dimFactor);
      }
    }
  }
}
