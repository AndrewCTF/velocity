import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Icon } from '../normal/Icon.js';
import { apiFetch } from '../transport/http.js';
import { useTime } from '../state/stores.js';

// TimeDock — the transport, built from docs/mockups/console-2026-08
// (`12-map-replay.html`) and fed by the same endpoints the old Timeline read.
//
// This is not the old Timeline restyled. Three things are different, and they
// are the reasons the old one was hard to drive:
//
// 1. THE SCRUB AXIS FOLLOWS THE WINDOW. The old strip requested a fixed
//    `window_sec=72000` and derived the playhead, both seek targets and the
//    keyboard clamp from that one response. So during a 3d or 7d replay the
//    playhead pegged at 0 % and the strip could not reach the data that was
//    playing. The route already accepted 72 h; nothing asked for it.
// 2. THE CONTROLS EXIST. Skip back and forward 15 s, frame step, and a Live
//    button are on screen. The old dock had three buttons and hid the rest
//    behind keys nothing advertised.
// 3. THE LABEL TELLS THE TRUTH. It states the range actually loaded rather
//    than always printing `now − window`.

const WINDOWS = [
  { id: '1h', label: '1h', sec: 3_600 },
  { id: '6h', label: '6h', sec: 21_600 },
  { id: '24h', label: '24h', sec: 86_400 },
  { id: '3d', label: '3d', sec: 259_200 },
  { id: '7d', label: '7d', sec: 604_800 },
] as const;

const SPEEDS = [1, 10, 60, 600, 3600] as const;

