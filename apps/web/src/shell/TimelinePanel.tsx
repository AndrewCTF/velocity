import { useEffect, useRef, useState } from "react";
import { BpIcon } from "./BpIcon.js";

// The Timeline panel (reference feature page G23, gotham/gotham/features-a.html
// lines 78-84; comments only). A 38px title bar with the previous / next / Play
// transport and the view icons, a day ruler, one row of event tiles per lane,
// the playhead with its time tag, the lane legend with live counts and the
// range bar. Geometry is the copy's; the tiles are the real
// /api/timeline/events lanes TimeDock already polls, binned onto the copy's
// 46px tile pitch (one tile per occupied cell, its title says how many events
// it holds). Colours are tokens (console.css `--c-tlp-*`), the copy's hex under
// the slate scheme.

export interface TimelineLane {
  id: string;
  label: string;
  events: ReadonlyArray<{ t: number; label: string }>;
}

const TILE = 46; // the copy's tile pitch
const LEGEND_W = 205;

const pad = (n: number): string => String(n).padStart(2, "0");
function ordinal(d: number): string {
  const t = d % 100;
  if (t >= 11 && t <= 13) return `${d}th`;
  return `${d}${["th", "st", "nd", "rd"][d % 10] ?? "th"}`;
}
function dayText(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} ${ordinal(d.getUTCDate())}`;
}
function hm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function hms(ms: number): string {
  const d = new Date(ms);
  return `${hm(ms)}:${pad(d.getUTCSeconds())}`;
}

// Ruler labels at natural boundaries, at most five across the window: whole
// days when the window spans days (the copy's "Oct 20th"), clock times below.
const STEPS = [
  60e3,
  300e3,
  600e3,
  900e3,
  1800e3,
  3600e3,
  3 * 3600e3,
  6 * 3600e3,
  12 * 3600e3,
  86400e3,
];
export function rulerLabels(
  from: number,
  span: number,
): Array<{ t: number; text: string }> {
  const step =
    STEPS.find((s) => span / s <= 5) ?? 86400e3 * Math.ceil(span / 86400e3 / 5);
  const out: Array<{ t: number; text: string }> = [];
  for (let t = Math.ceil(from / step) * step; t <= from + span; t += step)
    out.push({ t, text: step >= 86400e3 ? dayText(t) : hm(t) });
  return out;
}

/** Events binned onto the tile pitch: cell index -> events in that cell. */
export function binLane(
  events: TimelineLane["events"],
  from: number,
  span: number,
  width: number,
): Map<number, Array<{ t: number; label: string }>> {
  const cells = new Map<number, Array<{ t: number; label: string }>>();
  for (const ev of events) {
    const x = ((ev.t - from) / span) * width;
    if (x < 0 || x > width) continue;
    const k = Math.min(Math.floor(x / TILE), Math.floor(width / TILE) - 1);
    const list = cells.get(k) ?? [];
    list.push(ev);
    cells.set(k, list);
  }
  return cells;
}

export function TimelinePanel({
  lanes,
  from,
  span,
  clockMs,
  playing,
  onPlay,
  seek,
  onFit,
  controls,
  onControls,
  onReplayDay,
  onClose,
}: {
  lanes: ReadonlyArray<TimelineLane>;
  from: number;
  span: number;
  clockMs: number;
  playing: boolean;
  onPlay: () => void;
  seek: (ms: number) => void;
  /** Widen the window to the longest one the dock offers. */
  onFit: () => void;
  /** Whether the transport and replay rows under the panel are showing. */
  controls: boolean;
  onControls: () => void;
  onReplayDay: () => void;
  onClose: () => void;
}): JSX.Element {
  const [legend, setLegend] = useState(true);
  const track = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(967);
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 967));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = lanes.map((lane, i) => ({
    lane,
    tone: i % 2 === 0 ? "var(--c-tlp-l0)" : "var(--c-tlp-l1)",
    cells: binLane(lane.events, from, span, w),
    count: lane.events.filter((e) => e.t >= from && e.t <= from + span).length,
  }));
  const times = lanes
    .flatMap((l) => l.events.map((e) => e.t))
    .filter((t) => t >= from && t <= from + span)
    .sort((a, b) => a - b);
  const prev = [...times].reverse().find((t) => t < clockMs - 1000);
  const next = times.find((t) => t > clockMs + 1000);
  const cur = ((clockMs - from) / span) * w;
  // The copy's vertical grid: title bar 0-38, ruler 40-68, lane rows from 78
  // on a 43px pitch, the range bar 27px under the last row.
  const n = Math.max(2, rows.length);
  const footTop = 78 + n * 43 + 27;

  return (
    <div
      className="tlp"
      style={{ height: footTop + 24 }}
      aria-label="Timeline"
      role="region"
    >
      <div className="tlp-hd">
        <span className="tlp-title">Timeline</span>
        <span className="tlp-transport">
          <button
            type="button"
            className="tlp-btn"
            disabled={prev === undefined}
            title="Previous event"
            aria-label="Previous event"
            onClick={() => prev !== undefined && seek(prev)}
          >
            <BpIcon name="fast-backward" size={15} />
          </button>
          <button
            type="button"
            className="tlp-btn"
            disabled={next === undefined}
            title="Next event"
            aria-label="Next event"
            onClick={() => next !== undefined && seek(next)}
          >
            <BpIcon name="fast-forward" size={15} />
          </button>
          <button
            type="button"
            className="tlp-btn tlp-play"
            aria-label={playing ? "Pause the timeline" : "Play the timeline"}
            title="Play or pause the timeline (space)"
            onClick={onPlay}
          >
            <BpIcon name={playing ? "pause" : "play"} size={12} />
            {playing ? "Pause" : "Play"}
          </button>
        </span>
        <span className="tlp-tools">
          <button
            type="button"
            className="tlp-ico"
            title="Fit the window to the archive (7 days)"
            aria-label="Fit the window to the archive"
            onClick={onFit}
          >
            <BpIcon name="zoom-to-fit" size={21} />
          </button>
          <button
            type="button"
            className="tlp-ico"
            aria-pressed={controls}
            title="Playback speed, window and live"
            aria-label="Show the playback controls"
            onClick={onControls}
          >
            <BpIcon name="widget" size={21} />
          </button>
          <button
            type="button"
            className="tlp-ico"
            title="Replay from a UTC day"
            aria-label="Replay from a UTC day"
            onClick={onReplayDay}
          >
            <BpIcon name="layout-grid" size={21} />
          </button>
          <button
            type="button"
            className="tlp-ico"
            title="Playback speed and window"
            aria-label="Playback speed and window"
            onClick={() => !controls && onControls()}
          >
            <BpIcon name="settings" size={21} />
          </button>
          <button
            type="button"
            className="tlp-ico"
            aria-pressed={legend}
            title="Lane legend"
            aria-label="Show the lane legend"
            onClick={() => setLegend((v) => !v)}
          >
            <BpIcon name="menu-open" size={21} />
          </button>
          <button
            type="button"
            className="tlp-ico tlp-x"
            title="Close the timeline"
            aria-label="Close the timeline"
            onClick={onClose}
          >
            <BpIcon name="cross" size={18} />
          </button>
        </span>
      </div>

      <div
        className="tlp-body"
        style={{ right: legend ? LEGEND_W + 6 : 6, height: footTop - 41 }}
        ref={track}
      >
        <div className="tlp-ruler" aria-hidden>
          {rulerLabels(from, span).map((l) => (
            <span
              key={l.t}
              className="tlp-day"
              style={{ left: ((l.t - from) / span) * w }}
            >
              {l.text}
            </span>
          ))}
        </div>
        {rows.map((r, i) => (
          <div
            key={r.lane.id}
            className="tlp-lane"
            style={{ top: 38 + i * 43 }}
          >
            {[...r.cells.entries()].map(([k, evs]) => (
              <button
                key={k}
                type="button"
                className="tlp-tile"
                style={{ left: k * TILE + 5, background: r.tone }}
                title={`${r.lane.label} · ${evs.length} event${evs.length === 1 ? "" : "s"} · ${evs[0]!.label}`}
                aria-label={`${r.lane.label}, ${evs.length} event${evs.length === 1 ? "" : "s"} from ${hm(evs[0]!.t)} Z`}
                onClick={() => seek(evs[0]!.t)}
              />
            ))}
          </div>
        ))}
        {cur >= 0 && cur <= w && (
          <span className="tlp-head" style={{ left: cur }} aria-hidden>
            <svg className="tlp-pin" viewBox="0 0 17 19">
              <path d="M1 1 H16 V12 L8.5 18 L1 12 Z" />
            </svg>
            <span className={`tlp-tag${cur < 72 ? " r" : ""}`}>
              {hms(clockMs)}
            </span>
          </span>
        )}
      </div>

      {legend && (
        <div className="tlp-legend" style={{ height: footTop - 74 }}>
          {rows.map((r) => (
            <div key={r.lane.id} className="tlp-key">
              <i style={{ background: r.tone }} />
              <span>{r.lane.label}</span>
              <b>{r.count}</b>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="tlp-key">
              <span>No event lanes reported</span>
            </div>
          )}
        </div>
      )}

      <div
        className="tlp-range"
        style={{ top: footTop, right: legend ? LEGEND_W + 6 : 6 }}
      >
        <span>{span >= 2 * 86400e3 ? dayText(from) : hm(from)}</span>
        <span className="tlp-grip" aria-hidden>
          ⋮⋮
        </span>
        <span>
          {span >= 2 * 86400e3 ? dayText(from + span) : hm(from + span)}
        </span>
      </div>
      {legend && <div className="tlp-range-l" style={{ top: footTop }} />}
    </div>
  );
}
