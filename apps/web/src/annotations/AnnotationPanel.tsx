// Annotations editor — draw points / lines / circles with a label + threat
// colour via the shared draw toolbox. Left-rail "Annotate" tab.

import { useState } from 'react';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import { getDrawController } from '../globe/draw.js';
import {
  useAnnotations,
  saveAnnotations,
  THREAT_COLOR,
  type Threat,
} from './annotationStore.js';

const THREATS: Threat[] = ['hostile', 'friendly', 'neutral', 'unknown'];
const selectCls =
  'bg-bg-2 border border-line rounded-sm text-[10px] text-txt-1 px-1.5 py-1 mono w-full focus:outline-none focus:border-accent-line';

export function AnnotationPanel(): JSX.Element {
  const annos = useAnnotations((s) => s.annotations);
  const add = useAnnotations((s) => s.add);
  const remove = useAnnotations((s) => s.remove);
  const clear = useAnnotations((s) => s.clear);

  const [threat, setThreat] = useState<Threat>('hostile');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draw = getDrawController();
  const noDraw = draw == null;
  const lbl = (): string => label.trim();

  const point = (): void => {
    if (!draw) return;
    setStatus('click the map to drop a point…');
    draw.placePoint((p) => {
      add({ kind: 'point', threat, label: lbl(), coords: [[p.lon, p.lat]] });
      setStatus('point added ✓');
    });
  };
  const line = (): void => {
    if (!draw) return;
    setStatus('click vertices; right-click / Finish to commit…');
    draw.drawPolyline((verts) => {
      add({ kind: 'line', threat, label: lbl(), coords: verts.map((v) => [v.lon, v.lat]) });
      setStatus('line added ✓');
    });
  };
  const circle = (): void => {
    if (!draw) return;
    setStatus('click centre then edge…');
    draw.drawCircle((c, rKm) => {
      add({ kind: 'circle', threat, label: lbl(), center: c, radiusKm: +rKm.toFixed(2) });
      setStatus(`circle added ✓ (${rKm.toFixed(1)} km)`);
    });
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    const r = await saveAnnotations();
    setBusy(false);
    setStatus(
      r.ok ? 'saved ✓' : r.status === 401 || r.status === 403 ? 'sign in to persist (local-only)' : `save failed (${r.status})`,
    );
  };

  return (
    <div className="space-y-2 p-2 h-full overflow-y-auto">
      <Widget title="Annotate" count={`${annos.length}`}>
        <SectionLabel title="Threat" />
        <div className="flex gap-1 mt-1">
          {THREATS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setThreat(t)}
              title={t}
              className={`flex-1 text-[10px] mono py-1 rounded-sm border capitalize transition-colors ${
                threat === t ? 'border-accent-line bg-accent-dim text-txt-0' : 'border-line text-txt-2 hover:text-txt-0'
              }`}
            >
              <span style={{ color: THREAT_COLOR[t] }}>●</span>
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-0.5 mt-2">
          <MicroLabel>Label (optional)</MicroLabel>
          <input className={selectCls} placeholder="e.g. OBJ BRAVO" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          <Btn tone="accent" onClick={point} disabled={noDraw}>Point</Btn>
          <Btn tone="accent" onClick={line} disabled={noDraw}>Line</Btn>
          <Btn tone="accent" onClick={circle} disabled={noDraw}>Circle</Btn>
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-1.5">
          <Btn onClick={() => draw?.finish()} disabled={noDraw}>Finish line</Btn>
          <Btn onClick={() => { draw?.cancel(); setStatus(null); }} disabled={noDraw}>Cancel</Btn>
        </div>
        {noDraw && <MicroLabel>map not ready</MicroLabel>}
        {status && <p className="text-[10px] text-accent mt-2 mono">{status}</p>}
      </Widget>

      <Widget title="Graphics" count={`${annos.length}`}>
        <div className="max-h-[200px] overflow-auto space-y-0.5">
          {annos.map((a) => (
            <div key={a.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
              <span style={{ color: THREAT_COLOR[a.threat] }} className="text-[9px]">●</span>
              <span className="flex-1 text-[10px] text-txt-1 mono truncate">
                {a.kind}{a.label ? ` · ${a.label}` : ''}{a.kind === 'circle' && a.radiusKm ? ` · ${a.radiusKm}km` : ''}
              </span>
              <button
                type="button"
                onClick={() => remove(a.id)}
                className="text-[11px] leading-none text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100"
                aria-label="Delete annotation"
              >
                ✕
              </button>
            </div>
          ))}
          {annos.length === 0 && <MicroLabel>nothing drawn yet</MicroLabel>}
        </div>
        <div className="grid grid-cols-2 gap-1.5 mt-2">
          <Btn tone="accent" onClick={() => void save()} disabled={busy}>Save</Btn>
          <Btn onClick={clear}>Clear all</Btn>
        </div>
      </Widget>
    </div>
  );
}
