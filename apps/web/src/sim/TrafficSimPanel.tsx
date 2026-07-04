// Traffic sim right-rail tab. Runs the cam → CUDA detect → animated-vehicles
// pipeline against the nearest public cam to the centre of the view. Desktop-only
// (the section self-gates); the website shows a caveat.
import type * as Cesium from 'cesium';
import { useCenter, CenterHeader } from '../globe/center.js';
import { TrafficSimSection } from './TrafficSimSection.js';

export function TrafficSimPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const v = viewer as Cesium.Viewer | null;
  const { center, sync } = useCenter(v);
  return (
    <div className="space-y-2">
      <CenterHeader center={center} onSync={sync} />
      <TrafficSimSection viewer={v} center={center} />
    </div>
  );
}
