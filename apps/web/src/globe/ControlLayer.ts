import * as Cesium from 'cesium';
import { useControl, factionColor, type ControlZone, type FrontLine } from '../situations/controlStore.js';
import { hatchMaterial } from './hatch.js';

// Renders the territorial-control store — controlled/contested AREAS as 45°-hatched
// polygons and FRONT LINES as solid (confirmed) / dashed (contested) polylines, with
// labels. Own CustomDataSource, rebuilt on every store change. Same install pattern as
// installAnnotations; mounted once by GlobeCanvas. Full rebuild is fine: this is a
// small hand-drawn/imported set, NOT the guarded live-entity upsert path.

function centroid(ring: [number, number][]): [number, number] {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

function labelGraphics(text: string, color: Cesium.Color): Cesium.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: '600 11px "IBM Plex Mono", monospace',
    fillColor: color,
    outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
    outlineWidth: 2,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString('#0c0e11').withAlpha(0.78),
    backgroundPadding: new Cesium.Cartesian2(6, 3),
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
  };
}

export function installControl(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource('__control');
  void viewer.dataSources.add(ds);

  const addZone = (z: ControlZone): void => {
    if (z.ring.length < 3) return;
    const cssColor = factionColor(useControl.getState().factions, z.factionId);
    const color = Cesium.Color.fromCssColorString(cssColor);
    const contested = z.status === 'contested';
    ds.entities.add({
      id: z.id,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(
          Cesium.Cartesian3.fromDegreesArray(z.ring.flat()),
        ),
        material: hatchMaterial(cssColor, contested),
        outline: true,
        outlineColor: color.withAlpha(contested ? 0.7 : 1),
        height: 0,
        classificationType: Cesium.ClassificationType.TERRAIN,
      },
    });
    const [clon, clat] = centroid(z.ring);
    const text = [z.label, contested ? '(contested)' : null, z.conditions ? `· ${z.conditions}` : null]
      .filter(Boolean)
      .join(' ');
    if (text) {
      ds.entities.add({
        id: `${z.id}:lbl`,
        position: Cesium.Cartesian3.fromDegrees(clon, clat),
        label: labelGraphics(text, color),
      });
    }
  };

  const addLine = (l: FrontLine): void => {
    if (l.coords.length < 2) return;
    const contested = l.status === 'contested';
    const positions = Cesium.Cartesian3.fromDegreesArray(l.coords.flat());
    ds.entities.add({
      id: l.id,
      polyline: {
        positions,
        width: 4,
        clampToGround: true,
        arcType: Cesium.ArcType.GEODESIC,
        material: contested
          ? new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#f59e0b'),
              dashLength: 12,
            })
          : new Cesium.PolylineOutlineMaterialProperty({
              color: Cesium.Color.fromCssColorString('#e5e7eb'),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: 2,
            }),
      },
    });
    if (l.label) {
      const mid = l.coords[Math.floor(l.coords.length / 2)]!;
      ds.entities.add({
        id: `${l.id}:lbl`,
        position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1]),
        label: labelGraphics(l.label, Cesium.Color.fromCssColorString(contested ? '#f59e0b' : '#e5e7eb')),
      });
    }
  };

  const rebuild = (): void => {
    if (viewer.isDestroyed()) return;
    ds.entities.removeAll();
    const s = useControl.getState();
    for (const z of s.zones) addZone(z);
    for (const l of s.lines) addLine(l);
    viewer.scene.requestRender();
  };

  rebuild();
  const unsub = useControl.subscribe(rebuild);

  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
