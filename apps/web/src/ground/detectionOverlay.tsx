// Shared YOLO detection overlay — the box layer + class colours used by BOTH the
// ground PanoramaViewer and the live-cam CameraCard. Boxes are normalized 0..1
// (from the desktop CUDA sidecar, apps/desktop/sidecar/yolo_sidecar.py). One
// owner so the two surfaces stay visually identical.
import type { GroundDetection } from './types.js';

const CLS_COLOR: Record<string, string> = {
  person: '#ef4444',
  car: '#facc15',
  truck: '#fb923c',
  bus: '#38bdf8',
  motorcycle: '#a78bfa',
  bicycle: '#a78bfa',
  boat: '#5eead4',
  'traffic light': '#4ade80',
};

export function colorFor(cls: string): string {
  return CLS_COLOR[cls] ?? '#ffffff';
}

export function detCounts(dets: GroundDetection[]): [string, number][] {
  const acc: Record<string, number> = {};
  for (const d of dets) acc[d.cls] = (acc[d.cls] ?? 0) + 1;
  return Object.entries(acc).sort((a, b) => b[1] - a[1]);
}

export function BboxOverlay({ dets }: { dets: GroundDetection[] }): JSX.Element {
  return (
    <>
      {dets.map((d, i) => (
        <div
          key={`${d.id}-${i}`}
          style={{
            position: 'absolute',
            left: `${d.bbox.x * 100}%`,
            top: `${d.bbox.y * 100}%`,
            width: `${d.bbox.w * 100}%`,
            height: `${d.bbox.h * 100}%`,
            border: `1px solid ${colorFor(d.cls)}`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              position: 'absolute',
              bottom: '100%',
              left: 0,
              fontSize: '8px',
              fontFamily: '"IBM Plex Mono", monospace',
              color: colorFor(d.cls),
              background: 'rgba(0,0,0,0.6)',
              padding: '1px 3px',
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            {d.cls} {Math.round(d.conf * 100)}%
          </span>
        </div>
      ))}
    </>
  );
}
