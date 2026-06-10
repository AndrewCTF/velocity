import type { TrackPoint } from '../intel/tracks.js';

interface Props {
  points: readonly TrackPoint[];
  field: 'sog' | 'alt' | 'track';
  width?: number;
  height?: number;
  label?: string;
  unit?: string;
}

// Pure-SVG sparkline. We render the time-series of `field` across the
// position ring buffer. Used by the entity panel for SOG (vessels) and
// altitude (aircraft).
export function Sparkline({ points, field, width = 280, height = 36, label, unit }: Props): JSX.Element {
  const ys = points.map((p) => p[field]).filter((v): v is number => typeof v === 'number');
  if (ys.length < 2) {
    return (
      <div className="micro text-txt-3">
        {label ?? field}: <span className="mono">— insufficient samples ({ys.length})</span>
      </div>
    );
  }
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const range = max - min || 1;
  const step = width / (ys.length - 1);
  const path = ys
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = ys[ys.length - 1] ?? 0;
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="micro">{label ?? field}</span>
        <span className="mono text-[11px] text-txt-1">
          {last.toFixed(field === 'track' ? 0 : 1)}
          {unit && ` ${unit}`}
        </span>
      </div>
      <svg width={width} height={height} className="block">
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1" />
        <text x={0} y={height - 1} className="micro" fontSize="9" fill="var(--txt-3)" fontFamily="monospace">
          {min.toFixed(0)}
        </text>
        <text x={width - 24} y={9} className="micro" fontSize="9" fill="var(--txt-3)" fontFamily="monospace">
          {max.toFixed(0)}
        </text>
      </svg>
    </div>
  );
}
