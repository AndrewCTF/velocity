import * as Cesium from "cesium";
import { useDetected } from "../situations/detectedStore.js";

// Footprint glow for the detected anchorage (Gotham situation pin: a red glow,
// not a selection ring). Own CustomDataSource, rebuilt on store change; one
// entity, so a full rebuild is fine and this is not the live-entity upsert path.
const PIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38"><path d="M15 37 C15 37 2 22 2 14 A13 13 0 0 1 28 14 C28 22 15 37 15 37 Z" fill="#e8414c" stroke="#fff" stroke-width="2"/><text x="15" y="20" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="15" fill="#fff">!</text></svg>',
  );

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
        // The situation pin: a red drop with "!" standing on the footprint.
        billboard: {
          image: PIN,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${det.n} vessels stationary`,
          font: '700 14px "Source Sans 3", "Segoe UI", sans-serif',
          horizontalOrigin: Cesium.HorizontalOrigin.RIGHT,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(-24, -6),
          // A pill, so the count reads over the ring's contact glows.
          showBackground: true,
          backgroundColor:
            Cesium.Color.fromCssColorString("#11181c").withAlpha(0.85),
          backgroundPadding: new Cesium.Cartesian2(6, 3),
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
