// Splat / 3D right-rail tab. The full Gaussian-splatting workspace (ingest →
// SfM → train → THREE.js viewer) is the /studio route; this panel is its
// launcher — open it cold, or open it prefilled to reconstruct the centre of the
// current view from satellite imagery (StudioPage's satellite-AOI → 3D path).
import type * as Cesium from 'cesium';
import { Link } from 'react-router-dom';
import { Widget, MicroLabel, KV, KVRow } from '../shell/instruments.js';
import { useCenter, CenterHeader } from '../globe/center.js';

export function ReconLauncher({ viewer }: { viewer: unknown }): JSX.Element {
  const { center, sync } = useCenter(viewer as Cesium.Viewer | null);
  const studioHref = center
    ? `/studio?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}&radius=2`
    : '/studio';
  return (
    <div className="space-y-2">
      <CenterHeader center={center} onSync={sync} />
      <Widget title="3D Gaussian splatting">
        <MicroLabel>Local reconstruction on the box GPU — no cloud upload.</MicroLabel>
        <KV className="mt-2">
          <KVRow k="Images / video" v="ingest in Studio" />
          <KVRow k="Satellite AOI" v="this view → 3D" />
          <KVRow k="Ground photos" v="Ground tab → build splat" />
        </KV>
        <div className="mt-3 flex gap-1.5">
          <Link
            to={studioHref}
            className="mono text-[10px] px-2 py-1 border border-accent-line text-accent rounded-sm hover:bg-accent-dim"
          >
            build this view ↗
          </Link>
          <Link
            to="/studio"
            className="mono text-[10px] px-2 py-1 border border-line text-txt-2 rounded-sm hover:border-accent-line"
          >
            open studio
          </Link>
        </div>
      </Widget>
    </div>
  );
}
