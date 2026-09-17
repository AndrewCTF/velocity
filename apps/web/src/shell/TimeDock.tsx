import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { Icon } from '../normal/Icon.js';
import { apiFetch } from '../transport/http.js';
import { useTime } from '../state/stores.js';
import { usePolReplay } from '../state/polReplayStore.js';
import { installHistoryPlayback, type PlaybackController, type PlaybackInfo } from '../globe/HistoryPlayback.js';
import { CoverageStrip, type Coverage } from '../timeline/CoverageStrip.js';

// TimeDock — THE transport. Built from docs/mockups/console-2026-08
// (`12-map-replay.html`) and fed by the same density/events endpoints the old
// Timeline read, PLUS the one thing that was missing entirely: this is now
// the only place that installs HistoryPlayback and actually drives
// `viewer.clock`. Before this, Play flipped a store flag nothing read outside
// the 2D-only Timeline component, and seek() wrote local state alone — the
// clock never moved and no history ever loaded (docs/decisions.md, Wave 0).
//
// Four things this dock owns that the old one didn't:
// 1. THE CLOCK IS REAL. multiplier/playing drive `viewer.clock` directly, and
//    `installHistoryPlayback(viewer)` is installed here — the ONE transport
//    implementation (Timeline.tsx is now a thin wrapper around this).
// 2. DAY + TIME PICKERS DRIVE loadAt(). Replay starts at an arbitrary UTC
//    instant and plays forward from there — own archive when it's recent
//    enough, public tar1090 heatmap chunks (proxied, decoded client-side)
//    for aircraft further back than this box has recorded.
// 3. PATTERN-OF-LIFE IS WIRED HERE. EntityPanel's "Pattern of life" button
//    (usePolReplay) used to talk to Timeline; Timeline no longer owns a
//    controller, so this dock is the one subscriber now.
// 4. THE LABEL TELLS THE TRUTH: which source is playing, and the speed cap
//    while it's the upstream one (chunk pacing caps at 600x — 3600x would
//    mean loading multiple 9 MB chunks per second).

const WINDOWS = [
  { id: '1h', label: '1h', sec: 3_600 },
  { id: '6h', label: '6h', sec: 21_600 },
  { id: '24h', label: '24h', sec: 86_400 },
  { id: '3d', label: '3d', sec: 259_200 },
  { id: '7d', label: '7d', sec: 604_800 },
] as const;

const SPEEDS = [1, 10, 60, 600, 3600] as const;
const FALLBACK_MIN_DAY = '2024-01-01';
// Fallback retention until /api/history/stats answers — matches the config
// default (history_retention_hours = 168 -> 7 days). Only used to bound
// CoverageStrip's window; the day-picker's own min bound comes from the
// upstream coverage fetch below, since Wave 0 replay reaches further back
// than the own-archive retention window.
const DEFAULT_RETENTION_HOURS = 168;

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
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
// Human label for the retained buffer depth (e.g. "~7d", "~36h") — ported
// verbatim from timeline/Timeline.tsx's retentionDays().
function retentionLabel(hours: number): string {
  if (hours >= 48) return `~${Math.round(hours / 24)}d`;
  return `~${Math.round(hours)}h`;
}

// Cesium is imported as a TYPE here (the viewer is only ever handed to us by
// the caller), so JulianDate conversion is done by hand rather than via
// Cesium.JulianDate — the same shape Timeline.tsx used to build.
function jdToMs(jd: Cesium.JulianDate): number {
  return (jd.dayNumber - 2440587) * 86400_000 + jd.secondsOfDay * 1000 - 0.5 * 86400_000;
}
function msToJulian(ms: number): Cesium.JulianDate {
  const seconds = ms / 1000;
  const dayNumber = 2440587 + Math.floor(seconds / 86400);
  const secondsOfDay = seconds - (dayNumber - 2440587) * 86400 + 0.5 * 86400;
  return { dayNumber, secondsOfDay } as Cesium.JulianDate;
}

/**
 * Next speed along the SPEEDS ladder, clamped at both ends.
 *
 * Exported so the keyboard bindings are testable without mounting Cesium —
 * moved here from timeline/Timeline.tsx (re-exported there for
 * `timeline/transport.test.ts`, which this dock's brief does not own).
 */
