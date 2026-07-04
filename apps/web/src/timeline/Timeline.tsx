import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useTime, useSelection } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';
import { flyToPosition } from '../globe/camera.js';
import { installHistoryPlayback, type PlaybackController, type PlaybackInfo } from '../globe/HistoryPlayback.js';
import { usePolReplay } from '../state/polReplayStore.js';
import { MicroLabel } from '../shell/instruments.js';

interface Props {
  viewer?: Cesium.Viewer | null;
}

const SPEEDS = [1, 10, 60, 600, 3600] as const;
const REPLAY_WINDOWS = [
  { label: '1h', sec: 3600 },
  { label: '6h', sec: 21_600 },
  { label: '24h', sec: 86_400 },
  { label: '3d', sec: 259_200 },
  { label: '7d', sec: 604_800 },
] as const;
const POLL_MS = 5_000;
const DAY_SEC = 86_400;
const HOUR_SEC = 3_600;
// Fallback retention until /api/history/stats answers — matches the config
// default (history_retention_hours = 168 → 7 days). The real value (clamped
// server-side) replaces this so the day-picker only offers retained days.
const DEFAULT_RETENTION_HOURS = 168;

// "YYYY-MM-DD" in UTC for an epoch-ms instant (the store + globe are UTC).
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
// Midnight UTC (epoch seconds) at the start of a "YYYY-MM-DD" day string.
function dayStartSec(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 1000;
}

interface Density {
  from: number;
  to: number;
  bins: number;
  binWidthSec: number;
  detections: number[];
  alerts: number[];
  gaps: number[];
}

interface LaneEvent {
  t: number; // epoch ms
  label: string;
  lat?: number | null;
  lon?: number | null;
  ref_id?: string | null;
  severity?: string | null;
}
interface Lane {
  id: string;
  label: string;
  color: string;
  events: LaneEvent[];
}

