import * as Cesium from "cesium";
import { useDetected } from "../situations/detectedStore.js";

// Footprint glow for the detected anchorage (Gotham situation pin: a red glow,
// not a selection ring). Own CustomDataSource, rebuilt on store change; one
// entity, so a full rebuild is fine and this is not the live-entity upsert path.
export function installDetected(viewer: Cesium.Viewer): () => void {
  const ds = new Cesium.CustomDataSource("__detected_situation");
  void viewer.dataSources.add(ds);
  const glow = Cesium.Color.fromCssColorString("#d93a46");

  const rebuild = (): void => {
    if (viewer.isDestroyed()) return;
    ds.entities.removeAll();
    const det = useDetected.getState().det;
    if (det) {
      ds.entities.add({
        id: "detected:footprint",
        position: Cesium.Cartesian3.fromDegrees(det.lon, det.lat),
        ellipse: {
          semiMajorAxis: det.r_km * 1000,
          semiMinorAxis: det.r_km * 1000,
          material: glow.withAlpha(0.22),
          outline: true,
          outlineColor: glow,
          height: 0,
        },
        label: {
          text: `${det.n} at anchor`,
          font: '600 11px "IBM Plex Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    viewer.scene.requestRender();
  };

  rebuild();
  const unsub = useDetected.subscribe(rebuild);
  return () => {
    unsub();
    try {
      viewer.dataSources.remove(ds, true);
    } catch {
      /* gone */
    }
  };
}
