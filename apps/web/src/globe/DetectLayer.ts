import * as Cesium from 'cesium';
import { useDetections, type Detection } from '../state/detections.js';

// Renders the imagery-CV detections store. Same cheap shape as CaptureLayer: one
// CustomDataSource, UPSERT-BY-ID (never removeAll+add), SVG billboards (never
// dots), STATIC positions (no per-frame mirror). Selection works via the entity
// id; the id prefix `detect:` routes to the OSINT-less generic panel.

const COLOR = '#38bdf8'; // cyan — distinct from vessel/aircraft/capture palettes

const iconCache = new Map<string, string>();
function iconFor(color: string): string {
  let uri = iconCache.get(color);
  if (!uri) {
    // Small hollow square with a centre dot — a "detected object" marker.
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'>` +
      `<rect x='3' y='3' width='16' height='16' fill='none' stroke='${color}' stroke-width='2'/>` +
      `<circle cx='11' cy='11' r='2.2' fill='${color}'/></svg>`;
    uri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    iconCache.set(color, uri);
  }
  return uri;
}

function bagFor(d: Detection): Cesium.PropertyBag {
  return new Cesium.PropertyBag({
    kind: 'detection',
    source: d.source,
    cls: d.cls,
    conf: d.conf,
    date: d.date,
    label: `${d.cls} ${(d.conf * 100).toFixed(0)}%`,
    lat: d.lat,
    lon: d.lon,
  });
}

export function installDetections(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__detections');
  void viewer.dataSources.add(ds);

  const sync = (): void => {
    if (viewer.isDestroyed()) return;
    const list = useDetections.getState().detections;
    const seen = new Set<string>();
    const img = iconFor(COLOR);

    for (const d of list) {
      seen.add(d.id);
      const txt = `${d.cls} ${(d.conf * 100).toFixed(0)}%`;
      let e = ds.entities.getById(d.id);
      if (!e) {
        e = ds.entities.add({
          id: d.id,
          position: Cesium.Cartesian3.fromDegrees(d.lon, d.lat),
          billboard: { image: img, scale: 1, verticalOrigin: Cesium.VerticalOrigin.CENTER },
          label: {
            text: txt,
            font: '600 11px "IBM Plex Mono", monospace',
            fillColor: Cesium.Color.fromCssColorString(COLOR),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(6, 3),
            pixelOffset: new Cesium.Cartesian2(0, -16),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2_000_000),
          },
        });
      } else if (e.label) {
        e.label.text = new Cesium.ConstantProperty(txt);
      }
      e.properties = bagFor(d);
    }

    for (const e of [...ds.entities.values]) {
      if (!seen.has(e.id)) ds.entities.remove(e);
    }
    viewer.scene.requestRender();
  };

  sync();
  const unsub = useDetections.subscribe(sync);

  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* already gone */
    }
  };
}
