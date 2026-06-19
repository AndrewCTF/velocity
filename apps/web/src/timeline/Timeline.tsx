import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useTime } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';
import { installHistoryPlayback, type PlaybackController, type PlaybackInfo } from '../globe/HistoryPlayback.js';
import { MicroLabel } from '../shell/instruments.js';

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
    if (!viewer || viewer.isDestroyed()) return;
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

  // Real scrub position: where the simulation clock sits inside the density
  // window [from, to]. stamp is the live clock time, so this tracks the actual
  // playhead — no fabricated animation. Falls back to the right edge ("now")
  // until a density window is loaded.
  const clockMs = Date.parse(stamp.replace(' ', 'T'));
  const playPct =
    density && Number.isFinite(clockMs) && density.to > density.from
      ? Math.max(0, Math.min(100, ((clockMs - density.from) / (density.to - density.from)) * 100))
      : 100;

  // Seek to either edge of the loaded density window, reusing the same
  // clock-jump math the strip-click already uses (real behaviour, no fakery).
  const seekTo = (ms: number): void => {
    if (!viewer) return;
    jumpClockTo(viewer, ms);
    setStamp(isoStamp(ms));
  };

  return (
    <div className="h-full flex flex-col" style={{ padding: '9px 14px', gap: '7px' }}>
      {/* ── Row 1 · transport ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => density && seekTo(density.from)}
            disabled={!viewer || !density}
            aria-label="Jump to window start"
            className="tb w-6 h-6 grid place-items-center mono text-[11px] rounded-sm border border-line bg-bg-2 text-txt-2 hover:border-accent-line hover:text-txt-1 disabled:opacity-40"
          >
            ⏮
          </button>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? 'Pause' : 'Play'}
            aria-pressed={playing}
            className={`tb w-6 h-6 grid place-items-center mono text-[11px] rounded-sm border ${
              playing
                ? 'border-accent-line bg-accent-dim text-accent'
                : 'border-line bg-bg-2 text-txt-1 hover:border-accent-line'
            }`}
          >
            {playing ? '◼' : '▶'}
          </button>
          <button
            type="button"
            onClick={() => density && seekTo(density.to)}
            disabled={!viewer || !density}
            aria-label="Jump to now"
            className="tb w-6 h-6 grid place-items-center mono text-[11px] rounded-sm border border-line bg-bg-2 text-txt-2 hover:border-accent-line hover:text-txt-1 disabled:opacity-40"
          >
            ⏭
          </button>
        </div>

        <span className="w-px h-4 bg-line shrink-0" />

        <div className="flex items-center gap-1.5">
          <MicroLabel>spd</MicroLabel>
          <div className="flex items-center rounded-sm border border-line overflow-hidden">
            {SPEEDS.map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => setMultiplier(s)}
                aria-pressed={multiplier === s}
                aria-label={`${s} times speed`}
                className={`mono text-[10px] tabular-nums px-1.5 py-1 ${
                  i > 0 ? 'border-l border-line' : ''
                } ${
                  multiplier === s
                    ? 'bg-accent-dim text-accent'
                    : 'bg-bg-2 text-txt-2 hover:text-txt-1'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <span className="w-px h-4 bg-line shrink-0" />

        <div className="flex items-center gap-1.5" aria-label="Historical replay">
          <MicroLabel>rpl</MicroLabel>
          <div className="flex items-center rounded-sm border border-line overflow-hidden">
            {REPLAY_WINDOWS.map((w, i) => (
              <button
                key={w.sec}
                type="button"
                onClick={() => setReplayWindow(w.sec)}
                disabled={replay.active}
                aria-pressed={replayWindow === w.sec}
                className={`mono text-[10px] px-1.5 py-1 disabled:opacity-40 ${
                  i > 0 ? 'border-l border-line' : ''
                } ${
                  replayWindow === w.sec
                    ? 'bg-accent-dim text-accent'
                    : 'bg-bg-2 text-txt-2 hover:text-txt-1'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void toggleReplay()}
            disabled={replay.loading}
            aria-pressed={replay.active}
            className={`mono text-[10px] tracking-[0.3px] px-2 py-1 rounded-sm border ${
              replay.active
                ? 'border-accent-line bg-accent-dim text-accent'
                : 'border-line bg-bg-2 text-txt-1 hover:border-accent-line'
            } disabled:opacity-40`}
          >
            {replay.loading ? '…' : replay.active ? '◼ exit' : '▶ replay'}
          </button>
          {replay.active && replay.info && (
            <span className="mono text-[9px] tabular-nums text-txt-3">
              {replay.info.tracks}t·{replay.info.points}p
            </span>
          )}
        </div>

        <span className="flex-1" />

        <span className="mono text-[10px] tabular-nums tracking-[0.3px] text-txt-1">
          {replay.active && (
            <span className="text-txt-3">
              replay {fmtClock(Date.now() - replayWindow * 1000)}–now ·{' '}
            </span>
          )}
          {stamp}
        </span>
      </div>

      {/* ── Row 2 · scrub ──────────────────────────────────────────────── */}
      <div className="scrub relative h-[6px] bg-bg-3 rounded-sm overflow-visible">
        <span
          className="absolute left-0 top-0 bottom-0 bg-accent-dim rounded-sm"
          style={{ width: `${playPct}%` }}
        />
        <span
          className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-accent rounded-full"
          style={{ left: `calc(${playPct}% - 1px)` }}
        />
      </div>

      {/* ── Row 3 · density strip ──────────────────────────────────────── */}
      <div className="dens flex-1 flex flex-col gap-1 min-h-0">
        <div
          ref={stripRef}
          className="relative flex-1 min-h-[30px] border border-line rounded-sm bg-bg-2 overflow-hidden select-none cursor-crosshair"
          onMouseDown={onStripMouseDown}
          onMouseMove={onStripMouseMove}
          onMouseUp={onStripMouseUp}
          onMouseLeave={() => setDrag(null)}
        >
          <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${bins} 100`}>
            {/* faint vertical gridlines */}
            {[...Array(11)].map((_, i) => {
              const x = (bins / 12) * (i + 1);
              return (
                <line
                  key={`v${i}`}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={100}
                  stroke="var(--line)"
                  strokeWidth="0.5"
                  opacity={0.5}
                />
              );
            })}
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
        </div>

        {/* legend + window/total labels */}
        <div className="flex items-center gap-3 text-txt-3">
          <span className="mono text-[8.5px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-[2px] bg-alert" />alert
            <span className="tabular-nums text-txt-2 ml-0.5">{totalAlert.toLocaleString()}</span>
          </span>
          <span className="mono text-[8.5px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-[2px] bg-ok" />detection
            <span className="tabular-nums text-txt-2 ml-0.5">{totalDet.toLocaleString()}</span>
          </span>
          <span className="mono text-[8.5px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-2 bg-bg-3 border border-line" />density
          </span>
          <span className="flex-1" />
          <span className="mono text-[8.5px] uppercase tracking-[0.5px] text-txt-4">−20h</span>
          <span className="mono text-[8.5px] uppercase tracking-[0.5px] text-txt-3">now</span>
        </div>
      </div>
    </div>
  );
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
