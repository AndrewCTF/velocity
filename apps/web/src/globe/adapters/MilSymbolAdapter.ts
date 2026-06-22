// MIL-STD-2525 Common Operational Picture layer (mil.cop.* ids).
//
// Renders a NOTIONAL ground laydown — unit symbols (milsymbol → MIL-STD-2525,
// with echelon ticks + unit designations rendered ON the symbol), FLOT / phase
// polylines, and an AO range-ring — into its OWN CustomDataSource. It does NOT
// touch the aircraft/vessel SVG dispatch (styles.ts) or the live adapters: it is
// a self-contained overlay, same pattern as SatelliteAdapter. Data is
// illustrative (cop/notionalCop.ts), labelled as such.

import * as Cesium from 'cesium';
import ms from 'milsymbol';
import type { LayerAdapter, AdapterCtx } from './types.js';
import { type CopUnit } from '../../cop/notionalCop.js';
import { useCop } from '../../cop/copStore.js';

const FRIENDLY = '#5b9bd5';
const HOSTILE = '#e8584e';
const RING = '#f59e0b';
// COP symbols are a regional overlay — show within ~1500 km of the camera so
// they read at AO zoom and don't clutter / oversize at world view.
const SHOW_WITHIN_M = 1_500_000;
const SYMBOL_SCALE = 0.62;

// Build a milsymbol unit: proper 2525 frame + echelon (from the SIDC) + the unit
// designation / higher formation rendered as text modifiers ON the symbol. We
// return the canvas + its anchor so the billboard can pin the icon's reference
// point (not the text-extended bounding-box centre) onto the geo position.
function unitSymbol(u: CopUnit): { image: HTMLCanvasElement; anchor: { x: number; y: number } } {
  const sym = new ms.Symbol(u.sidc, {
    size: 30,
    uniqueDesignation: u.designation,
    ...(u.higher ? { higherFormation: u.higher } : {}),
  });
  return { image: sym.asCanvas(), anchor: sym.getAnchor() };
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)] ?? coords[0]!;
}

export class MilSymbolAdapter implements LayerAdapter {
  ds: Cesium.CustomDataSource;
  private detached = false;
  private viewer: Cesium.Viewer | null = null;
  private unsub: (() => void) | null = null;

  constructor(private readonly props: { ctx: AdapterCtx }) {
    this.ds = new Cesium.CustomDataSource(props.ctx.descriptor.id);
  }

  async attach(viewer: Cesium.Viewer): Promise<void> {
    await viewer.dataSources.add(this.ds);
    if (this.detached || viewer.isDestroyed()) return;
    this.viewer = viewer;
    this.rebuild();
    // Re-render in place whenever the COP editor mutates the laydown.
    this.unsub = useCop.subscribe(() => this.rebuild());
  }

  // Rebuild every entity from the editable COP store. Called on attach and on
  // every store change. removeAll + re-add is fine here: the COP is a small,
  // human-edited laydown (tens of symbols), not a high-frequency live feed.
  private rebuild(): void {
    const viewer = this.viewer;
    if (this.detached || !viewer || viewer.isDestroyed()) return;
    this.ds.entities.removeAll();
    const id = this.ds.name;
    const ddc = new Cesium.DistanceDisplayCondition(0, SHOW_WITHIN_M);
    const cop = useCop.getState();

    // AO range-ring(s) — translucent fill + outline + label.
    for (const r of cop.rings) {
      const c = Cesium.Color.fromCssColorString(RING);
      this.ds.entities.add({
        id: `${id}:ring:${r.id}`,
        position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
        ellipse: {
          semiMajorAxis: r.radiusKm * 1000,
          semiMinorAxis: r.radiusKm * 1000,
          material: c.withAlpha(0.05),
          outline: true,
          outlineColor: c.withAlpha(0.65),
          outlineWidth: 2,
          height: 0,
        },
        label: {
          text: r.label,
          font: '600 10px "IBM Plex Mono", monospace',
          fillColor: c,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.7),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -8),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: ddc,
        },
      });
    }

    // FLOT / phase lines — thick, dashed, with a midpoint label.
    for (const ln of cop.lines) {
      if (ln.coords.length < 2) continue;
      const color = Cesium.Color.fromCssColorString(ln.side === 'hostile' ? HOSTILE : FRIENDLY);
      this.ds.entities.add({
        id: `${id}:line:${ln.id}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(ln.coords.flat()),
          width: 4,
          clampToGround: false,
          material: new Cesium.PolylineDashMaterialProperty({
            color,
            gapColor: color.withAlpha(0.15),
            dashLength: 18,
          }),
        },
      });
      const [mlon, mlat] = midpoint(ln.coords);
      this.ds.entities.add({
        id: `${id}:line:${ln.id}:lbl`,
        position: Cesium.Cartesian3.fromDegrees(mlon, mlat),
        label: {
          text: ln.label,
          font: '600 11px "IBM Plex Mono", monospace',
          fillColor: color,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: ddc,
        },
      });
    }

    // Units — MIL-STD-2525 framed symbols (echelon + designation baked in).
    for (const u of cop.units) {
      const { image, anchor } = unitSymbol(u);
      this.ds.entities.add({
        id: `${id}:unit:${u.id}`,
        position: Cesium.Cartesian3.fromDegrees(u.lon, u.lat),
        billboard: {
          image,
          scale: SYMBOL_SCALE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          // pin the icon's milsymbol anchor onto the position (offset is in
          // screen px = anchor × the fixed billboard scale).
          pixelOffset: new Cesium.Cartesian2(-anchor.x * SYMBOL_SCALE, -anchor.y * SYMBOL_SCALE),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: ddc,
        },
      });
    }

    viewer.scene.requestRender();
  }

  detach(): void {
    this.detached = true;
    this.unsub?.();
    this.unsub = null;
    try {
      this.props.ctx.viewer.dataSources.remove(this.ds, true);
    } catch {
      /* viewer already torn down */
    }
  }
}
