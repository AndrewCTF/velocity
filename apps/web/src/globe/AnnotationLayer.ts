import * as Cesium from 'cesium';
import {
  useAnnotations,
  annotationColor,
  annotationStyle,
  type Annotation,
} from '../annotations/annotationStore.js';

// Renders the annotation store into its own CustomDataSource.
//
// UPSERT BY ID — never removeAll() + add(). The old renderer rebuilt EVERY
// annotation entity on EVERY store change, which meant one keystroke in the
// label field (the panel's input fires update() per character) or one frame of
// a marker drag destroyed and recreated the whole layer. That is the same
// anti-pattern CLAUDE.md bans for PollGeoJsonAdapter; the invariant simply had
// never been extended to this file, which is why the regression was invisible.
// The eslint rule and globe/invariants.test.ts now cover it.

function labelGraphics(
  text: string,
  color: Cesium.Color,
  fontSize: number,
): Cesium.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: `600 ${fontSize}px "IBM Plex Mono", monospace`,
    fillColor: color,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
    backgroundPadding: new Cesium.Cartesian2(6, 3),
    pixelOffset: new Cesium.Cartesian2(0, -12),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    // Depth-tested so the globe occludes a far-side annotation label rather
    // than bleeding it through the opposite hemisphere.
  };
}

/** Ring for a sector: centre, then an arc from bearing-sweep/2 to bearing+sweep/2. */
function sectorRing(
  center: { lat: number; lon: number },
  radiusKm: number,
  bearingDeg: number,
  sweepDeg: number,
): Cesium.Cartesian3[] {
  const pts: Cesium.Cartesian3[] = [Cesium.Cartesian3.fromDegrees(center.lon, center.lat)];
  const steps = Math.max(8, Math.min(96, Math.round(sweepDeg / 3)));
  const half = sweepDeg / 2;
  const R = 6371.0088;
  const lat1 = (center.lat * Math.PI) / 180;
  const lon1 = (center.lon * Math.PI) / 180;
  const d = radiusKm / R;
  for (let i = 0; i <= steps; i++) {
    const brg = ((bearingDeg - half + (sweepDeg * i) / steps) * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    pts.push(Cesium.Cartesian3.fromDegrees((lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI));
  }
  return pts;
}

/** Arrowhead ring at the head of a two-point arrow, sized from the shaft. */
function arrowHead(coords: [number, number][]): Cesium.Cartesian3[] {
  const [tail, head] = [coords[0]!, coords[coords.length - 1]!];
  const dx = head[0] - tail[0];
  const dy = head[1] - tail[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const h = Math.min(len * 0.22, 3); // degrees — capped so a long arrow stays sane
  const w = h * 0.45;
  const baseX = head[0] - ux * h;
  const baseY = head[1] - uy * h;
  return Cesium.Cartesian3.fromDegreesArray([
    head[0], head[1],
    baseX - uy * w, baseY + ux * w,
    baseX + uy * w, baseY - ux * w,
  ]);
}

function dashPattern(dash: string): number | undefined {
  if (dash === 'dash') return 0b1111000011110000;
  if (dash === 'dot') return 0b1010101010101010;
  return undefined;
}

function buildEntity(a: Annotation): Cesium.Entity.ConstructorOptions | null {
  const st = annotationStyle(a);
  const color = Cesium.Color.fromCssColorString(annotationColor(a));
  const stroke = color.withAlpha(st.opacity);
  const fill = color.withAlpha(st.fillOpacity);
  const pattern = dashPattern(st.dash);
  const lineMaterial = pattern
    ? new Cesium.PolylineDashMaterialProperty({ color: stroke, dashPattern: pattern })
    : (stroke as unknown as Cesium.MaterialProperty);

  const base: Cesium.Entity.ConstructorOptions = { id: a.id };
  const withLabel = (o: Cesium.Entity.ConstructorOptions): Cesium.Entity.ConstructorOptions => {
    if (a.label) o.label = labelGraphics(a.label, color, st.fontSize);
    return o;
  };

  switch (a.kind) {
    case 'point':
    case 'symbol':
    case 'text': {
      const c = a.coords?.[0];
      if (!c) return null;
      const o: Cesium.Entity.ConstructorOptions = {
        ...base,
        position: Cesium.Cartesian3.fromDegrees(c[0], c[1]),
      };
      if (a.kind === 'symbol' && a.symbolSvg) {
        o.billboard = {
          image: a.symbolSvg,
          scale: 1,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        };
      } else if (a.kind !== 'text') {
        o.point = {
          pixelSize: st.pointSize,
          color: color.withAlpha(st.opacity),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
          outlineWidth: st.outline ? 1.5 : 0,
        };
      }
      // A text annotation is its label — always show it, even unlabelled, so a
      // freshly placed one is visible and editable rather than invisible.
      if (a.kind === 'text') {
        o.label = labelGraphics(a.label || 'text', color, st.fontSize);
        return o;
      }
      return withLabel(o);
    }
    case 'line':
    case 'freehand': {
      if (!a.coords || a.coords.length < 2) return null;
      return {
        ...base,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(a.coords.flat()),
          width: st.width,
          material: lineMaterial,
          clampToGround: true,
          arcType: Cesium.ArcType.GEODESIC,
        },
      };
    }
    case 'arrow': {
      if (!a.coords || a.coords.length < 2) return null;
      return {
        ...base,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(a.coords.flat()),
          width: st.width,
          material: lineMaterial,
          clampToGround: true,
          arcType: Cesium.ArcType.GEODESIC,
        },
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(arrowHead(a.coords)),
          material: fill.withAlpha(Math.max(st.fillOpacity, 0.6)),
          outline: st.outline,
          outlineColor: stroke,
          height: 0,
        },
      };
    }
    case 'polygon':
    case 'rect':
    case 'corridor': {
      if (!a.coords || a.coords.length < 3) return null;
      return withLabel({
        ...base,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(a.coords.flat()),
          ),
          material: fill,
          outline: st.outline,
          outlineColor: stroke,
          outlineWidth: st.width,
          height: 0,
        },
      });
    }
    case 'circle': {
      if (!a.center || !a.radiusKm) return null;
      return withLabel({
        ...base,
        position: Cesium.Cartesian3.fromDegrees(a.center.lon, a.center.lat),
        ellipse: {
          semiMajorAxis: a.radiusKm * 1000,
          semiMinorAxis: a.radiusKm * 1000,
          material: fill,
          outline: st.outline,
          outlineColor: stroke,
          outlineWidth: st.width,
          height: 0,
        },
      });
    }
    case 'sector': {
      if (!a.center || !a.radiusKm) return null;
      return withLabel({
        ...base,
        position: Cesium.Cartesian3.fromDegrees(a.center.lon, a.center.lat),
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            sectorRing(a.center, a.radiusKm, a.bearingDeg ?? 0, a.sweepDeg ?? 60),
          ),
          material: fill,
          outline: st.outline,
          outlineColor: stroke,
          height: 0,
        },
      });
    }
    default:
      return null;
  }
}

