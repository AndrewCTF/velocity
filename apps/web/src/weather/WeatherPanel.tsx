// Weather right-rail tab. Reads current conditions for the centre of the view
// (no AOI needed). Hit "use view" after panning to re-sample.
import * as Cesium from "cesium";
import { create } from "zustand";
import { Widget, MicroLabel } from "../shell/instruments.js";
import { useCenter, CenterHeader } from "../globe/center.js";
import { WeatherCard } from "./WeatherCard.js";

// Precipitation radar over the globe: NASA GIBS IMERG half-hourly rate, the
// newest frame GIBS serves (`default` time). Keyless; Cesium fetches the tiles
// straight from GIBS, so nothing passes through apiFetch.
const IMERG =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png";

const useRadar = create<{
  layer: Cesium.ImageryLayer | null;
  set: (l: Cesium.ImageryLayer | null) => void;
}>((set) => ({ layer: null, set: (layer) => set({ layer }) }));

export function setRadar(viewer: Cesium.Viewer | null, on: boolean): void {
  const cur = useRadar.getState().layer;
  if (!viewer || viewer.isDestroyed()) return;
  if (!on) {
    if (cur) viewer.imageryLayers.remove(cur, true);
    useRadar.getState().set(null);
  } else if (!cur) {
    const layer = viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: IMERG,
        maximumLevel: 6,
        credit: "NASA GIBS · IMERG precipitation rate",
      }),
    );
    layer.alpha = 0.85;
    useRadar.getState().set(layer);
  }
  viewer.scene.requestRender();
}

export function WeatherPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const { center, sync } = useCenter(viewer as Cesium.Viewer | null);
  const radar = useRadar((s) => s.layer !== null);
  return (
    <div className="space-y-2">
      <CenterHeader center={center} onSync={sync} />
      <Widget title="Precipitation radar">
        <label className="flex items-center gap-2 text-[11px] text-txt-1">
          <input
            type="checkbox"
            checked={radar}
            onChange={(e) =>
              setRadar(viewer as Cesium.Viewer | null, e.target.checked)
            }
          />
          Show on the globe
        </label>
        <MicroLabel>NASA GIBS IMERG · newest half-hour frame</MicroLabel>
      </Widget>
      {center ? (
        <WeatherCard lat={center.lat} lon={center.lon} />
      ) : (
        <Widget title="Weather">
          <MicroLabel>pan the map, then “use view”</MicroLabel>
        </Widget>
      )}
    </div>
  );
}
