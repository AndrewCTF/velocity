// CaptureCard — the EntityPanel card for a pinned capture entity (kind:'capture').
// A capture is a YOLO detection observation dropped on the map from a public cam
// or a ground pano. Shows the frame thumbnail, the detected class counts, source
// provenance + capture time, and an "unpin" action. Reuses the shared detection
// colours/counts (ground/detectionOverlay).
import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { colorFor, detCounts } from '../ground/detectionOverlay.js';
import type { GroundDetection } from '../ground/types.js';
import { Btn, MicroLabel } from '../shell/instruments.js';
import { useCaptures } from '../state/captures.js';

interface CaptureSnap {
  id: string;
  properties: Record<string, unknown>;
  position?: { lat: number; lon: number };
  name?: string;
}

function ago(ms: number): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Live thumbnail: cams go through the auth'd snapshot proxy (blob→objectURL),
// ground panos are already a same-origin proxied url.
function Thumb({ camId, photoUrl }: { camId: string; photoUrl: string }): JSX.Element | null {
  const [src, setSrc] = useState<string | null>(photoUrl || null);
  useEffect(() => {
    if (!camId) return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      try {
        const r = await apiFetch(`/api/cams/${encodeURIComponent(camId)}/snapshot`);
        if (!r.ok || cancelled) return;
        url = URL.createObjectURL(await r.blob());
        if (!cancelled) setSrc(url);
      } catch {
        /* keep nothing */
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [camId]);
  if (!src) return null;
  return <img src={src} alt="capture frame" className="block w-full rounded-sm" draggable={false} />;
}

export function CaptureCard({ snap }: { snap: CaptureSnap }): JSX.Element {
  const p = snap.properties;
  const source = String(p['source'] ?? '');
  const camId = String(p['cam_id'] ?? '');
  const photoUrl = String(p['photo_url'] ?? '');
  const capturedAt = Number(p['captured_at'] ?? 0);
  let dets: GroundDetection[] = [];
  try {
    dets = JSON.parse(String(p['dets_json'] ?? '[]')) as GroundDetection[];
  } catch {
    /* malformed → none */
  }
  const counts = detCounts(dets);
  const pos = snap.position;

  return (
    <div className="rounded-sm border border-line-2 bg-bg-1 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.7px] text-accent">
          capture · {source || 'obs'}
        </span>
        <Btn size="sm" tone="neutral" onClick={() => useCaptures.getState().remove(snap.id)}>
          unpin
        </Btn>
      </div>

      <div className="relative overflow-hidden rounded-sm bg-black">
        <Thumb camId={camId} photoUrl={photoUrl} />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {counts.length > 0 ? (
          counts.map(([cls, n]) => (
            <span
              key={cls}
              className="mono text-[10px] tracking-[0.6px] uppercase px-[7px] py-[3px] rounded-sm whitespace-nowrap border border-line"
              style={{ color: colorFor(cls) }}
            >
              {n} {cls}
            </span>
          ))
        ) : (
          <MicroLabel>no detections</MicroLabel>
        )}
      </div>

      <div className="mt-1.5 flex items-center justify-between mono text-[10px] text-txt-3">
        <span>{pos ? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}` : '—'}</span>
        <span>YOLO · {ago(capturedAt)}</span>
      </div>
    </div>
  );
}