export function Timeline({ viewer }: Props = {}): JSX.Element {
  const { playing, multiplier, togglePlay, setMultiplier } = useTime();
  const [stamp, setStamp] = useState(() => isoStamp(Date.now()));
  const [density, setDensity] = useState<Density | null>(null);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);

  // Historical playback (replay recorded tracks for the current view).
  const playbackRef = useRef<PlaybackController | null>(null);
  const [replayWindow, setReplayWindow] = useState<number>(3600);
  // Multi-day scrub: when a past day is picked we replay THAT day (00:00→24h,
  // or 00:00→now for today). Empty string = use the rolling-window presets.
  const [replayDay, setReplayDay] = useState<string>('');
  // Effective (clamped) retention from /api/history/stats — bounds how far the
  // day-picker can reach so we never offer to replay already-pruned days.
  const [retentionHours, setRetentionHours] = useState<number>(DEFAULT_RETENTION_HOURS);
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

  // Learn the effective retention window so the day-picker only offers days
  // that are actually retained (history.py clamps + self-caps; stats() reports
  // the clamped value). Degrades silently to the config default on error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiFetch('/api/history/stats');
        if (!r.ok) return;
        const s = (await r.json()) as { retention_hours?: number };
        if (!cancelled && typeof s.retention_hours === 'number' && s.retention_hours > 0) {
          setRetentionHours(s.retention_hours);
        }
      } catch {
        /* keep the default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Earliest retained day (UTC) and today — bounds for the <input type="date">.
  const nowMs = Date.now();
  const minDay = isoDay(nowMs - retentionHours * HOUR_SEC * 1000);
  const maxDay = isoDay(nowMs);

  // Pattern-of-life: EntityPanel's "Pattern of life" button bumps polSeq → replay
  // just that entity's recorded track (+ dwell clusters) on the timeline clock.
  const polSeq = usePolReplay((s) => s.seq);
  useEffect(() => {
    if (polSeq === 0) return;
    const ctrl = playbackRef.current;
    if (!ctrl) return;
    const { targetId, windowSec } = usePolReplay.getState();
    void (async () => {
      if (!targetId) {
        ctrl.clear();
        setReplay({ active: false, loading: false, info: null });
        return;
      }
      setReplay((r) => ({ ...r, loading: true }));
      const info = await ctrl.load(windowSec, targetId);
      setReplay({ active: ctrl.isActive(), loading: false, info });
    })();
  }, [polSeq]);

  const toggleReplay = async (): Promise<void> => {
    const ctrl = playbackRef.current;
    if (!ctrl) return;
    if (ctrl.isActive()) {
      ctrl.clear();
      setReplay({ active: false, loading: false, info: null });
      return;
    }
    setReplay((r) => ({ ...r, loading: true }));

    // Day-scrub: replay the SELECTED day. The controller only exposes
    // load(windowSec) = [now − windowSec, now], so to reach an older day we
    // size the window back to that day's 00:00 UTC, load it, then jump the
    // clock to the day's start (and stop the auto-advance at the day's end so
    // the operator scrubs that day, not all of it → now). For "today" this is
    // just 00:00→now, identical to the live window.
    if (replayDay) {
      const startSec = dayStartSec(replayDay);
      const nowSec = Date.now() / 1000;
      const windowSec = Math.max(60, Math.ceil(nowSec - startSec));
      const info = await ctrl.load(windowSec);
      // Position the playhead at the chosen day's 00:00 (real clock jump, same
      // math the strip-click uses — no fabricated motion).
      if (viewer && info) {
        const dayEndMs = Math.min(nowMs, (startSec + DAY_SEC) * 1000);
        jumpClockTo(viewer, startSec * 1000);
        setStamp(isoStamp(startSec * 1000));
        // Bound the loop to the single day so it doesn't run off into newer data.
        viewer.clock.stopTime = msToJulian(dayEndMs);
      }
      setReplay({ active: ctrl.isActive(), loading: false, info });
      return;
    }

    const info = await ctrl.load(replayWindow);
    setReplay({ active: ctrl.isActive(), loading: false, info });
  };

  // Drive Cesium clock from store state
  useEffect(() => {
    if (!viewer) return;
    const clock = viewer.clock;
    clock.multiplier = multiplier;
    clock.shouldAnimate = playing;
    // §5.2.5: throttle to 4 Hz. onTick fires every animated frame; a per-frame
    // setStamp re-renders the whole Timeline every frame. The clock LABEL doesn't
    // need more than 4 Hz.
    let lastStamp = 0;
    const off = clock.onTick.addEventListener(() => {
      const now = performance.now();
      if (now - lastStamp < 250) return;
      lastStamp = now;
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

  // Poll the discrete event lanes (incidents + signals) for the multi-track
  // scrubber. Same ~20h window as the density strip so they share the x-axis.
  useEffect(() => {
    let aborter: AbortController | null = null;
    const pull = async (): Promise<void> => {
      aborter?.abort();
      aborter = new AbortController();
      try {
        const r = await apiFetch('/api/timeline/events?window_sec=72000', { signal: aborter.signal });
        if (r.ok) setLanes(((await r.json()).lanes ?? []) as Lane[]);
      } catch {
        /* keep last lanes */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 30_000);
    return () => {
      window.clearInterval(id);
      aborter?.abort();
    };
  }, []);

  // Click a lane marker → fly to it, select it, and jump the clock to its time.
  const onMarker = (ev: LaneEvent): void => {
    if (!viewer) return;
    jumpClockTo(viewer, ev.t);
    setStamp(isoStamp(ev.t));
    if (typeof ev.lat === 'number' && typeof ev.lon === 'number') {
      flyToPosition(viewer, ev.lon, ev.lat, 600_000, 0.8);
    }
    if (ev.ref_id) useSelection.getState().select(ev.ref_id);
  };

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
                onClick={() => {
                  setReplayDay('');
                  setReplayWindow(w.sec);
                }}
                disabled={replay.active}
                aria-pressed={!replayDay && replayWindow === w.sec}
                title={`Replay the last ${w.label} ending now`}
                className={`mono text-[10px] px-1.5 py-1 disabled:opacity-40 ${
                  i > 0 ? 'border-l border-line' : ''
                } ${
                  !replayDay && replayWindow === w.sec
                    ? 'bg-accent-dim text-accent'
                    : 'bg-bg-2 text-txt-2 hover:text-txt-1'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          {/* Day picker — scrub a specific past day (multi-day, not just the
              live window). Bounded to the retained range so we never offer a
              pruned day. Empty = use the rolling-window presets above. */}
          <input
            type="date"
            value={replayDay}
            min={minDay}
            max={maxDay}
            disabled={replay.active}
            onChange={(e) => setReplayDay(e.target.value)}
            aria-label="Replay a specific day"
            title={`Replay a specific UTC day (retained back to ${minDay})`}
            className="mono text-[10px] tabular-nums px-1.5 py-1 rounded-sm border border-line bg-bg-2 text-txt-1 focus:outline-none focus:border-accent-line disabled:opacity-40 [color-scheme:dark]"
          />
          {replayDay && !replay.active && (
            <button
              type="button"
              onClick={() => setReplayDay('')}
              aria-label="Clear day selection"
              title="Back to rolling-window replay"
              className="mono text-[10px] px-1 py-1 rounded-sm border border-line bg-bg-2 text-txt-3 hover:text-txt-1 hover:border-accent-line"
            >
              ✕
            </button>
          )}
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
            <span className="mono text-[10px] tabular-nums text-txt-3">
              {replay.info.tracks}t·{replay.info.points}p
            </span>
          )}
          <span
            className="mono text-[10px] uppercase tracking-[0.5px] text-txt-4"
            title={`Position history is a rolling, size-capped buffer (~${retentionDays(retentionHours)} retained, then oldest fixes drop). Replay older than this is unavailable — no cold storage.`}
          >
            {retentionDays(retentionHours)} buffer
          </span>
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

      {/* ── Row 2.5 · event lanes (Gotham multi-track) ─────────────────── */}
      {density && lanes.some((l) => l.events.length > 0) && (
        <div className="flex flex-col gap-[3px]">
          {lanes.map((lane) => (
            <div key={lane.id} className="flex items-center gap-2">
              <span
                className="mono text-[10px] uppercase tracking-[0.4px] text-txt-3 w-[84px] shrink-0 truncate flex items-center gap-1"
                title={`${lane.label} · ${lane.events.length}`}
              >
                <span className="h-[6px] w-[6px] rounded-full shrink-0" style={{ background: lane.color }} />
                {lane.label}
              </span>
              <div className="relative flex-1 h-[12px] bg-bg-2 border border-line rounded-sm overflow-hidden">
                {lane.events.map((ev, i) => {
                  const pct = ((ev.t - density.from) / (density.to - density.from)) * 100;
                  if (pct < 0 || pct > 100) return null;
                  return (
                    <button
                      key={i}
                      type="button"
                      title={`${isoStamp(ev.t)} · ${ev.label}`}
                      onClick={() => onMarker(ev)}
                      aria-label={`${lane.label}: ${ev.label}`}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-[8px] w-[8px] rounded-full border border-black/40 hover:scale-150 transition-transform"
                      style={{ left: `${pct}%`, background: lane.color }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

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
          <span className="mono text-[10px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-[2px] bg-alert" />alert
            <span className="tabular-nums text-txt-2 ml-0.5">{totalAlert.toLocaleString()}</span>
          </span>
          <span className="mono text-[10px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-[2px] bg-ok" />detection
            <span className="tabular-nums text-txt-2 ml-0.5">{totalDet.toLocaleString()}</span>
          </span>
          <span className="mono text-[10px] uppercase tracking-[0.5px] flex items-center gap-1">
            <i className="inline-block w-2 h-2 bg-bg-3 border border-line" />density
          </span>
          <span className="flex-1" />
          <span className="mono text-[10px] uppercase tracking-[0.5px] text-txt-4">−20h</span>
          <span className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3">now</span>
        </div>
      </div>
    </div>
  );
}

// Human label for the retained buffer depth (e.g. "~7d", "~36h").
function retentionDays(hours: number): string {
  if (hours >= 48) return `~${Math.round(hours / 24)}d`;
  return `~${Math.round(hours)}h`;
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

function msToJulian(ms: number): Cesium.JulianDate {
  const seconds = ms / 1000;
  const dayNumber = 2440587 + Math.floor(seconds / 86400);
  const secondsOfDay = seconds - (dayNumber - 2440587) * 86400 + 0.5 * 86400;
  return { dayNumber, secondsOfDay } as Cesium.JulianDate;
}

function jumpClockTo(viewer: Cesium.Viewer, ms: number): void {
  viewer.clock.currentTime = msToJulian(ms);
  viewer.scene.requestRender();
}
