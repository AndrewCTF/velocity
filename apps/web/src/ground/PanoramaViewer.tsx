// PanoramaViewer — street-view-style ground photo for the selected AOI point,
// overlaid with REAL detection boxes when running in the desktop app (CUDA YOLO
// sidecar). In a plain browser the image still renders; the Detect button is
// inert and the caveat says why.

import { useEffect, useRef, useState } from 'react';
import { Btn, Caveat, MicroLabel } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';
import { detectImage, isDesktop } from '../transport/desktop.js';
import { useGround } from './groundStore.js';
import { useCaptures } from '../state/captures.js';
import { BboxOverlay, colorFor } from './detectionOverlay.js';

export function PanoramaViewer(): JSX.Element | null {
  const selectedId = useGround((s) => s.selectedId);
  const photos = useGround((s) => s.photos);
  const detections = useGround((s) => s.detections);
  const setDetections = useGround((s) => s.setDetections);
  const [detecting, setDetecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const imgWrapRef = useRef<HTMLDivElement>(null);

  const photo = photos.find((p) => `${p.source}:${p.photo_id}` === selectedId) ?? null;
  const detKey = photo ? `${photo.source}:${photo.photo_id}` : null;
  const dets = detKey ? detections[detKey] ?? [] : [];

  // Clear transient errors when the selection changes.
  useEffect(() => {
    setErr(null);
  }, [selectedId]);

  if (!photo) {
    return (
      <div className="border border-line rounded-sm bg-bg-1/60 p-3 text-[10px] text-txt-2">
        Select a ground photo to view it.
      </div>
    );
  }

  const handleDetect = async (): Promise<void> => {
    if (!isDesktop() || detecting || !photo) return;
    setDetecting(true);
    setErr(null);
    try {
      const r = await apiFetch(photo.photo_url);
      if (!r.ok) throw new Error(`photo fetch ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      const out = await detectImage(buf);
      setDetections(`${photo.source}:${photo.photo_id}`, out ?? []);
      // Auto-pin the ground capture as a map entity (dedup'd per photo).
      if (out && out.length > 0) {
        useCaptures.getState().pin({
          source: 'pano',
          srcId: `${photo.source}:${photo.photo_id}`,
          photoUrl: photo.photo_url,
          lat: photo.lat,
          lon: photo.lon,
          label: photo.name ?? photo.photo_id,
          dets: out,
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'detect failed');
    } finally {
      setDetecting(false);
    }
  };

  const counts = dets.reduce<Record<string, number>>((acc, d) => {
    acc[d.cls] = (acc[d.cls] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="border border-line-2 rounded-sm bg-bg-1 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 border-b border-line">
        <span className="mono text-[10px] uppercase tracking-[0.6px] text-txt-2 truncate">
          {photo.source} · {photo.photo_id.slice(0, 16)}
        </span>
        {isDesktop() ? (
          <Btn size="sm" tone={detecting ? 'neutral' : 'accent'} onClick={() => void handleDetect()}>
            {detecting ? 'detecting…' : dets.length ? `redetect (${dets.length})` : 'detect'}
          </Btn>
        ) : (
          <MicroLabel>desktop-only</MicroLabel>
        )}
      </div>

      <div ref={imgWrapRef} className="relative overflow-x-auto bg-black">
        <div className="relative" style={{ minWidth: '100%' }}>
          <img
            src={photo.photo_url}
            alt={photo.name}
            draggable={false}
            className="block w-full select-none"
            style={{ imageRendering: 'auto' }}
          />
          <div className="absolute inset-0">
            <BboxOverlay dets={dets} />
          </div>
        </div>
      </div>

      <div className="px-2 py-1.5 flex flex-wrap gap-1 items-center">
        {Object.entries(counts).length > 0 ? (
          (Object.entries(counts) as [string, number][]).map(([cls, n]) => (
            <span
              key={cls}
              className="mono text-[10px] tracking-[0.6px] uppercase px-[7px] py-[3px] rounded-sm whitespace-nowrap border border-line"
              style={{ color: colorFor(cls) }}
            >
              {n} {cls}
            </span>
          ))
        ) : (
          <MicroLabel>{isDesktop() ? 'no detections yet — run detect' : 'detection needs desktop app'}</MicroLabel>
        )}
        {!isDesktop() && <Caveat level="NO CV // WEBSITE" tone="warn" />}
        {err && <span className="mono text-[10px] text-alert">{err}</span>}
      </div>
    </div>
  );
}
