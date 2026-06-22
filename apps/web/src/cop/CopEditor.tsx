// COP editor — place MIL-STD-2525 units, draw FLOT/phase lines, and range rings
// directly on the globe via the shared draw toolbox. Edits write to copStore;
// MilSymbolAdapter re-renders them live. Mounted as the 'cop' mode-surface.

import { useEffect, useState } from 'react';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import {
  useCop,
  composeSidc,
  saveCopToOntology,
  TYPE_LABEL,
  type Affiliation,
  type UnitType,
  type Echelon,
} from './copStore.js';
import { getDrawController } from '../globe/draw.js';
import type { LayerRegistry } from '../registry/LayerRegistry.js';

const COP_LAYER = 'mil.cop.notional';

const AFFILS: Affiliation[] = ['F', 'H', 'N', 'U'];
const AFFIL_COLOR: Record<Affiliation, string> = {
  F: '#5b9bd5',
  H: '#e8584e',
  N: '#4ade80',
  U: '#facc15',
};
const TYPES: UnitType[] = ['infantry', 'armor', 'artillery', 'ada', 'recon', 'engineer', 'hq', 'support'];
const ECHELONS: Echelon[] = [
  'none', 'team', 'squad', 'section', 'platoon', 'company', 'battalion', 'regiment', 'brigade', 'division',
];

const selectCls =
  'bg-bg-2 border border-line rounded-sm text-[10px] text-txt-1 px-1.5 py-1 mono focus:outline-none focus:border-accent-line';

