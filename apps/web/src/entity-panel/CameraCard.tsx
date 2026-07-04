import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { detectImage, detectStatus, isDesktop } from '../transport/desktop.js';
import { BboxOverlay, colorFor, detCounts } from '../ground/detectionOverlay.js';
import type { GroundDetection } from '../ground/types.js';
import { Btn, Caveat, MicroLabel } from '../shell/instruments.js';
import { useCaptures } from '../state/captures.js';

// Snapshot viewer for a selected CCTV cam (Caltrans / Digitraffic — public,
// keyless). Fetches through apiFetch (the sanctioned transport) into an object
// URL, refreshed every 60 s to match the backend snapshot cache TTL.
//
// PERCEPTION AI: in the desktop app the CUDA YOLO sidecar runs on each fresh
// frame and REAL bounding boxes + class counts are overlaid — the free
// "Palantir Video" analog (public camera + open COCO weights). On the plain
// website there is no CV (detectImage returns null); the caveat says why.
const REFRESH_MS = 60_000;

export function CameraCard({
  camId,
  hlsUrl,
  lat,
  lon,
  camName,
}: {
  camId: string;
  hlsUrl: string | null;
  lat?: number | undefined;
  lon?: number | undefined;
  camName?: string | undefined;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [dets, setDets] = useState<GroundDetection[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const busyRef = useRef(false);

  // Sidecar device (cuda:0 / cpu) for the readout chip — desktop only.
  useEffect(() => {
    if (!isDesktop()) return;
    void detectStatus().then((s) => setDevice(s?.device ?? null));
  }, []);

  const detect = async (bytes: Uint8Array | null): Promise<void> => {
    if (!isDesktop() || busyRef.current || !bytes) return;
    busyRef.current = true;
    setDetecting(true);
    setErr(null);
    try {
      const out = await detectImage(bytes);
      setDets(out ?? []);
      // Auto-pin the capture as a map entity (dedup'd per cam). Only when the
      // frame actually has objects and we know where the cam is.
      if (out && out.length > 0 && lat != null && lon != null) {
        useCaptures.getState().pin({
          source: 'cam',
          srcId: camId,
          camId,
          lat,
          lon,
          label: camName ?? camId,
          dets: out,
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'detect failed');
    } finally {
      busyRef.current = false;
      setDetecting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let current: string | null = null;

    const fetchSnap = async (): Promise<void> => {
      try {
        const r = await apiFetch(`/api/cams/${encodeURIComponent(camId)}/snapshot`);
        if (!r.ok || cancelled) return;
        const buf = new Uint8Array(await r.arrayBuffer());
        if (cancelled) return;
        bytesRef.current = buf;
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
        setSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        current = url;
        // Auto-run detection on each fresh frame in the desktop app.
        if (isDesktop()) void detect(buf);
      } catch {
        /* keep last frame */
      }
    };

    setSrc(null);
    setDets([]);
    bytesRef.current = null;
    void fetchSnap();
    const t = window.setInterval(() => void fetchSnap(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      if (current) URL.revokeObjectURL(current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camId]);

  const counts = detCounts(dets);

  return (
    <div className="rounded-sm border border-line bg-bg-2/60 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.7px] text-txt-3">
          live cam{isDesktop() && !hlsUrl ? ' · perception ai' : ''}
        </span>
        {isDesktop() && !hlsUrl && (
          <Btn size="sm" tone={detecting ? 'neutral' : 'accent'} onClick={() => void detect(bytesRef.current)}>
            {detecting ? 'detecting…' : dets.length ? `redetect (${dets.length})` : 'detect'}
          </Btn>
        )}
      </div>

      {hlsUrl ? (
        <HlsPlayer url={hlsUrl} />
      ) : src ? (
        <div className="relative overflow-hidden rounded-sm bg-black">
          <img src={src} alt="cam snapshot" className="block w-full select-none" draggable={false} />
          <div className="absolute inset-0">
            <BboxOverlay dets={dets} />
          </div>
        </div>
      ) : (
        <div className="flex h-24 items-center justify-center text-[11px] text-txt-3">
          loading snapshot…
        </div>
      )}

      {!hlsUrl && (
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
            <MicroLabel>
              {isDesktop()
                ? detecting
                  ? 'detecting…'
                  : 'no objects detected'
                : 'detection needs desktop app'}
            </MicroLabel>
          )}
          {isDesktop() && device && (
            <span className="mono text-[10px] tracking-[0.6px] uppercase text-txt-3 ml-auto">
              yolo · {device}
            </span>
          )}
          {!isDesktop() && <Caveat level="NO CV // WEBSITE" tone="warn" />}
          {err && <span className="mono text-[10px] text-alert">{err}</span>}
        </div>
      )}
    </div>
  );
}

// Lazy hls.js so the chunk only loads when an HLS cam is actually opened.
function HlsPlayer({ url }: { url: string }): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: { destroy: () => void } | null = null;
    let cancelled = false;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled || !Hls.isSupported()) return;
        const h = new Hls();
        h.loadSource(url);
        h.attachMedia(video);
        hls = h;
      });
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [url]);

  return <video ref={ref} className="w-full rounded" controls muted autoPlay playsInline />;
}
