// RouteOptionsPanel — Palantir "generated route options" workspace (reference image 24).
// Pick a launch point + destination on the map, generate scored route candidates from
// /api/route/candidates, compare Distance / Duration / Asset EMI Resistance in cards, tagged
// least-risk / shortest / fastest, and draw the selected route + live GPS-jamming THREAT RINGS.
// Reuses globe/draw (placePoint), transport/http (apiFetch), Cesium polyline + ellipse.
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { apiFetch } from '../transport/http.js';
import { getDrawController, type LatLon } from '../globe/draw.js';
import { Icon } from './Icon.js';

export interface RouteOptionsPanelProps {
  viewer: Cesium.Viewer | null;
  onClose: () => void;
}

interface RouteResult {
  key: string;
  label: string;
  reachable: boolean;
  route: [number, number][]; // [lon,lat]
  distance_km?: number;
  duration_min?: number;
  climb_m?: number;
  risk?: number;
  emi_resistance?: number;
  worst_severity?: string;
  tag?: string;
  note?: string;
}

interface Threat {
  lon: number;
  lat: number;
  severity: string;
  radius_km: number;
}

const DRAW_ID = 'nrm-route-preview';
const SEV_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#fbbf24' };

export function RouteOptionsPanel({ viewer, onClose }: RouteOptionsPanelProps): JSX.Element {
  const [launch, setLaunch] = useState<LatLon | null>(null);
  const [dest, setDest] = useState<LatLon | null>(null);
  const [opts, setOpts] = useState<RouteResult[]>([]);
  const [threats, setThreats] = useState<Threat[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);

  // A dedicated data source for the route preview + endpoint pins.
  useEffect(() => {
    if (!viewer) return;
    const ds = new Cesium.CustomDataSource(DRAW_ID);
    viewer.dataSources.add(ds);
    dsRef.current = ds;
    return () => {
      if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      dsRef.current = null;
    };
  }, [viewer]);

  const pick = (which: 'launch' | 'dest'): void => {
    getDrawController()?.placePoint((p) => (which === 'launch' ? setLaunch(p) : setDest(p)));
  };

  const generate = async (): Promise<void> => {
    if (!launch || !dest) return;
    setBusy(true);
    setOpts([]);
    setThreats([]);
    setSelected(null);
    const qs = `from_lat=${launch.lat}&from_lon=${launch.lon}&to_lat=${dest.lat}&to_lon=${dest.lon}`;
    try {
      const r = await apiFetch(`/api/route/candidates?${qs}`);
      if (r.ok) {
        const j = (await r.json()) as { candidates: RouteResult[]; threats: Threat[] };
        const th = j.threats ?? [];
        setThreats(th);
        setOpts(j.candidates ?? []);
        if (j.candidates?.[0]) select(j.candidates[0], th);
      }
    } catch {
      /* aborted / offline */
    } finally {
      setBusy(false);
    }
  };

  const select = (o: RouteResult, threatList: Threat[] = threats): void => {
    setSelected(o.key);
    const ds = dsRef.current;
    if (!ds || !viewer) return;
    ds.entities.removeAll();
    // GPS-jamming threat rings (image 24) — translucent disc + severity outline.
    for (const t of threatList) {
      const col = Cesium.Color.fromCssColorString(SEV_COLOR[t.severity] ?? '#f59e0b');
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
        ellipse: {
          semiMajorAxis: t.radius_km * 1000,
          semiMinorAxis: t.radius_km * 1000,
          material: col.withAlpha(0.1),
          outline: true,
          outlineColor: col.withAlpha(0.6),
          outlineWidth: 1,
          height: 0,
        },
      });
    }
    const positions = o.route.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
    ds.entities.add({
      polyline: {
        positions,
        width: 4,
        material: new Cesium.PolylineOutlineMaterialProperty({
          color: Cesium.Color.fromCssColorString('#4fa0d8'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
        }),
        clampToGround: true,
      },
    });
    for (const [p, col, txt] of [
      [launch, '#4ade80', 'Launch'],
      [dest, '#ef4444', 'Dest'],
    ] as const) {
      if (!p) continue;
      ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: { pixelSize: 9, color: Cesium.Color.fromCssColorString(col), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
        label: { text: txt, font: '11px monospace', pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.WHITE },
      });
    }
    viewer.scene.requestRender();
  };

  return (
    <div className="nrm-workspace" style={{ left: 52, top: 48, bottom: 12, width: 330 }}>
      <div className="nrm-ws-head">
        <span className="nrm-ws-title">Route &amp; simulate</span>
        <button type="button" className="nrm-ws-x" aria-label="Close route" onClick={onClose}>
          <Icon name="x" className="ico" />
        </button>
      </div>
      <div className="nrm-ws-body">
        <label className="nrm-lbl">Endpoints</label>
        <div className="nrm-row2">
          <button type="button" className={launch ? 'nrm-btn on' : 'nrm-btn'} onClick={() => pick('launch')}>
            ◎ {launch ? `${launch.lat.toFixed(2)},${launch.lon.toFixed(2)}` : 'Set launch'}
          </button>
          <button type="button" className={dest ? 'nrm-btn on' : 'nrm-btn'} onClick={() => pick('dest')}>
            ⚑ {dest ? `${dest.lat.toFixed(2)},${dest.lon.toFixed(2)}` : 'Set dest'}
          </button>
        </div>
        <button type="button" className="nrm-btn primary" onClick={() => void generate()} disabled={!launch || !dest || busy}>
          {busy ? 'Generating…' : 'Generate routes'}
        </button>

        <div className="nrm-ws-results">
          {opts.length === 0 && !busy && <p className="note">Set two points, then generate.</p>}
          {opts.map((o) => (
            <button
              type="button"
              key={o.key}
              className={selected === o.key ? 'nrm-opt on' : 'nrm-opt'}
              onClick={() => select(o)}
            >
              <div className="nrm-opt-head">
                <span>{o.label}</span>
                {o.tag && <span className="badge">{o.tag}</span>}
              </div>
              <div className="nrm-opt-kv">
                <span>Distance</span><span>{o.distance_km != null ? `${o.distance_km} km` : '—'}</span>
                <span>Duration</span><span>{o.duration_min != null ? `${o.duration_min} min` : '—'}</span>
                {o.climb_m != null && (<><span>Climb</span><span>{Math.round(o.climb_m)} m</span></>)}
                <span title="Share of the route clear of GPS-jamming cells (higher = safer)">EMI resistance</span>
                <span>{o.emi_resistance != null ? `${o.emi_resistance}%` : '—'}</span>
                {o.risk != null && o.risk > 0 && (
                  <><span>Jamming exposure</span><span style={{ color: SEV_COLOR[o.worst_severity ?? 'low'] }}>{o.risk}% · {o.worst_severity}</span></>
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