export function CopEditor({ registry }: { registry: LayerRegistry }): JSX.Element {
  const units = useCop((s) => s.units);
  const lines = useCop((s) => s.lines);
  const rings = useCop((s) => s.rings);
  const addUnit = useCop((s) => s.addUnit);
  const removeUnit = useCop((s) => s.removeUnit);
  const addLine = useCop((s) => s.addLine);
  const removeLine = useCop((s) => s.removeLine);
  const addRing = useCop((s) => s.addRing);
  const removeRing = useCop((s) => s.removeRing);
  const reset = useCop((s) => s.reset);
  const clearAll = useCop((s) => s.clearAll);

  const [aff, setAff] = useState<Affiliation>('F');
  const [type, setType] = useState<UnitType>('infantry');
  const [ech, setEch] = useState<Echelon>('company');
  const [desig, setDesig] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Make sure the COP layer is on so the laydown (and live edits) render.
  useEffect(() => {
    try {
      registry.enable(COP_LAYER);
    } catch {
      /* unknown id — registry not ready */
    }
  }, [registry]);

  const draw = getDrawController();
  const noDraw = draw == null;

  const placeUnit = (): void => {
    if (!draw) return;
    setStatus('click the map to place the unit…');
    draw.placePoint((p) => {
      addUnit({
        sidc: composeSidc(aff, type, ech),
        lat: p.lat,
        lon: p.lon,
        designation: desig.trim() || TYPE_LABEL[type],
      });
      setStatus('unit placed ✓');
    });
  };

  const drawLine = (side: 'friendly' | 'hostile'): void => {
    if (!draw) return;
    setStatus('click vertices; right-click or Finish to commit…');
    draw.drawPolyline((verts) => {
      addLine({
        side,
        label: side === 'hostile' ? 'FLOT' : 'PL',
        coords: verts.map((v) => [v.lon, v.lat] as [number, number]),
      });
      setStatus(`${side} line added ✓`);
    });
  };

  const drawRing = (): void => {
    if (!draw) return;
    setStatus('click centre, then click the edge to set radius…');
    draw.drawCircle((c, rKm) => {
      addRing({ lat: c.lat, lon: c.lon, radiusKm: +rKm.toFixed(1), label: 'AO' });
      setStatus(`ring added ✓ (${rKm.toFixed(1)} km)`);
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setStatus('saving…');
    const r = await saveCopToOntology();
    setBusy(false);
    setStatus(
      r.ok
        ? 'saved to ontology ✓'
        : r.status === 401 || r.status === 403
          ? 'sign in to persist (local-only for now)'
          : `save failed (${r.status})`,
    );
  };

  return (
    <div className="space-y-2 p-2">
      <Widget title="Build symbol" count={`${units.length} units`}>
        {/* Affiliation */}
        <SectionLabel title="Affiliation" />
        <div className="flex gap-1 mt-1">
          {AFFILS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setAff(a)}
              className={`flex-1 text-[10px] mono py-1 rounded-sm border transition-colors ${
                aff === a ? 'border-accent-line bg-accent-dim text-txt-0' : 'border-line text-txt-2 hover:text-txt-0'
              }`}
            >
              <span style={{ color: AFFIL_COLOR[a] }}>●</span> {a}
            </button>
          ))}
        </div>
        {/* Type + echelon */}
        <div className="grid grid-cols-2 gap-1.5 mt-2">
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Type</MicroLabel>
            <select className={selectCls} value={type} onChange={(e) => setType(e.target.value as UnitType)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <MicroLabel>Echelon</MicroLabel>
            <select className={selectCls} value={ech} onChange={(e) => setEch(e.target.value as Echelon)}>
              {ECHELONS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-0.5 mt-1.5">
          <MicroLabel>Designation</MicroLabel>
          <input
            className={selectCls}
            placeholder="e.g. 1-66 AR"
            value={desig}
            onChange={(e) => setDesig(e.target.value)}
          />
        </label>
        <div className="mt-2">
          <Btn tone="accent" onClick={placeUnit} disabled={noDraw} className="w-full justify-center">
            ＋ Place unit on map
          </Btn>
        </div>
      </Widget>

      <Widget title="Draw graphics">
        <div className="grid grid-cols-2 gap-1.5">
          <Btn onClick={() => drawLine('hostile')} disabled={noDraw}>FLOT (hostile)</Btn>
          <Btn onClick={() => drawLine('friendly')} disabled={noDraw}>Phase line</Btn>
          <Btn onClick={drawRing} disabled={noDraw}>Range ring</Btn>
          <Btn onClick={() => draw?.finish()} disabled={noDraw}>Finish line</Btn>
        </div>
        <div className="mt-1.5">
          <Btn onClick={() => { draw?.cancel(); setStatus(null); }} disabled={noDraw} className="w-full justify-center">
            Cancel drawing
          </Btn>
        </div>
        {noDraw && <MicroLabel>map not ready</MicroLabel>}
        {status && <p className="text-[10px] text-accent mt-2 mono">{status}</p>}
      </Widget>

      <Widget title="Laydown" count={`${units.length}u ${lines.length}l ${rings.length}r`}>
        <div className="max-h-[180px] overflow-auto space-y-0.5">
          {units.map((u) => (
            <Row key={u.id} dot={AFFIL_COLOR[(u.sidc[1] as Affiliation) ?? 'U'] ?? '#888'} label={u.designation || u.id} onDel={() => removeUnit(u.id)} />
          ))}
          {lines.map((l) => (
            <Row key={l.id} dot={l.side === 'hostile' ? '#e8584e' : '#5b9bd5'} label={`${l.label} · ${l.coords.length}pt`} onDel={() => removeLine(l.id)} />
          ))}
          {rings.map((r) => (
            <Row key={r.id} dot="#f59e0b" label={`${r.label} · ${r.radiusKm}km`} onDel={() => removeRing(r.id)} />
          ))}
          {units.length + lines.length + rings.length === 0 && <MicroLabel>empty COP — place a unit</MicroLabel>}
        </div>
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          <Btn tone="accent" onClick={() => void save()} disabled={busy}>Save</Btn>
          <Btn onClick={reset}>Reset</Btn>
          <Btn onClick={clearAll}>Clear</Btn>
        </div>
      </Widget>
    </div>
  );
}

function Row({ dot, label, onDel }: { dot: string; label: string; onDel: () => void }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
      <span style={{ color: dot }} className="text-[9px]">
        ●
      </span>
      <span className="flex-1 text-[10px] text-txt-1 mono truncate">{label}</span>
      <button
        type="button"
        onClick={onDel}
        className="text-[11px] leading-none text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100"
        aria-label={`Delete ${label}`}
      >
        ✕
      </button>
    </div>
  );
}
