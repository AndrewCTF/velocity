// Map-centre location source for the promoted right-rail tabs (Weather, Cameras,
// Traffic sim, Splat). These used to require the right-click "Ground recon here"
// AOI; instead they read the geographic centre of the current view so they work
// the moment you open the tab — no AOI dance.
import { useCallback, useEffect, useState } from 'react';
import * as Cesium from 'cesium';
import { Btn } from '../shell/instruments.js';

export interface LatLon {
  lat: number;
  lon: number;
}

/** Geographic centre of the current view (screen-centre ray ∩ ellipsoid),
 *  falling back to the sub-camera point. null if the viewer isn't ready. */
export function viewerCenter(viewer: Cesium.Viewer | null): LatLon | null {
  if (!viewer) return null;
  try {
    const canvas = viewer.scene.canvas;
    const mid = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const hit = viewer.camera.pickEllipsoid(mid, viewer.scene.globe.ellipsoid);
    const carto = hit ? Cesium.Cartographic.fromCartesian(hit) : viewer.camera.positionCartographic;
    return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) };
  } catch {
    return null;
  }
}

/** Tracks a {lat,lon} sampled from the view; `sync()` re-samples on demand.
 *  Samples once when the viewer first becomes ready. */
export function useCenter(viewer: Cesium.Viewer | null): { center: LatLon | null; sync: () => void } {
  const [center, setCenter] = useState<LatLon | null>(null);
  const sync = useCallback(() => {
    const c = viewerCenter(viewer);
    if (c) setCenter(c);
  }, [viewer]);
  useEffect(() => {
    sync();
  }, [sync]);
  return { center, sync };
}

/** Small header row: shows the active lat/lon and a button to re-sample the view. */
export function CenterHeader({ center, onSync }: { center: LatLon | null; onSync: () => void }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 mb-2">
      <span className="mono text-[10px] text-txt-2">
        📍 {center ? `${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}` : 'pan the map'}
      </span>
      <Btn size="sm" onClick={onSync} title="Use the centre of the current view">
        use view
      </Btn>
    </div>
  );
}
