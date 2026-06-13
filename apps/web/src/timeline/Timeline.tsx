import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useTime } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';
import { installHistoryPlayback, type PlaybackController, type PlaybackInfo } from '../globe/HistoryPlayback.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

const SPEEDS = [1, 10, 60, 600, 3600] as const;
const REPLAY_WINDOWS = [
  { label: '1h', sec: 3600 },
  { label: '6h', sec: 21_600 },
  { label: '24h', sec: 86_400 },
] as const;
const POLL_MS = 5_000;

interface Density {
  from: number;
  to: number;
  bins: number;
  binWidthSec: number;
  detections: number[];
  alerts: number[];
  gaps: number[];
}

export function Timeline({ viewer }: Props = {}): JSX.Element {
  const { playing, multiplier, togglePlay, setMultiplier } = useTime();
  const [stamp, setStamp] = useState(() => isoStamp(Date.now()));
  const [density, setDensity] = useState<Density | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);

  // Historical playback (replay recorded tracks for the current view).
  const playbackRef = useRef<PlaybackController | null>(null);
  const [replayWindow, setReplayWindow] = useState<number>(3600);
  const [replay, setReplay] = useState<{ active: boolean; loading: boolean; info: PlaybackInfo | null }>(
    { active: false, loading: false, info: null },
  );

  useEffect(() => {
    if (!viewer) return;
    const ctrl = installHistoryPlayback(viewer);
    playbackRef.current = ctrl;
    return () => {
      ctrl.destroy();
      playbackRef.current = null;
      setReplay({ active: false, loading: false, info: null });
    };
  }, [viewer]);

  const toggleReplay = async (): Promise<void> => {
    const ctrl = playbackRef.current;
    if (!ctrl) return;
    if (ctrl.isActive()) {
      ctrl.clear();
      setReplay({ active: false, loading: false, info: null });
      return;
    }
    setReplay((r) => ({ ...r, loading: true }));
    const info = await ctrl.load(replayWindow);
    setReplay({ active: ctrl.isActive(), loading: false, info });
  };

  // Drive Cesium clock from store state
  useEffect(() => {
    if (!viewer) return;
    const clock = viewer.clock;
    clock.multiplier = multiplier;
    clock.shouldAnimate = playing;
    const off = clock.onTick.addEventListener(() => {
      setStamp(isoStamp(jdToMs(clock.currentTime)));
    });
    return () => off();
  }, [viewer, multiplier, playing]);

  // Poll density endpoint
  useEffect(() => {
    let aborter: AbortController | null = null;
    const tick = async () => {
      aborter?.abort();
      aborter = new AbortController();
      try {
        const r = await apiFetch('/api/timeline/density?bins=240&window_sec=72000', {
          signal: aborter.signal,
        });
        if (r.ok) setDensity((await r.json()) as Density);
      } catch {
        /* swallow */
      }
    };
    void tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      window.clearInterval(id);
      aborter?.abort();
    };
  }, []);

  const onStripMouseDown = (e: React.MouseEvent) => {
    if (!stripRef.current) return;
    const rect = stripRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setDrag({ start: x, end: x });
  };
  const onStripMouseMove = (e: React.MouseEvent) => {
    if (!drag || !stripRef.current) return;
    const rect = stripRef.current.getBoundingClientRect();
    setDrag({ start: drag.start, end: e.clientX - rect.left });
  };
  const onStripMouseUp = () => {
    if (!drag || !stripRef.current || !viewer || !density) {
      setDrag(null);
      return;
    }
    const rect = stripRef.current.getBoundingClientRect();
    if (Math.abs(drag.end - drag.start) < 5) {
      const frac = drag.start / rect.width;
      const t = density.from + frac * (density.to - density.from);
      jumpClockTo(viewer, t);
      setStamp(isoStamp(t));
    }
    setDrag(null);
  };

  const detections = density?.detections ?? [];
  const alerts = density?.alerts ?? [];
  const bins = density?.bins ?? 240;
  const maxDet = Math.max(1, ...detections);
  const totalDet = detections.reduce((a, b) => a + b, 0);
  const totalAlert = alerts.reduce((a, b) => a + b, 0);

  return (
    <div className="h-full flex flex-col px-3 py-2 gap-1">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          className="mono text-[11px] px-2 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
        >
          {playing ? '◼ pause' : '▶ play'}
        </button>
        <div className="flex items-center gap-1">
          <span className="micro">speed</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setMultiplier(s)}
              className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${
                multiplier === s
                  ? 'border-accent-line text-accent'
                  : 'border-line text-txt-2 hover:border-accent-line'
              }`}
              aria-pressed={multiplier === s}
            >
              {s}×
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" aria-label="Historical replay">
          <span className="micro">replay</span>
          {REPLAY_WINDOWS.map((w) => (
            <button
              key={w.sec}
              type="button"
              onClick={() => setReplayWindow(w.sec)}
              disabled={replay.active}
              className={`mono text-[10px] px-1.5 py-0.5 border rounded-sm ${
                replayWindow === w.sec
                  ? 'border-accent-line text-accent'
                  : 'border-line text-txt-2 hover:border-accent-line'
              } disabled:opacity-40`}
              aria-pressed={replayWindow === w.sec}
            >
              {w.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void toggleReplay()}
            disabled={replay.loading}
            className={`mono text-[10px] px-2 py-0.5 border rounded-sm ${
              replay.active ? 'border-accent-line text-accent' : 'border-line text-txt-1 hover:border-accent-line'
            }`}
            aria-pressed={replay.active}
          >
            {replay.loading ? '…' : replay.active ? '◼ exit' : '▶ replay'}
          </button>
          {replay.active && replay.info && (
            <span className="mono micro tabular-nums text-txt-2">
              {replay.info.tracks}t·{replay.info.points}p
            </span>
          )}
        </div>
        <div className="flex-1 flex items-center gap-3">
          <span className="micro flex items-center gap-1"><i className="inline-block w-2 h-2 bg-ok" />detections</span>
          <span className="mono micro tabular-nums text-txt-2">{totalDet.toLocaleString()}</span>
          <span className="micro flex items-center gap-1 ml-3"><i className="inline-block w-2 h-2 bg-alert" />alerts</span>
          <span className="mono micro tabular-nums text-txt-2">{totalAlert.toLocaleString()}</span>
        </div>
        <div className="mono text-[11px] text-txt-1">{stamp}</div>
      </div>

      <div
        ref={stripRef}
        className="flex-1 border border-line rounded-sm bg-bg-2 relative overflow-hidden select-none cursor-crosshair"
        onMouseDown={onStripMouseDown}
        onMouseMove={onStripMouseMove}
        onMouseUp={onStripMouseUp}
        onMouseLeave={() => setDrag(null)}
      >
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${bins} 100`}>
          {detections.map((det, i) => {
            const h = (det / maxDet) * 92;
            const aCount = alerts[i] ?? 0;
            return (
              <g key={i}>
                {h > 0 && (
                  <rect x={i} y={100 - h} width={1} height={h} fill="var(--ok)" opacity={0.65} />
                )}
                {aCount > 0 && (
                  <rect x={i} y={0} width={1} height={100} fill="var(--alert)" opacity={0.9} />
                )}
              </g>
            );
          })}
          {/* hour gridlines every ~3 hours */}
          {[...Array(7)].map((_, i) => {
            const x = (bins / 7) * (i + 1);
            return (
              <line
                key={`g${i}`}
                x1={x}
                x2={x}
                y1={92}
                y2={100}
                stroke="var(--line-2)"
                strokeWidth="0.5"
              />
            );
          })}
          {drag && (
            <rect
              x={(Math.min(drag.start, drag.end) / (stripRef.current?.clientWidth ?? 1)) * bins}
              y={0}
              width={(Math.abs(drag.end - drag.start) / (stripRef.current?.clientWidth ?? 1)) * bins}
              height={100}
              fill="var(--accent)"
              opacity={0.15}
            />
          )}
        </svg>
        <span className="micro absolute top-1 left-2 pointer-events-none">−20h</span>
        <span className="micro absolute top-1 right-2 pointer-events-none">now</span>
      </div>
    </div>
  );
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function jdToMs(jd: Cesium.JulianDate): number {
  return (jd.dayNumber - 2440587) * 86400_000 + jd.secondsOfDay * 1000 - 0.5 * 86400_000;
}

function jumpClockTo(viewer: Cesium.Viewer, ms: number): void {
  const seconds = ms / 1000;
  const dayNumber = 2440587 + Math.floor(seconds / 86400);
  const secondsOfDay = seconds - (dayNumber - 2440587) * 86400 + 0.5 * 86400;
  viewer.clock.currentTime = { dayNumber, secondsOfDay } as Cesium.JulianDate;
  viewer.scene.requestRender();
}
