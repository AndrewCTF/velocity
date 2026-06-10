import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// Snapshot viewer for a selected CCTV cam. Fetches through apiFetch (the
// sanctioned transport — auth headers ride along; a bare <img src> would
// bypass the API key) into an object URL, refreshed every 60 s to match the
// backend's snapshot cache TTL. On fetch failure the last frame stays up.
const REFRESH_MS = 60_000;

export function CameraCard({
  camId,
  hlsUrl,
  attribution,
}: {
  camId: string;
  hlsUrl: string | null;
  attribution: string;
}): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let current: string | null = null;

    const fetchSnap = async (): Promise<void> => {
      try {
        const r = await apiFetch(`/api/cams/${encodeURIComponent(camId)}/snapshot`);
        if (!r.ok || cancelled) return;
        const blob = await r.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        current = url;
      } catch {
        /* keep last frame */
      }
    };

    setSrc(null);
    void fetchSnap();
    const t = window.setInterval(() => void fetchSnap(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      if (current) URL.revokeObjectURL(current);
    };
  }, [camId]);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 p-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slate-400">
        live cam
      </div>
      {hlsUrl ? (
        <HlsPlayer url={hlsUrl} />
      ) : src ? (
        <img src={src} alt="cam snapshot" className="w-full rounded" />
      ) : (
        <div className="flex h-24 items-center justify-center text-xs text-slate-500">
          loading snapshot…
        </div>
      )}
      <div className="mt-1 text-[10px] text-slate-500">{attribution}</div>
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
