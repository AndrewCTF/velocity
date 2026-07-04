// Cameras (CCTV) right-rail tab. Lists public road/weather cams nearest the
// centre of the view and shows the selected cam's live snapshot/stream. Reuses
// the same CameraCard the entity panel uses.
import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, MicroLabel } from '../shell/instruments.js';
import { useCenter, CenterHeader, type LatLon } from '../globe/center.js';
import { CameraCard } from '../entity-panel/CameraCard.js';
import { apiFetch } from '../transport/http.js';

interface Cam {
  cam_id: string;
  name: string;
  lat: number;
  lon: number;
  hls_url: string | null;
}

function distSort(cams: Cam[], c: LatLon | null): Cam[] {
  if (!c) return cams;
  return [...cams].sort(
    (a, b) => Math.hypot(a.lat - c.lat, a.lon - c.lon) - Math.hypot(b.lat - c.lat, b.lon - c.lon),
  );
}

export function CamerasPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const { center, sync } = useCenter(viewer as Cesium.Viewer | null);
  const [cams, setCams] = useState<Cam[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Cam | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/cams')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`cams ${r.status}`))))
      .then((fc: { features?: Array<Record<string, unknown>> }) => {
        if (cancelled) return;
        const list: Cam[] = [];
        for (const f of fc.features ?? []) {
          const p = (f.properties ?? {}) as Record<string, unknown>;
          const coords = (f.geometry as { coordinates?: [number, number, number] } | undefined)?.coordinates;
          if (!coords || !p.cam_id) continue;
          list.push({
            cam_id: String(p.cam_id),
            name: String(p.name ?? p.cam_id),
            lat: coords[1],
            lon: coords[0],
            hls_url: (p.hls_url as string | undefined) ?? (p.hls as string | undefined) ?? null,
          });
        }
        setCams(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'cams failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nearest = distSort(cams, center).slice(0, 40);

  return (
    <div className="space-y-2">
      <CenterHeader center={center} onSync={sync} />
      {selected && (
        <Widget title={selected.name} count={`${selected.lat.toFixed(2)}, ${selected.lon.toFixed(2)}`}>
          <CameraCard
            camId={selected.cam_id}
            hlsUrl={selected.hls_url}
            lat={selected.lat}
            lon={selected.lon}
            camName={selected.name}
          />
        </Widget>
      )}
      <Widget title="Public cams" count={`${cams.length}`}>
        {err && <span className="mono text-[10px] text-alert">{err}</span>}
        {cams.length === 0 && !err ? (
          <MicroLabel>loading…</MicroLabel>
        ) : (
          <div className="flex flex-col gap-1">
            {nearest.map((c) => (
              <button
                key={c.cam_id}
                type="button"
                onClick={() => setSelected(selected?.cam_id === c.cam_id ? null : c)}
                className={`text-left mono text-[10px] px-2 py-1 rounded-sm border ${
                  selected?.cam_id === c.cam_id ? 'border-accent-line text-accent' : 'border-line text-txt-2 hover:border-accent-line'
                }`}
                title={`${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}`}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
        {cams.length > nearest.length && <MicroLabel>nearest {nearest.length} of {cams.length}</MicroLabel>}
      </Widget>
    </div>
  );
}