export function installAnnotations(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__annotations');
  void viewer.dataSources.add(ds);
  const seen = new Set<string>();

  const sync = (): void => {
    if (viewer.isDestroyed()) return;
    seen.clear();
    ds.entities.suspendEvents();
    for (const a of useAnnotations.getState().annotations) {
      if (a.hidden) continue;
      const opts = buildEntity(a);
      if (!opts) continue;
      seen.add(a.id);
      const existing = ds.entities.getById(a.id);
      if (existing) {
        // Rebuild the graphics in place. The entity object — and therefore any
        // selection, picking or camera-tracking reference held elsewhere —
        // survives, which is the whole point of upserting.
        // buildEntity always returns plain ConstructorOptions, never Graphics
        // instances, so these casts are describing what is already true — the
        // Entity setters accept the union and TS cannot narrow it here.
        type Opts<T> = T extends object ? T : never;
        existing.position = (opts.position as Cesium.PositionProperty | undefined) ?? undefined;
        existing.point = opts.point
          ? new Cesium.PointGraphics(opts.point as Opts<Cesium.PointGraphics.ConstructorOptions>)
          : undefined;
        existing.billboard = opts.billboard
          ? new Cesium.BillboardGraphics(
              opts.billboard as Opts<Cesium.BillboardGraphics.ConstructorOptions>,
            )
          : undefined;
        existing.polyline = opts.polyline
          ? new Cesium.PolylineGraphics(
              opts.polyline as Opts<Cesium.PolylineGraphics.ConstructorOptions>,
            )
          : undefined;
        existing.polygon = opts.polygon
          ? new Cesium.PolygonGraphics(
              opts.polygon as Opts<Cesium.PolygonGraphics.ConstructorOptions>,
            )
          : undefined;
        existing.ellipse = opts.ellipse
          ? new Cesium.EllipseGraphics(
              opts.ellipse as Opts<Cesium.EllipseGraphics.ConstructorOptions>,
            )
          : undefined;
        existing.label = opts.label
          ? new Cesium.LabelGraphics(opts.label as Opts<Cesium.LabelGraphics.ConstructorOptions>)
          : undefined;
      } else {
        ds.entities.add(opts);
      }
      // Line/freehand/arrow carry their label on a separate entity at the
      // midpoint, since a polyline has no anchor position of its own.
      if ((a.kind === 'line' || a.kind === 'freehand' || a.kind === 'arrow') && a.label && a.coords) {
        const mid = a.coords[Math.floor(a.coords.length / 2)]!;
        const lid = `${a.id}:lbl`;
        seen.add(lid);
        const st = annotationStyle(a);
        const color = Cesium.Color.fromCssColorString(annotationColor(a));
        const existingLbl = ds.entities.getById(lid);
        if (existingLbl) {
          existingLbl.position = new Cesium.ConstantPositionProperty(
            Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
          );
          existingLbl.label = new Cesium.LabelGraphics(
            labelGraphics(a.label, color, st.fontSize),
          );
        } else {
          ds.entities.add({
            id: lid,
            position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
            label: labelGraphics(a.label, color, st.fontSize),
          });
        }
      }
    }
    // Collect BEFORE removing — mutating entities while iterating .values is
    // the classic Cesium footgun.
    const gone: Cesium.Entity[] = [];
    for (const e of ds.entities.values) if (!seen.has(e.id)) gone.push(e);
    for (const e of gone) ds.entities.remove(e);
    ds.entities.resumeEvents();
    viewer.scene.requestRender();
  };

  sync();
  const unsub = useAnnotations.subscribe(sync);

  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
