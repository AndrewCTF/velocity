// Polar sky-view plot — a pure SVG az/el "radar scope" of where a satellite (or
// several) tracks across the local sky during the mission window. Zenith (90°
// elevation) is the centre; the horizon (0°) is the outer ring. North is up,
// East is right (compass azimuth, clockwise). Same hand-rolled-SVG idiom as the
// timeline histogram — no chart lib, no Cesium.

import type { SkyPoint } from '../sim/tasking.js';

interface Props {
  samples: readonly SkyPoint[];
  size?: number;
}

// Map (azDeg, elDeg) → SVG x/y. radius shrinks as elevation rises (90° → centre).
function project(azDeg: number, elDeg: number, cx: number, cy: number, rMax: number): {
  x: number;
  y: number;
} {
  const r = (rMax * (90 - Math.max(0, Math.min(90, elDeg)))) / 90;
  const a = (azDeg * Math.PI) / 180; // 0 = North (up), clockwise
  return {
    x: cx + r * Math.sin(a),
    y: cy - r * Math.cos(a),
  };
}

export function SkyViewPlot({ samples, size = 220 }: Props): JSX.Element {
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 16; // padding for the cardinal letters

  // Elevation guide rings at 0 / 30 / 60 (90 is the centre point).
  const elRings = [0, 30, 60];
  // Azimuth spokes every 45°.
  const spokes = [0, 45, 90, 135, 180, 225, 270, 315];

  // Break the polyline wherever consecutive samples jump in time (different
  // passes) or wrap across the scope, so separate passes draw as separate arcs.
  const segments: SkyPoint[][] = [];
  let cur: SkyPoint[] = [];
  const GAP_MS = 5 * 60 * 1000; // > 5 min between samples → new pass
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (cur.length === 0) {
      cur.push(s);
      continue;
    }
    const prev = cur[cur.length - 1]!;
    if (s.tMs - prev.tMs > GAP_MS) {
      segments.push(cur);
      cur = [s];
    } else {
      cur.push(s);
    }
  }
  if (cur.length > 0) segments.push(cur);

  const ring = 'rgba(255,255,255,0.10)';
  const ringLbl = 'rgba(255,255,255,0.35)';
  const track = 'var(--accent, #7cc4ff)';

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Satellite sky-view az/el plot"
      className="block"
    >
      {/* elevation rings */}
      {elRings.map((el) => {
        const r = (rMax * (90 - el)) / 90;
        return (
          <circle key={el} cx={cx} cy={cy} r={r} fill="none" stroke={ring} strokeWidth={1} />
        );
      })}
      {/* zenith dot */}
      <circle cx={cx} cy={cy} r={1.5} fill={ringLbl} />

      {/* azimuth spokes */}
      {spokes.map((az) => {
        const a = (az * Math.PI) / 180;
        return (
          <line
            key={az}
            x1={cx}
            y1={cy}
            x2={cx + rMax * Math.sin(a)}
            y2={cy - rMax * Math.cos(a)}
            stroke={ring}
            strokeWidth={1}
          />
        );
      })}

      {/* elevation ring labels (along the +x axis) */}
      {elRings.map((el) => {
        const r = (rMax * (90 - el)) / 90;
        return (
          <text
            key={`l${el}`}
            x={cx + 3}
            y={cy - r + 9}
            className="mono"
            fontSize={7}
            fill={ringLbl}
          >
            {el}°
          </text>
        );
      })}

      {/* cardinal letters */}
      <text x={cx} y={12} textAnchor="middle" className="mono" fontSize={9} fill={ringLbl}>
        N
      </text>
      <text x={size - 6} y={cy + 3} textAnchor="middle" className="mono" fontSize={9} fill={ringLbl}>
        E
      </text>
      <text x={cx} y={size - 4} textAnchor="middle" className="mono" fontSize={9} fill={ringLbl}>
        S
      </text>
      <text x={7} y={cy + 3} textAnchor="middle" className="mono" fontSize={9} fill={ringLbl}>
        W
      </text>

      {/* satellite tracks, one polyline per pass */}
      {segments.map((seg, i) => {
        const pts = seg
          .map((s) => {
            const { x, y } = project(s.azDeg, s.elDeg, cx, cy, rMax);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');
        const first = seg[0]!;
        const start = project(first.azDeg, first.elDeg, cx, cy, rMax);
        return (
          <g key={i}>
            <polyline points={pts} fill="none" stroke={track} strokeWidth={1.5} opacity={0.9} />
            {/* rise marker (entry into view) */}
            <circle cx={start.x} cy={start.y} r={2} fill={track} />
          </g>
        );
      })}

      {samples.length === 0 && (
        <text
          x={cx}
          y={cy + rMax * 0.5}
          textAnchor="middle"
          className="mono"
          fontSize={8}
          fill={ringLbl}
        >
          no passes in window
        </text>
      )}
    </svg>
  );
}
