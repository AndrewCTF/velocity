// Watchbox editor — draw a circular AOI and pick an enter / exit / loiter rule.
// Triggers fire into the Alerts rail + ticker (WatchboxLayer evaluator).

import { useState } from 'react';
import { Widget, Btn, SectionLabel, MicroLabel } from '../shell/instruments.js';
import { getDrawController } from '../globe/draw.js';
import { useWatchboxes, type WatchRule } from './watchboxStore.js';

const RULES: WatchRule[] = ['enter', 'exit', 'loiter'];
const selectCls =
  'bg-bg-2 border border-line rounded-sm text-[10px] text-txt-1 px-1.5 py-1 mono w-full focus:outline-none focus:border-accent-line';

export function WatchboxPanel(): JSX.Element {
  const wbs = useWatchboxes((s) => s.watchboxes);
  const add = useWatchboxes((s) => s.add);
  const remove = useWatchboxes((s) => s.remove);
  const clear = useWatchboxes((s) => s.clear);

  const [rule, setRule] = useState<WatchRule>('enter');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const draw = getDrawController();
  const noDraw = draw == null;

  const drawAoi = (): void => {
    if (!draw) return;
    setStatus('click centre, then click the edge to set the AOI radius…');
    draw.drawCircle((c, rKm) => {
      add({ label: label.trim() || `AOI ${wbs.length + 1}`, center: c, radiusKm: +rKm.toFixed(2), rule });
      setStatus(`watchbox armed ✓ (${rKm.toFixed(1)} km · ${rule})`);
    });
  };

  return (
    <div className="space-y-2 p-2 h-full overflow-y-auto">
      <Widget title="Geofence / watchbox" count={`${wbs.length}`}>
        <SectionLabel title="Trigger rule" />
        <div className="flex gap-1 mt-1">
          {RULES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRule(r)}
              className={`flex-1 text-[10px] mono py-1 rounded-sm border capitalize transition-colors ${
                rule === r ? 'border-accent-line bg-accent-dim text-txt-0' : 'border-line text-txt-2 hover:text-txt-0'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-0.5 mt-2">
          <MicroLabel>Label (optional)</MicroLabel>
          <input className={selectCls} placeholder="e.g. NAMED AREA OF INTEREST" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <div className="mt-2">
          <Btn tone="accent" onClick={drawAoi} disabled={noDraw} className="w-full justify-center">
            ⊙ Draw AOI on map
          </Btn>
        </div>
        {noDraw && <MicroLabel>map not ready</MicroLabel>}
        {status && <p className="text-[10px] text-accent mt-2 mono">{status}</p>}
        <MicroLabel>triggers post to the Alerts tab + ticker</MicroLabel>
      </Widget>

      <Widget title="Active watchboxes" count={`${wbs.length}`}>
        <div className="max-h-[200px] overflow-auto space-y-0.5">
          {wbs.map((w) => (
            <div key={w.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-bg-2 group">
              <span className="text-[9px]" style={{ color: '#f5a524' }}>⊙</span>
              <span className="flex-1 text-[10px] text-txt-1 mono truncate">
                {w.label} · {w.rule} · {w.radiusKm}km
              </span>
              <button
                type="button"
                onClick={() => remove(w.id)}
                className="text-[11px] leading-none text-txt-3 hover:text-alert px-1 opacity-0 group-hover:opacity-100"
                aria-label="Delete watchbox"
              >
                ✕
              </button>
            </div>
          ))}
          {wbs.length === 0 && <MicroLabel>no watchboxes — draw an AOI</MicroLabel>}
        </div>
        {wbs.length > 0 && (
          <div className="mt-2">
            <Btn onClick={clear} className="w-full justify-center">Clear all</Btn>
          </div>
        )}
      </Widget>
    </div>
  );
}
