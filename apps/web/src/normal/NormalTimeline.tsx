// Normal-dashboard timeline footer — the clean multi-lane playback strip from
// the Palantir-Gotham mockup (/tmp/gotham/dashboard.html footer.timeline).
//
// REAL wiring: the transport (play/pause), the Zulu clock readout, and the speed
// segment are bound to the shared `useTime` playback store — pressing play/pause
// toggles the same clock that drives globe interpolation, and the speed buttons
// set the playback multiplier. The four LANE rows + their event blocks below are
// ILLUSTRATIVE of the 24h playback window (static positions): they sketch where
// aircraft / vessel / alert / satellite-pass activity falls across the window so
// the footer reads like the mockup. They are not yet bound to per-feed history.
//
// Styling composes only the `.nrm`-scoped classes from normal/normal.css plus the
// shared <Icon/>. Inline styles are layout-only (percentage left/width for the
// event blocks and the live-edge cursor, mirroring the mockup) — no hardcoded
// colors; event tone comes from the `.ev.amber/.red/.green` class variants.
import type * as Cesium from 'cesium';
import { Icon, type IconName } from './Icon.js';
import { useTime } from '../state/stores.js';

export interface NormalTimelineProps {
  viewer?: Cesium.Viewer | null;
}

/** Pad a number to two digits for the Zulu clock. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format an epoch (ms) as UTC `HH:MM:SSZ` — the playback cursor time. */
function fmtZulu(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

/** Playback speed presets (× real-time). All within the store's [1,3600] range. */
const SPEEDS: readonly number[] = [1, 4, 16, 64];

/** A single illustrative event block on a lane track (percentage-positioned). */
interface LaneEvent {
  left: number; // 0..100 (% from left of the track)
  width: number; // 0..100 (% of track width)
  tone?: 'amber' | 'red' | 'green';
}

/** An illustrative playback lane (label + icon + a few event blocks). */
interface Lane {
  key: string;
  label: string;
  icon: IconName;
  /** Legend swatch token for the lane icon (category colour). */
  color: string;
  events: readonly LaneEvent[];
}

// ILLUSTRATIVE lane layout — sketches the 24h playback window (see file header).
const LANES: readonly Lane[] = [
  {
    key: 'aircraft',
    label: 'Aircraft',
    icon: 'plane',
    color: 'var(--air-airliner)',
    events: [{ left: 4, width: 90 }],
  },
  {
    key: 'vessels',
    label: 'Vessels',
    icon: 'ship',
    color: 'var(--sea-cargo)',
    events: [{ left: 10, width: 78 }],
  },
  {
    key: 'alerts',
    label: 'Alerts',
    icon: 'bell',
    color: 'var(--warn)',
    events: [
      { left: 40, width: 6, tone: 'amber' },
      { left: 61, width: 4, tone: 'red' },
      { left: 80, width: 6, tone: 'amber' },
    ],
  },
  {
    key: 'sat',
    label: 'Sat passes',
    icon: 'satellite',
    color: 'var(--mag)',
    events: [
      { left: 20, width: 8, tone: 'green' },
      { left: 55, width: 8, tone: 'green' },
      { left: 88, width: 6, tone: 'green' },
    ],
  },
];

export function NormalTimeline(props: NormalTimelineProps): JSX.Element {
  const { viewer } = props;

  // REAL playback state — the same clock that drives globe interpolation.
  const playing = useTime((s) => s.playing);
  const togglePlay = useTime((s) => s.togglePlay);
  const multiplier = useTime((s) => s.multiplier);
  const setMultiplier = useTime((s) => s.setMultiplier);
  const currentTime = useTime((s) => s.currentTime);

  // Live-edge cursor position: where the playback clock falls in the trailing
  // 24h window (100% = now/live, moves left as the operator scrubs/steps back).
  // Real, not the old hardcoded 62%. Recompute `now` per render (the store ticks
  // currentTime, re-rendering this footer).
  const WINDOW_MS = 24 * 3600 * 1000;
  const windowStart = Date.now() - WINDOW_MS;
  const cursorPct = Math.max(0, Math.min(100, ((currentTime - windowStart) / WINDOW_MS) * 100));

  return (
    <footer className="timeline" aria-label="Timeline playback">
      <div className="tl-head">
        <div
          className="transport"
          role="group"
          aria-label="Playback transport"
          title={viewer ? 'Bound to the globe clock' : 'No globe attached'}
        >
          <button className="iconbtn" type="button" aria-label="Step back">
            <Icon name="step-b" />
          </button>
          <button
            className="iconbtn on"
            type="button"
            aria-label={playing ? 'Pause playback' : 'Play playback'}
            aria-pressed={playing}
            onClick={togglePlay}
          >
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button className="iconbtn" type="button" aria-label="Step forward">
            <Icon name="step-f" />
          </button>
        </div>

        <div className="tl-clock mono" aria-label="Playback time (Zulu)">
          {fmtZulu(currentTime)}
        </div>

        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((v) => {
            const active = v === multiplier;
            return (
              <button
                key={v}
                type="button"
                className={active ? 'on' : undefined}
                aria-pressed={active}
                onClick={() => setMultiplier(v)}
              >
                {v}×
              </button>
            );
          })}
        </div>

        <span className="spacer" />

        <span className="note">Window 24h · live playback</span>

        <button className="btn sm" type="button">
          <Icon name="bookmark" />
          Bookmark
        </button>
      </div>

      <div className="tl-body" style={{ position: 'relative' }}>
        {/* Live-edge cursor — REAL playback head: currentTime within the 24h window. */}
        <div className="tl-cursor" style={{ left: `${cursorPct}%` }} aria-hidden="true" />
        {LANES.map((lane) => (
          <div className="lane" key={lane.key}>
            <span className="lname">
              <span style={{ display: 'inline-flex', color: lane.color }}>
                <Icon name={lane.icon} />
              </span>
              {lane.label}
            </span>
            <div className="track">
              {lane.events.map((ev, i) => (
                <span
                  key={i}
                  className={ev.tone ? `ev ${ev.tone}` : 'ev'}
                  style={{ left: `${ev.left}%`, width: `${ev.width}%` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </footer>
  );
}
