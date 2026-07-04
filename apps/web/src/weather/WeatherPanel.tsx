// Weather right-rail tab. Reads current conditions for the centre of the view
// (no AOI needed). Hit "use view" after panning to re-sample.
import type * as Cesium from 'cesium';
import { Widget, MicroLabel } from '../shell/instruments.js';
import { useCenter, CenterHeader } from '../globe/center.js';
import { WeatherCard } from './WeatherCard.js';

export function WeatherPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const { center, sync } = useCenter(viewer as Cesium.Viewer | null);
  return (
    <div className="space-y-2">
      <CenterHeader center={center} onSync={sync} />
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
