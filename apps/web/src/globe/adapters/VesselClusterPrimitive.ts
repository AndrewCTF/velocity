import * as Cesium from 'cesium';

// World-view vessel count bubbles — the replacement for Cesium EntityCluster.
//
// Cesium's clustering aggregates per-ENTITY billboards; once vessels render as
// batched primitives off graphics-less entities there are no entity billboards
// to cluster, so the "smeared green blob vs teal count bubbles" world-view UX
// would be lost. This reproduces it: on camera moveEnd, above the individual-
// icon range, grid-bin the vessel positions into teal count bubbles; below it,
// clear them so the individual primitive icons (their own ddc fades them in
// 150→600 km) stand alone. Same teal ring + minimumClusterSize=16 floor as the
// old configureVesselClustering, so the operator sees the same picture.
//
// ponytail: geo-grid binning sized by camera altitude approximates Cesium's
// screen-pixelRange clustering — good enough for "where are the ships" at world
// view. Upgrade to true screen-space binning only if the cells read wrong.

const SHOW_BELOW_M = 600_000; // individual vessel icon ddc ceiling — below this, no bubbles
const FADE_FULL_M = 650_000; // bubbles fully opaque at/above here (cross-fade band 350→650 km)
const FADE_GONE_M = 350_000;
const MIN_CLUSTER = 16; // matches the old EntityCluster minimumClusterSize floor

let cachedRing: string | null = null;
function vesselClusterRing(): string {
  if (cachedRing) return cachedRing;
  const canvas = document.createElement('canvas');
  canvas.width = 28;
  canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.beginPath();
    ctx.arc(14, 14, 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.55)'; // teal #34d399 @ 55%
    ctx.fill();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = '#0b0e14';
    ctx.stroke();
  }
  cachedRing = canvas.toDataURL('image/png');
  return cachedRing;
}

export class VesselClusterPrimitive {
  private readonly bb: Cesium.BillboardCollection;
  private readonly lbl: Cesium.LabelCollection;
  private readonly removeMove: () => void;
  private readonly ring = vesselClusterRing();

  constructor(
    private readonly viewer: Cesium.Viewer,
    // Live vessel positions (lon/lat) — read from the owning adapter's entities.
    private readonly getPositions: () => Array<{ lon: number; lat: number }>,
  ) {
    const scene = viewer.scene;
    this.bb = new Cesium.BillboardCollection({ scene });
    this.lbl = new Cesium.LabelCollection({ scene });
    scene.primitives.add(this.bb);
    scene.primitives.add(this.lbl);
    const onMove = (): void => this.recompute();
    viewer.camera.moveEnd.addEventListener(onMove);
    this.removeMove = () => {
      if (!viewer.isDestroyed()) viewer.camera.moveEnd.removeEventListener(onMove);
    };
    this.recompute();
  }

  // Re-poll the cluster picture (call after a data refresh so new ships bin in
  // even without a camera move).
  refresh(): void {
    this.recompute();
  }

  private recompute(): void {
    if (this.viewer.isDestroyed()) return;
    this.bb.removeAll();
    this.lbl.removeAll();
    const h = this.viewer.camera.positionCartographic.height;
    if (h < SHOW_BELOW_M) {
      this.viewer.scene.requestRender();
      return;
    }
    // Cell size grows with altitude so bubbles stay ~constant on screen.
    const cellDeg = Math.min(15, Math.max(1, h / 3_000_000));
    const bins = new Map<string, { n: number; lon: number; lat: number }>();
    for (const p of this.getPositions()) {
      const cx = Math.floor(p.lon / cellDeg);
      const cy = Math.floor(p.lat / cellDeg);
      const key = `${cx},${cy}`;
      const b = bins.get(key);
      if (b) {
        b.n++;
        b.lon += p.lon;
        b.lat += p.lat;
      } else {
        bins.set(key, { n: 1, lon: p.lon, lat: p.lat });
      }
    }
    // Cross-fade with the individual icons (cluster opaque ≥650 km, gone ≤350 km).
    const alpha = Math.max(0, Math.min(1, (h - FADE_GONE_M) / (FADE_FULL_M - FADE_GONE_M)));
    for (const b of bins.values()) {
      if (b.n < MIN_CLUSTER) continue;
      const pos = Cesium.Cartesian3.fromDegrees(b.lon / b.n, b.lat / b.n);
      this.bb.add({
        position: pos,
        image: this.ring,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        color: Cesium.Color.WHITE.withAlpha(alpha),
      });
      this.lbl.add({
        position: pos,
        text: String(b.n),
        font: 'bold 11px "IBM Plex Mono", monospace',
        fillColor: Cesium.Color.WHITE.withAlpha(alpha),
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        // Depth-TESTED (no disableDepthTestDistance) so the globe occludes a
        // count bubble on the far hemisphere instead of it bleeding through the
        // earth — matches the ring billboard + event-icon behaviour.
      });
    }
    this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.removeMove();
    try { this.viewer.scene.primitives.remove(this.bb); } catch { /* gone */ }
    try { this.viewer.scene.primitives.remove(this.lbl); } catch { /* gone */ }
  }
}