interface Density {
  from: number;
  to: number;
  bins: number;
  detections: number[];
  alerts: number[];
}
interface LaneEvent {
  t: number;
  label: string;
  severity?: string | null;
}
interface Lane {
  id: string;
  label: string;
  color: string;
  events: LaneEvent[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} Z`;
}
function tickLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function TimeDock({ viewer }: { viewer?: Cesium.Viewer | null }): JSX.Element {
  const playing = useTime((s) => s.playing);
  const togglePlay = useTime((s) => s.togglePlay);
  const multiplier = useTime((s) => s.multiplier);
  const setMultiplier = useTime((s) => s.setMultiplier);

  // 1h, which is both what the reference selects by default and the only value
  // in WINDOWS. The old default of 72,000 s matched no chip, so the window row
  // rendered with nothing selected, and it drew a 20-hour axis over a buffer
  // that held ~90 minutes: 92% of the strip was empty black with every bar
  // crushed against the right edge.
  const [windowSec, setWindowSec] = useState<number>(3_600);
  const [density, setDensity] = useState<Density | null>(null);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [clockMs, setClockMs] = useState<number>(() => Date.now());
  const [live, setLive] = useState(true);
  const strip = useRef<HTMLDivElement | null>(null);

  // Both series follow the SELECTED window, which is the fix: the axis and the
  // data that is playing are now the same span.
  useEffect(() => {
    let abort: AbortController | null = null;
    const pull = async (): Promise<void> => {
      abort?.abort();
      abort = new AbortController();
      try {
        const [d, e] = await Promise.all([
          apiFetch(`/api/timeline/density?bins=240&window_sec=${windowSec}`, { signal: abort.signal }),
          apiFetch(`/api/timeline/events?window_sec=${windowSec}`, { signal: abort.signal }),
        ]);
        if (d.ok) setDensity((await d.json()) as Density);
        if (e.ok) setLanes((((await e.json()) as { lanes?: Lane[] }).lanes ?? []) as Lane[]);
      } catch {
        /* keep the last good series rather than blanking the strip */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 5_000);
    return () => {
      window.clearInterval(id);
      abort?.abort();
    };
  }, [windowSec]);

  // The clock reads from the viewer when there is one, so replay and live agree.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      const id = window.setInterval(() => setClockMs(Date.now()), 250);
      return () => window.clearInterval(id);
    }
    const onTick = viewer.clock.onTick.addEventListener(() => {
      const jd = viewer.clock.currentTime;
      setClockMs(jd ? Date.parse(jd.toString()) : Date.now());
    });
    return () => onTick();
  }, [viewer]);

  const from = density?.from ?? Date.now() - windowSec * 1000;
  const to = density?.to ?? Date.now();
  const span = Math.max(1, to - from);
  const playPct = Math.max(0, Math.min(100, ((clockMs - from) / span) * 100));

  const seek = useCallback(
    (ms: number) => {
      setLive(false);
      setClockMs(Math.max(from, Math.min(to, ms)));
    },
    [from, to],
  );

  const onScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = strip.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      seek(from + ((e.clientX - r.left) / Math.max(1, r.width)) * span);
    },
    [from, span, seek],
  );

  const ticks = useMemo(() => {
    const out: Array<{ pct: number; label: string }> = [];
    for (let i = 0; i <= 6; i++) out.push({ pct: (i / 6) * 100, label: tickLabel(from + (span * i) / 6) });
    return out;
  }, [from, span]);

  const bars = density?.detections ?? [];
  const peak = Math.max(1, ...bars);
  const alerts = density?.alerts ?? [];

  return (
    <div className="select-none text-[12px]">
      {/* Transport. One filled primary, a red Live, and every control the old
          dock hid behind an unadvertised key. */}
      <div className="flex h-[30px] items-center gap-[3px] px-[10px]">
        <span className="mono min-w-[96px] text-[13px] tracking-[0.3px] text-accent-fg">
          {stamp(clockMs)}
        </span>
        <span className="flex-1" />
        <TBtn label="Jump to start" onClick={() => seek(from)}>
          <Icon name="step-b" className="h-3 w-3" />
        </TBtn>
        <TBtn label="Rewind" onClick={() => setMultiplier(Math.max(1, multiplier / 10))}>
          <Icon name="rewind" className="h-3 w-3" />
        </TBtn>
        <TBtn label="Back 15 seconds" onClick={() => seek(clockMs - 15_000)}>
          <Icon name="back-15" className="h-3 w-3" />
          15s
        </TBtn>
        <TBtn label="Step back" onClick={() => seek(clockMs - span / 240)}>
          <Icon name="frame-b" className="h-3 w-3" />
        </TBtn>
        <button
          type="button"
          onClick={togglePlay}
          title="Play or pause (space)"
          className="mx-[2px] flex h-5 items-center gap-1 rounded-sm bg-accent px-3 text-[12px] text-white hover:brightness-110"
        >
          <Icon name={playing ? 'pause' : 'play'} className="h-3 w-3" />
          {playing ? 'Pause' : 'Play'}
        </button>
        <TBtn label="Step forward" onClick={() => seek(clockMs + span / 240)}>
          <Icon name="frame-f" className="h-3 w-3" />
        </TBtn>
        <TBtn label="Forward 15 seconds" onClick={() => seek(clockMs + 15_000)}>
          15s
          <Icon name="fwd-15" className="h-3 w-3" />
        </TBtn>
        <TBtn label="Fast forward" onClick={() => setMultiplier(Math.min(3600, multiplier * 10))}>
          <Icon name="fast-forward" className="h-3 w-3" />
        </TBtn>
        <button
          type="button"
          onClick={() => {
            setLive(true);
            setClockMs(Date.now());
          }}
          aria-pressed={live}
          title="Return to live"
          className={`ml-[2px] h-5 rounded-sm px-[10px] text-[12px] ${
            live ? 'bg-bg-3 text-txt-2' : 'bg-alert text-white'
          }`}
        >
          Live
        </button>
        <span className="flex-1" />
        <div className="flex overflow-hidden rounded-sm border border-line-2">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setMultiplier(s)}
              aria-pressed={multiplier === s}
              className={`mono h-5 border-r border-line-2 px-2 text-[12px] last:border-r-0 ${
                multiplier === s ? 'bg-accent text-white' : 'text-txt-2 hover:bg-[var(--hover)]'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
        <div className="ml-2 flex overflow-hidden rounded-sm border border-line-2">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWindowSec(w.sec)}
              aria-pressed={windowSec === w.sec}
              className={`mono h-5 border-r border-line-2 px-2 text-[12px] last:border-r-0 ${
                windowSec === w.sec ? 'bg-accent text-white' : 'text-txt-2 hover:bg-[var(--hover)]'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tick ruler. */}
      <div className="relative h-[22px] border-t border-line">
        {ticks.map((t) => (
          <span key={t.pct}>
            <i className="absolute top-0 h-[5px] w-px bg-bg-4" style={{ left: `${t.pct}%` }} />
            <span
              className="mono absolute top-[5px] translate-x-[3px] text-[10px] text-txt-3"
              style={{ left: `${t.pct}%` }}
            >
              {t.label}
            </span>
          </span>
        ))}
      </div>

      {/* One NAMED row per lane, which is what the reference does. All the
          lanes used to share a single 10px unlabelled band of 4px triangles:
          193 incidents and 200 signal events in the same hour drew as one
          undifferentiated sawtooth and nothing said which colour meant what. */}
      {lanes.map((lane) => (
        <div key={lane.id} className="relative h-[14px] border-t border-line">
          {/* The label rides OVER the left of the track rather than taking a
              gutter out of it, so a mark at 30% of the hour lines up with the
              30% tick above it and the 30% density bar below it. */}
          <span className="mono pointer-events-none absolute inset-y-0 left-0 z-[1] flex items-center gap-[5px] bg-bg-1/90 pl-[10px] pr-[7px] text-[10px] uppercase tracking-[0.5px] text-txt-3">
            <i
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: lane.color || 'var(--warn)' }}
            />
            {lane.label}
          </span>
          <span className="absolute inset-0">
            {lane.events.map((ev, i) => {
              const pct = ((ev.t - from) / span) * 100;
              if (pct < 0 || pct > 100) return null;
              return (
                <button
                  key={`${lane.id}-${i}`}
                  type="button"
                  title={`${lane.label}: ${ev.label}`}
                  onClick={() => seek(ev.t)}
                  className="absolute top-[3px] h-[8px] w-[2px]"
                  style={{ left: `${pct}%`, background: lane.color || 'var(--warn)' }}
                />
              );
            })}
          </span>
        </div>
      ))}

      {/* Density is the drag surface. */}
      <div
        ref={strip}
        role="slider"
        tabIndex={0}
        aria-label="Scrub replay position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(playPct)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onScrub(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) onScrub(e);
        }}
        className="relative h-[34px] cursor-ew-resize border-t border-line bg-bg-0"
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="block h-full w-full">
          {bars.map((v, i) => {
            const h = (v / peak) * 100;
            return (
              <rect
                key={i}
                x={(i / bars.length) * 100}
                y={100 - h}
                width={(100 / bars.length) * 0.74}
                height={h}
                fill={alerts[i] ? 'var(--alert)' : 'var(--ok)'}
              />
            );
          })}
        </svg>
        {/* The stamp hugs whichever side of the playhead has room. Centred on
            the line, it hung half outside the dock at the live end, which is
            where the playhead sits every time the console is opened. */}
        <span
          className="pointer-events-none absolute inset-y-0 w-[2px] bg-mag"
          style={{ left: `${playPct}%` }}
        >
          <span
            className={`mono absolute top-[2px] whitespace-nowrap rounded-[1px] bg-mag px-[5px] text-[10px] text-white ${
              playPct > 88 ? 'right-[3px]' : playPct < 6 ? 'left-[3px]' : '-translate-x-1/2'
            }`}
          >
            {stamp(clockMs)}
          </span>
        </span>
      </div>

      <div className="flex h-5 items-center gap-3 border-t border-line px-[10px] text-[12px] text-txt-3">
        {/* States the range actually loaded, not `now − window`. */}
        <span>
          {live ? 'Live' : 'Replay'} &middot; {tickLabel(from)} to {tickLabel(to)} Z
        </span>
        <span className="flex-1" />
        <span>{bars.length} bins</span>
      </div>
    </div>
  );
}

function TBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="mono flex h-5 min-w-5 items-center gap-[3px] rounded-sm px-[6px] text-[11px] text-txt-1 hover:bg-[var(--hover)] hover:text-txt-0"
    >
      {children}
    </button>
  );
}
