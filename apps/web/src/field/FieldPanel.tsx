// Field tools home — one right-rail tab instead of four peers (the rail only
// fits ~7 before it horizontally scrolls). A compact sub-nav switches between
// the map-centre field panels: Weather, Cameras, Traffic sim, Splat/3D.
import { useState } from 'react';
import { WeatherPanel } from '../weather/WeatherPanel.js';
import { CamerasPanel } from '../cams/CamerasPanel.js';
import { TrafficSimPanel } from '../sim/TrafficSimPanel.js';
import { ReconLauncher } from '../studio/ReconLauncher.js';

type Sub = 'weather' | 'cams' | 'traffic' | 'splat';
const SUBS: Array<{ id: Sub; label: string }> = [
  { id: 'weather', label: 'Weather' },
  { id: 'cams', label: 'Cams' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'splat', label: 'Splat' },
];

export function FieldPanel({ viewer }: { viewer: unknown }): JSX.Element {
  const [sub, setSub] = useState<Sub>('weather');
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {SUBS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSub(s.id)}
            aria-pressed={sub === s.id}
            className={`flex-1 mono text-[10px] tracking-[0.3px] px-1.5 py-1 rounded-sm border ${
              sub === s.id
                ? 'border-accent-line bg-accent-dim text-accent'
                : 'border-line text-txt-3 hover:text-txt-1 hover:border-accent-line'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {sub === 'weather' && <WeatherPanel viewer={viewer} />}
      {sub === 'cams' && <CamerasPanel viewer={viewer} />}
      {sub === 'traffic' && <TrafficSimPanel viewer={viewer} />}
      {sub === 'splat' && <ReconLauncher viewer={viewer} />}
    </div>
  );
}
