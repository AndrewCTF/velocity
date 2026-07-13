// Territorial-control editor — draw/import controlled & contested AREAS (45° hatch)
// and FRONT LINES (solid = confirmed, dotted = contested), coloured by faction.
// Lives inside the Situations panel. Uses the shared draw toolbox + the control store.

import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import { toast } from '../shell/toast.js';
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

// Faction palette — literal hexes aligned to the dark-theme token values in
// theme/tokens.css (--accent, --alert, --ok, --warn, --mag, --accent-fg).
// Literal because faction colours are persisted in the control store and parsed
// by Cesium (Color.fromCssColorString / hatchMaterial) in globe/ControlLayer.ts,
// where var() cannot resolve; the globe canvas stays dark in both themes, so
// the dark values are the right ones.
const FACTION_PALETTE = ['#6fb1dd', '#ff5a52', '#4ed3a1', '#f5a524', '#e25bef', '#9cc2ff'];

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

  // facId is seeded before loadControl resolves; if the loaded factions don't
  // include the seed ('blue' or a since-removed id), re-point it at the first
  // real faction so drawn zones/lines are filed under an existing faction.
  useEffect(() => {
    if (factions.length > 0 && !factions.some((f) => f.id === facId)) {
      setFacId(factions[0]!.id);
    }
  }, [factions, facId]);

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
      setStatus(null);
      toast.ok('Area added');
    });
  };

  const drawLine = (): void => {
    if (!draw) return;
    setStatus('click vertices; right-click / Finish to commit the front line…');
    draw.drawPolyline((verts) => {
      addLine({ status: lineStatus, label: lbl(), coords: verts.map((v) => [v.lon, v.lat]) });
      setStatus(null);
      toast.ok('Front line added');
    });
  };

  const doImport = (text: string): void => {
    const r = importGeoJSON(text);
    if (r.zones + r.lines === 0) {
      toast.warn(`Import: nothing added — ${r.errors[0] ?? 'no polygons/lines found'}`);
    } else {
      toast.ok(`Imported ${r.zones} area(s), ${r.lines} line(s)${r.errors.length ? ` · ${r.errors.length} skipped` : ''}`);
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
    if (r.ok) toast.ok('Saved');
    else if (r.status === 401 || r.status === 403) toast.warn('Sign in to persist (local-only)');
    else toast.error(`Save failed (${r.status})`);
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
            <span style={{ color: f.color }} aria-hidden>■</span>
            {f.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const name = window.prompt('New faction name');
            if (name?.trim()) {
              setFacId(addFaction(name.trim(), FACTION_PALETTE[factions.length % FACTION_PALETTE.length]!));
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
            <span style={{ color: factionColor(factions, z.factionId) }} className="text-[10px]" aria-hidden>▧</span>
            <button type="button" onClick={() => flyToZone(z.ring)} className="flex-1 text-left text-[10px] text-txt-1 mono truncate">
              area{z.label ? ` · ${z.label}` : ''}{z.status === 'contested' ? ' · contested' : ''}
            </button>
            <button type="button" onClick={() => removeZone(z.id)} aria-label="Delete area" className="text-[11px] text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100">✕</button>
          </div>
        ))}
        {lines.map((l) => (
          <div key={l.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
            <span className="text-[10px] text-txt-2" aria-hidden>{l.status === 'contested' ? '┄' : '──'}</span>
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
