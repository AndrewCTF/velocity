// Territorial-control editor — draw/import controlled & contested AREAS (45° hatch)
// and FRONT LINES (solid = confirmed, dotted = contested), coloured by faction.
// Lives inside the Situations panel. Uses the shared draw toolbox + the control store.

import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import { getDrawController } from '../globe/draw.js';
import { flyToPosition } from '../globe/camera.js';
import {
  useControl,
  saveControl,
  loadControl,
  importGeoJSON,
  factionColor,
  type ZoneStatus,
  type LineStatus,
} from './controlStore.js';

const inputCls =
  'bg-bg-2 border border-line rounded-sm text-[10px] text-txt-1 px-1.5 py-1 mono w-full focus:outline-none focus:border-accent-line';

export function ControlSection({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const factions = useControl((s) => s.factions);
  const zones = useControl((s) => s.zones);
  const lines = useControl((s) => s.lines);
  const addZone = useControl((s) => s.addZone);
  const addLine = useControl((s) => s.addLine);
  const removeZone = useControl((s) => s.removeZone);
  const removeLine = useControl((s) => s.removeLine);
  const addFaction = useControl((s) => s.addFaction);
  const clear = useControl((s) => s.clear);

  const [facId, setFacId] = useState<string>(factions[0]?.id ?? 'blue');
  const [zoneStatus, setZoneStatus] = useState<ZoneStatus>('controlled');
  const [lineStatus, setLineStatus] = useState<LineStatus>('confirmed');
  const [label, setLabel] = useState('');
  const [conditions, setConditions] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadControl();
  }, []);

  const draw = getDrawController();
  const noDraw = draw == null;
  const lbl = (): string | undefined => label.trim() || undefined;
  const cond = (): string | undefined => conditions.trim() || undefined;

  const drawZone = (): void => {
    if (!draw) return;
    setStatus('click vertices; right-click / Finish to close the area…');
    draw.drawPolygon((ring) => {
      addZone({
        factionId: facId,
        status: zoneStatus,
        label: lbl(),
        conditions: cond(),
        ring: ring.map((p) => [p.lon, p.lat]),
      });
      setStatus('area added ✓');
    });
  };

  const drawLine = (): void => {
    if (!draw) return;
    setStatus('click vertices; right-click / Finish to commit the front line…');
    draw.drawPolyline((verts) => {
      addLine({ status: lineStatus, label: lbl(), coords: verts.map((v) => [v.lon, v.lat]) });
      setStatus('front line added ✓');
    });
  };

  const doImport = (text: string): void => {
    const r = importGeoJSON(text);
    if (r.zones + r.lines === 0) {
      setStatus(`import: nothing added — ${r.errors[0] ?? 'no polygons/lines found'}`);
    } else {
      setStatus(`imported ${r.zones} area(s), ${r.lines} line(s)${r.errors.length ? ` · ${r.errors.length} skipped` : ''} ✓`);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const f = e.target.files?.[0];
    if (!f) return;
    void f.text().then(doImport);
    e.target.value = '';
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await saveControl();
    setBusy(false);
    setStatus(
      r.ok ? 'saved ✓' : r.status === 401 || r.status === 403 ? 'sign in to persist (local-only)' : `save failed (${r.status})`,
    );
  };

  const flyToZone = (ring: [number, number][]): void => {
    if (!viewer || ring.length === 0) return;
    let lon = 0;
    let lat = 0;
    for (const [x, y] of ring) {
      lon += x;
      lat += y;
    }
    flyToPosition(viewer, lon / ring.length, lat / ring.length, 900_000, 1.0);
  };

  return (
    <Widget title="Territorial control" count={`${zones.length + lines.length}`}>
      {/* faction picker + add */}
      <SectionLabel title="Faction" />
      <div className="flex flex-wrap gap-1 mt-1">
        {factions.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFacId(f.id)}
            title={f.name}
            className={`flex items-center gap-1 text-[10px] mono px-1.5 py-1 rounded-sm border ${
              facId === f.id ? 'border-accent-line bg-accent-dim text-txt-0' : 'border-line text-txt-2 hover:text-txt-0'
            }`}
          >
            <span style={{ color: f.color }}>■</span>
            {f.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('New faction name');
            if (name?.trim()) {
              const palette = ['#38bdf8', '#ef4444', '#4ade80', '#facc15', '#c084fc', '#f59e0b'];
              setFacId(addFaction(name.trim(), palette[factions.length % palette.length]!));
            }
          }}
          className="text-[10px] mono px-1.5 py-1 rounded-sm border border-line text-txt-3 hover:text-accent"
        >
          + faction
        </button>
      </div>

      <label className="flex flex-col gap-0.5 mt-2">
        <MicroLabel>Label (optional)</MicroLabel>
        <input className={inputCls} placeholder="e.g. SECTOR EAST" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="flex flex-col gap-0.5 mt-1.5">
        <MicroLabel>Current conditions (optional)</MicroLabel>
        <input className={inputCls} placeholder="e.g. under shelling / encircled" value={conditions} onChange={(e) => setConditions(e.target.value)} />
      </label>

      {/* area */}
      <div className="mt-2 flex items-center gap-1.5">
        <div className="flex rounded-sm border border-line overflow-hidden">
          {(['controlled', 'contested'] as ZoneStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setZoneStatus(s)}
              className={`text-[10px] mono px-1.5 py-1 ${zoneStatus === s ? 'bg-accent-dim text-txt-0' : 'text-txt-3 hover:text-txt-1'}`}
            >
              {s}
            </button>
          ))}
        </div>
        <Btn tone="accent" onClick={drawZone} disabled={noDraw}>Draw area</Btn>
      </div>

      {/* front line */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="flex rounded-sm border border-line overflow-hidden">
          {(['confirmed', 'contested'] as LineStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setLineStatus(s)}
              className={`text-[10px] mono px-1.5 py-1 ${lineStatus === s ? 'bg-accent-dim text-txt-0' : 'text-txt-3 hover:text-txt-1'}`}
            >
              {s === 'confirmed' ? 'solid' : 'dotted'}
            </button>
          ))}
        </div>
        <Btn tone="accent" onClick={drawLine} disabled={noDraw}>Draw line</Btn>
      </div>

      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
        <Btn onClick={() => draw?.finish()} disabled={noDraw}>Finish</Btn>
        <Btn onClick={() => { draw?.cancel(); setStatus(null); }} disabled={noDraw}>Cancel</Btn>
      </div>

      {/* import */}
      <div className="mt-2">
        <MicroLabel>Import GeoJSON (polygons → areas, lines → front lines)</MicroLabel>
        <div className="grid grid-cols-2 gap-1.5 mt-1">
          <Btn onClick={() => fileRef.current?.click()}>From file</Btn>
          <Btn
            onClick={() => {
              const t = window.prompt('Paste GeoJSON');
              if (t) doImport(t);
            }}
          >
            Paste
          </Btn>
        </div>
        <input ref={fileRef} type="file" accept=".json,.geojson,application/json" onChange={onFile} className="hidden" />
      </div>

      {noDraw && <MicroLabel>map not ready</MicroLabel>}
      {status && <p className="text-[10px] text-accent mt-2 mono">{status}</p>}

      {/* list */}
      <div className="mt-2 max-h-[180px] overflow-auto space-y-0.5">
        {zones.map((z) => (
          <div key={z.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
            <span style={{ color: factionColor(factions, z.factionId) }} className="text-[10px]">▧</span>
            <button type="button" onClick={() => flyToZone(z.ring)} className="flex-1 text-left text-[10px] text-txt-1 mono truncate">
              area{z.label ? ` · ${z.label}` : ''}{z.status === 'contested' ? ' · contested' : ''}
            </button>
            <button type="button" onClick={() => removeZone(z.id)} aria-label="Delete area" className="text-[11px] text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100">✕</button>
          </div>
        ))}
        {lines.map((l) => (
          <div key={l.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
            <span className="text-[10px] text-txt-2">{l.status === 'contested' ? '┄' : '──'}</span>
            <span className="flex-1 text-[10px] text-txt-1 mono truncate">
              front line{l.label ? ` · ${l.label}` : ''}{l.status === 'contested' ? ' · contested' : ''}
            </span>
            <button type="button" onClick={() => removeLine(l.id)} aria-label="Delete line" className="text-[11px] text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100">✕</button>
          </div>
        ))}
        {zones.length + lines.length === 0 && <MicroLabel>nothing drawn yet — draw or import</MicroLabel>}
      </div>

      <div className="grid grid-cols-2 gap-1.5 mt-2">
        <Btn tone="accent" onClick={() => void save()} disabled={busy}>Save</Btn>
        <Btn onClick={clear}>Clear all</Btn>
      </div>
    </Widget>
  );
}
