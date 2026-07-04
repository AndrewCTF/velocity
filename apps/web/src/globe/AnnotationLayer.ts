import * as Cesium from 'cesium';
import { useAnnotations, THREAT_COLOR, type Annotation } from '../annotations/annotationStore.js';

// Renders the annotation store (points / lines / circles + labels) into its own
// CustomDataSource and re-renders on every store change. Same install pattern as
// SpotlightLayer; mounted once by GlobeCanvas.

function label(text: string, color: Cesium.Color): Cesium.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: '600 11px "IBM Plex Mono", monospace',
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

export function installAnnotations(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__annotations');
  void viewer.dataSources.add(ds);

  const add = (a: Annotation): void => {
    const color = Cesium.Color.fromCssColorString(THREAT_COLOR[a.threat]);
    if (a.kind === 'point' && a.coords?.[0]) {
      const [lon, lat] = a.coords[0];
      const opts: Cesium.Entity.ConstructorOptions = {
        id: a.id,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 11,
          color: color.withAlpha(0.85),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.9),
          outlineWidth: 1.5,
          // Depth-tested so the globe occludes a far-side annotation point.
        },
      };
      if (a.label) opts.label = label(a.label, color);
      ds.entities.add(opts);
    } else if (a.kind === 'line' && a.coords && a.coords.length >= 2) {
      ds.entities.add({
        id: a.id,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(a.coords.flat()),
          width: 3,
          material: color,
          clampToGround: true,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
      const mid = a.coords[Math.floor(a.coords.length / 2)]!;
      if (a.label) {
        ds.entities.add({
          id: `${a.id}:lbl`,
          position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
          label: label(a.label, color),
        });
      }
    } else if (a.kind === 'circle' && a.center && a.radiusKm) {
      const opts: Cesium.Entity.ConstructorOptions = {
        id: a.id,
        position: Cesium.Cartesian3.fromDegrees(a.center.lon, a.center.lat),
        ellipse: {
          semiMajorAxis: a.radiusKm * 1000,
          semiMinorAxis: a.radiusKm * 1000,
          material: color.withAlpha(0.08),
          outline: true,
          outlineColor: color,
          outlineWidth: 2,
          height: 0,
        },
      };
      if (a.label) opts.label = label(a.label, color);
      ds.entities.add(opts);
    }
  };

  const rebuild = (): void => {
    if (viewer.isDestroyed()) return;
    ds.entities.removeAll();
    for (const a of useAnnotations.getState().annotations) add(a);
    viewer.scene.requestRender();
  };

  rebuild();
  const unsub = useAnnotations.subscribe(rebuild);

  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