export function stepSpeed(current: number, dir: 1 | -1): number {
  const i = SPEEDS.indexOf(current as (typeof SPEEDS)[number]);
  const from = i < 0 ? 0 : i;
  const next = Math.max(0, Math.min(SPEEDS.length - 1, from + dir));
  return SPEEDS[next] ?? SPEEDS[0];
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

  // ── The real transport ───────────────────────────────────────────────────
  const ctrlRef = useRef<PlaybackController | null>(null);
  const [playbackInfo, setPlaybackInfo] = useState<PlaybackInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [replayDay, setReplayDay] = useState('');
  const [replayTime, setReplayTime] = useState('00:00');
  const [minDay, setMinDay] = useState(FALLBACK_MIN_DAY);
  const maxDay = isoDay(Date.now());
  // Own-archive coverage (recording_since / N GB / M fixes) + retention, for
  // the ownership chip and the "picked day precedes real depth" warning —
  // restored from timeline/Timeline.tsx (docs/replay-flagship-plan.md §3).
  const [retentionHours, setRetentionHours] = useState<number>(DEFAULT_RETENTION_HOURS);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  // Upstream (tar1090 heatmap) reachability by day, for the second coverage
  // row (here-is-some-feedback-cuddly-pond.md §1.2: "in a second row,
  // upstream availability").
  const [upstreamDays, setUpstreamDays] = useState<{ day: string; hosts: string[] }[]>([]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const ctrl = installHistoryPlayback(viewer);
    ctrlRef.current = ctrl;
    return () => {
      ctrl.destroy();
      ctrlRef.current = null;
    };
  }, [viewer]);

  // The store's playing/multiplier drive the real clock directly — the bug
  // this dock exists to fix. Runs whether or not a replay is loaded: while
  // live, it pauses/resumes and paces the live clock the same way.
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    viewer.clock.multiplier = multiplier;
    viewer.clock.shouldAnimate = playing;
  }, [viewer, multiplier, playing]);

  // Earliest day upstream heatmap chunks actually cover, for the day-picker's
  // min bound AND the second coverage row below. Falls back to 2024-01-01 on
  // any error/degraded answer — never blocks the picker on a route the
  // backend may not have deployed yet.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiFetch(`/api/history/upstream/coverage?from=${FALLBACK_MIN_DAY}&to=${maxDay}`);
        if (!r.ok) return;
        const j = (await r.json()) as { days?: { day: string; hosts?: string[] }[] };
        const days = (j.days ?? []).map((d) => ({ day: d.day, hosts: d.hosts ?? [] }));
        if (cancelled) return;
        setUpstreamDays(days);
        const reachable = days.filter((d) => d.hosts.length > 0).map((d) => d.day).sort();
        if (reachable.length > 0) setMinDay(reachable[0]!);
      } catch {
        /* keep the 2024-01-01 fallback; the second row renders "not yet known" */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effective (clamped) retention from /api/history/stats — bounds
  // CoverageStrip's window the same way Timeline.tsx did. Degrades silently
  // to DEFAULT_RETENTION_HOURS on error.
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

  // Pattern-of-life: EntityPanel's "Pattern of life" button bumps polSeq via
  // usePolReplay → replay just that entity's recorded track (+ dwell
  // clusters). This dock is the one subscriber now that Timeline no longer
  // owns a controller.
  const polSeq = usePolReplay((s) => s.seq);
  useEffect(() => {
    if (polSeq === 0) return;
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    const { targetId, windowSec: polWindowSec } = usePolReplay.getState();
    void (async () => {
      if (!targetId) {
        ctrl.clear();
        setPlaybackInfo(null);
        setLive(true);
        return;
      }
      setLoading(true);
      const info = await ctrl.load(polWindowSec, targetId);
      setPlaybackInfo(info);
      setLive(false);
      setLoading(false);
    })();
  }, [polSeq]);

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
      const clamped = Math.max(from, Math.min(to, ms));
      setClockMs(clamped);
      if (viewer && !viewer.isDestroyed()) {
        viewer.clock.currentTime = msToJulian(clamped);
        viewer.scene.requestRender();
      }
    },
    [from, to, viewer],
  );

  const goLive = useCallback(() => {
    ctrlRef.current?.clear();
    setPlaybackInfo(null);
    setReplayDay('');
    setLive(true);
    const now = Date.now();
    setClockMs(now);
    if (viewer && !viewer.isDestroyed()) {
      viewer.clock.currentTime = msToJulian(now);
      viewer.scene.requestRender();
    }
  }, [viewer]);

  // Day/time picker → loadAt(). Replays from the picked UTC instant forward
  // to "now" (the live edge) — tar1090's own picker treats a day pick as a
  // fresh session, so this does too, resetting any prior replay window.
  const applyReplayStart = useCallback(
    (day: string, time: string) => {
      const ctrl = ctrlRef.current;
      if (!ctrl || !day) return;
      const startMs = Date.parse(`${day}T${time || '00:00'}:00Z`);
      const endMs = Date.now();
      if (!Number.isFinite(startMs) || endMs - startMs < 60_000) return;
      setLive(false);
      setLoading(true);
      void ctrl.loadAt(startMs, endMs, (info) => setPlaybackInfo(info)).then((info) => {
        setPlaybackInfo(info);
        setLoading(false);
        if (viewer && !viewer.isDestroyed()) {
          setClockMs(jdToMs(viewer.clock.currentTime));
        }
      });
    },
    [viewer],
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

  // Ownership chip — "recording since <date> · <N> GB · <M> fixes", sourced
  // from the /api/history/coverage response CoverageStrip already fetches
  // (docs/replay-flagship-plan.md §3). Falls back to nothing (the source
  // label alone) until the first successful response lands.
  const ownershipChip =
    coverage && coverage.recording_since
      ? `recording since ${isoDay(coverage.recording_since * 1000)} · ${(coverage.total_bytes / 1024 ** 3).toFixed(1)} GB · ${coverage.row_count.toLocaleString()} fixes`
      : null;

  // Truth vs. what Wave 0 changed: before, a day before the own archive's
  // real depth was an EMPTY replay with no explanation. Now aircraft still
  // replay from the upstream archive that far back — only VESSELS (own
  // archive only, no upstream fallback) go missing. The warning is reworded
  // for that, not dropped: `oldest_ts` (the coverage endpoint's honest floor)
  // still tells the operator where the own archive actually starts.
  const earliestAvailableDay = coverage?.oldest_ts ? isoDay(coverage.oldest_ts * 1000) : null;
  const replayDayBeforeAvailable = Boolean(
    replayDay && earliestAvailableDay && replayDay < earliestAvailableDay,
  );

  // Cap the speed ladder at 600x while the currently-loaded chunk's aircraft
  // are coming from the upstream (adsb.fi) archive — 3600x would mean loading
  // several 9 MB global chunks a second. Own-archive-only chunks keep 3600x.
  const maxMultiplier = playbackInfo?.maxMultiplier ?? 3600;
  useEffect(() => {
    if (multiplier > maxMultiplier) setMultiplier(maxMultiplier);
  }, [maxMultiplier, multiplier, setMultiplier]);

  // ── Keyboard transport ──────────────────────────────────────────────────
  // Every shortcut this dock prints (space, the 15s/frame buttons' titles) has
  // a listener — apps/web/CLAUDE.md "Controls state what they do". Ignored
  // while typing (input/textarea/select/contenteditable).
  useEffect(() => {
    const typing = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || typeof el.tagName !== 'string') return false;
      if (el.isContentEditable) return true;
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(clockMs - (e.shiftKey ? span / 20 : span / Math.max(1, bars.length || 240)));
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(clockMs + (e.shiftKey ? span / 20 : span / Math.max(1, bars.length || 240)));
          break;
        case ',':
          e.preventDefault();
          setMultiplier(Math.min(maxMultiplier, stepSpeed(multiplier, -1)));
          break;
        case '.':
          e.preventDefault();
          setMultiplier(Math.min(maxMultiplier, stepSpeed(multiplier, 1)));
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          goLive();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seek, clockMs, span, bars.length, multiplier, maxMultiplier, setMultiplier, goLive]);

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
        <TBtn label="Rewind" onClick={() => setMultiplier(Math.max(1, Math.min(maxMultiplier, multiplier / 10)))}>
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
          className="mx-[2px] flex h-5 items-center gap-1 rounded-sm bg-accent px-3 text-[12px] text-(--on-accent) hover:brightness-110"
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
        <TBtn label="Fast forward" onClick={() => setMultiplier(Math.min(maxMultiplier, multiplier * 10))}>
          <Icon name="fast-forward" className="h-3 w-3" />
        </TBtn>
        <button
          type="button"
          onClick={goLive}
          aria-pressed={live}
          title="Return to live (L)"
          className={`ml-[2px] h-5 rounded-sm px-[10px] text-[12px] ${
            live ? 'bg-bg-3 text-txt-1' : 'bg-alert text-(--on-alert)'
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
              onClick={() => setMultiplier(Math.min(maxMultiplier, s))}
              disabled={s > maxMultiplier}
              aria-pressed={multiplier === s}
              title={s > maxMultiplier ? `capped at ${maxMultiplier}x while replaying the upstream archive` : `${s}x`}
              className={`mono h-5 border-r border-line-2 px-2 text-[12px] last:border-r-0 disabled:opacity-40 ${
                multiplier === s ? 'bg-accent text-(--on-accent)' : 'text-txt-2 hover:bg-(--hover)'
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
                windowSec === w.sec ? 'bg-accent text-(--on-accent)' : 'text-txt-2 hover:bg-(--hover)'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Day/time replay — pick a UTC instant to run the world back from.
          Bounded by the earliest day the upstream heatmap actually covers. */}
      <div className="flex h-[26px] items-center gap-[6px] border-t border-line px-[10px]">
        <span className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3">replay from</span>
        <input
          type="date"
          value={replayDay}
          min={minDay}
          max={maxDay}
          aria-label="Replay start day"
          title={
            earliestAvailableDay
              ? `Replay a UTC day · own archive (aircraft + vessels) available from ${earliestAvailableDay} · aircraft continue further back from the upstream archive`
              : `Replay a UTC day · keyless back to ${minDay} (aircraft, upstream archive)`
          }
          onChange={(e) => {
            setReplayDay(e.target.value);
            applyReplayStart(e.target.value, replayTime);
          }}
          className="mono text-[10px] tabular-nums px-1.5 py-1 rounded-sm border border-line bg-bg-2 text-txt-1 focus:outline-hidden focus:border-accent-line scheme-dark"
        />
        <input
          type="time"
          value={replayTime}
          aria-label="Replay start time (UTC)"
          onChange={(e) => {
            setReplayTime(e.target.value);
            if (replayDay) applyReplayStart(replayDay, e.target.value);
          }}
          className="mono text-[10px] tabular-nums px-1.5 py-1 rounded-sm border border-line bg-bg-2 text-txt-1 focus:outline-hidden focus:border-accent-line scheme-dark"
        />
        <span className="mono text-[10px] text-txt-4">
          {loading ? 'loading…' : playbackInfo ? playbackInfo.label : `keyless back to ${minDay}`}
          {ownershipChip ? ` · ${ownershipChip}` : ` · ${retentionLabel(retentionHours)} own-archive buffer`}
        </span>
        {replayDayBeforeAvailable && (
          <span
            className="mono text-[10px] text-txt-4"
            title="The byte cap already pruned own-archive positions older than this. Aircraft still replay from the upstream archive; vessels have no upstream fallback."
          >
            vessels unavailable before {earliestAvailableDay} (own archive only)
          </span>
        )}
      </div>

      {/* Coverage — two rows: the own archive's real recorded-fix density per
          hour (CoverageStrip, existing component, unchanged), and which days
          the upstream heatmap actually covers (here-is-some-feedback-cuddly-
          pond.md §1.2 "in a second row, upstream availability"). Both sit
          directly under the day/time picker, same as Timeline.tsx used to. */}
      <div className="flex flex-col gap-[3px] border-t border-line px-[10px] py-[4px]">
        <CoverageStrip windowHours={retentionHours} onCoverage={setCoverage} />
        <UpstreamAvailabilityRow days={upstreamDays} />
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
          <span className="mono pointer-events-none absolute inset-y-0 left-0 z-1 flex items-center gap-[5px] bg-bg-1/90 pl-[10px] pr-[7px] text-[10px] uppercase tracking-[0.5px] text-txt-3">
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
            className={`mono absolute top-[2px] whitespace-nowrap rounded-[1px] bg-mag px-[5px] text-[10px] text-(--on-mag) ${
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

/** Second coverage row: which UTC days the upstream (tar1090) heatmap
 *  archive actually has, one thin bar per day across the fetched range
 *  (`FALLBACK_MIN_DAY`..today). "on" = at least one host reported that day —
 *  mirrors CoverageStrip's own "draw the gap, don't hide it" rule so a day
 *  nobody has archived reads as a stated gap, not empty background. */
function UpstreamAvailabilityRow({ days }: { days: { day: string; hosts: string[] }[] }): JSX.Element {
  if (days.length === 0) {
    return (
      <div className="mono text-[10px] text-txt-4" role="img" aria-label="Upstream archive availability: not yet known">
        upstream archive availability: not yet known
      </div>
    );
  }
  const reachableCount = days.filter((d) => d.hosts.length > 0).length;
  const label = `Upstream archive availability: ${reachableCount} of ${days.length} days reachable`;
  return (
    <div
      className="relative h-[6px] w-full bg-bg-3 border border-line rounded-sm overflow-hidden"
      role="img"
      aria-label={label}
      title={label}
    >
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${days.length} 100`}>
        {days.map((d, i) => (
          <rect
            key={d.day}
            x={i}
            y={0}
            width={1}
            height={100}
            fill={d.hosts.length > 0 ? 'var(--accent)' : 'var(--alert)'}
            opacity={d.hosts.length > 0 ? 0.7 : 0.22}
          />
        ))}
      </svg>
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
      className="mono flex h-5 min-w-5 items-center gap-[3px] rounded-sm px-[6px] text-[11px] text-txt-1 hover:bg-(--hover) hover:text-txt-0"
    >
      {children}
    </button>
  );
}
