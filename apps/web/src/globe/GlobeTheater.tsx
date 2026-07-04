import { useEffect } from 'react';
import * as Cesium from 'cesium';
import { chokepoints, type Chokepoint } from '../registry/chokepoints.js';

// AOI theater overlay — draws the watched strategic chokepoints as translucent
// boxes + labels on the globe (the mockup's red/amber AOI frames). These are
// REAL saved areas (registry/chokepoints.ts); tier colour follows each area's
// typical daily transits, so the framing reflects strategic weight, not a
// fabricated threat. Static geometry in its own CustomDataSource — it never
// touches the live aircraft/vessel layers or their optimisation.

interface Props {
  viewer: Cesium.Viewer | null;
}

function tierColor(c: Chokepoint): Cesium.Color {
  const t = c.daily_transits ?? 0;
  if ((c.oil_flow_mbpd ?? 0) >= 10 || t >= 150) return Cesium.Color.fromCssColorString('#ff5a52'); // hi
  if (t >= 60) return Cesium.Color.fromCssColorString('#f5a524'); // md
  return Cesium.Color.fromCssColorString('#566377'); // lo
}

export function GlobeTheater({ viewer }: Props): null {
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const ds = new Cesium.CustomDataSource('aoi-theater');
    void viewer.dataSources.add(ds);

    for (const c of chokepoints) {
      const [w, s, e, n] = c.bbox;
      const color = tierColor(c);
      const rect = Cesium.Rectangle.fromDegrees(w, s, e, n);
      // Translucent fill + outline frame for the watch box.
      ds.entities.add({
        name: c.name,
        rectangle: {
          coordinates: rect,
          material: color.withAlpha(0.05),
          height: 0,
          outline: true,
          outlineColor: color.withAlpha(0.85),
          outlineWidth: 1,
        },
      });
      // Corner label (callsign-style mono pill), pinned to the NW corner.
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(w, n),
        label: {
          text: `${c.name.toUpperCase()}`,
          font: '600 10px "IBM Plex Mono", monospace',
          fillColor: color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(2, -3),
          // Keep the theater labels readable but unobtrusive: only when the
          // box is reasonably large on screen (zoomed toward a region).
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6_000_000),
          translucencyByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 6e6, 0.0),
          // Depth-tested (no disableDepthTestDistance) so the globe OCCLUDES a
          // chokepoint label on the far side instead of it bleeding through to
          // the opposite hemisphere.
        },
      });
    }
    viewer.scene.requestRender();

    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    };
  }, [viewer]);

  return null;
}
