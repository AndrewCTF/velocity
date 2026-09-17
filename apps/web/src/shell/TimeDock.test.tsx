import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import { TimeDock } from './TimeDock.js';
import { useTime } from '../state/stores.js';

// TimeDock.tsx itself imports Cesium as a TYPE only and builds/reads
// `viewer.clock.currentTime` for seek()/goLive() by hand as a plain
// {dayNumber, secondsOfDay} pair (jdToMs/msToJulian) rather than via
// `Cesium.JulianDate`. installHistoryPlayback() (HistoryPlayback.ts), which
// DOES import the real Cesium runtime, sets `startTime`/`stopTime` (and the
// chunk-boundary `currentTime`) via the real `Cesium.JulianDate.fromDate`
// instead. The two conversions agree on the millisecond an instant
// represents but disagree on the RAW dayNumber/secondsOfDay pair (Cesium's is
// TAI-based, the hand-rolled one is not) — so reads below use whichever
// conversion actually wrote the field being checked. Mixing them (e.g.
// diffing a hand-rolled write against `Cesium.JulianDate`'s reader) is off by
// the current leap-second count, not a real bug in either function.
interface RawJulian {
  dayNumber: number;
  secondsOfDay: number;
}
function rawJulian(ms: number): RawJulian {
  const seconds = ms / 1000;
  const dayNumber = 2440587 + Math.floor(seconds / 86400);
  const secondsOfDay = seconds - (dayNumber - 2440587) * 86400 + 0.5 * 86400;
  return { dayNumber, secondsOfDay };
}
function rawJulianToMs(jd: RawJulian): number {
  return (jd.dayNumber - 2440587) * 86400_000 + jd.secondsOfDay * 1000 - 0.5 * 86400_000;
}

// Functional, not presence: THE bug this dock exists to fix is that Play
// flipped a store flag nothing read and seek() wrote local state only, so the
// globe never moved (docs/decisions.md, Wave 0). Every test here reads the
// stub viewer's real clock/data-source state after an interaction, not just
// whether a button rendered.

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 404, statusText: ok ? 'OK' : 'Not Found', json: async () => body } as unknown as Response;
}

interface MockRoutesOpts {
  trackForTracks?: unknown[];
  // /api/history/coverage — own-archive density + the ownership-chip scalars
  // (CoverageStrip.tsx, restored here from timeline/Timeline.tsx).
  coverage?: unknown;
  coverageOk?: boolean;
  // The day HistoryPlayback.ts' own oldest-day resolution reads from
  // /api/history/stats `shards` — kept separate from `retention_hours` below
  // because the two are different concerns hitting the same route.
  shardsDay?: string;
}

const COVERAGE = {
  recording_since: 1_750_000_000, // 2025-06-15T13:46:40Z
  oldest_ts: 1_750_000_000, // same instant, unambiguous name (CoverageStrip.tsx)
  total_bytes: 2_500_000_000, // 2.3 GB
  row_count: 987_654,
  buckets: [{ t: 1_750_000_000, count: 5 }],
};

function mockRoutes(opts: MockRoutesOpts = {}): void {
  const { trackForTracks = [], coverage = {}, coverageOk = true, shardsDay = '2020-01-01' } = opts;
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.startsWith('/api/timeline/density')) {
      return jsonResponse({ from: Date.now() - 3_600_000, to: Date.now(), bins: 1, detections: [0], alerts: [0] });
    }
    if (u.startsWith('/api/timeline/events')) return jsonResponse({ lanes: [] });
    // Two different consumers read this same route: HistoryPlayback.ts's
    // oldest-day resolution (`shards`) and TimeDock's own retention effect
    // (`retention_hours`, for CoverageStrip's windowHours bound).
    if (u === '/api/history/stats') return jsonResponse({ shards: [{ day: shardsDay }], retention_hours: 168 });
    if (u.startsWith('/api/history/upstream/coverage')) return jsonResponse({}, false); // fall back to 2024-01-01
    if (u.startsWith('/api/history/coverage')) return jsonResponse(coverage, coverageOk);
    if (u.startsWith('/api/history/tracks')) return jsonResponse({ tracks: trackForTracks });
    return jsonResponse({}, false);
  });
}

// Minimal viewer stub exposing exactly the surface both TimeDock.tsx and the
// REAL HistoryPlayback.ts (installHistoryPlayback runs unmocked here) touch.
function fakeViewer(): { viewer: Cesium.Viewer; getDs: () => Cesium.CustomDataSource | undefined } {
  const sources: Cesium.DataSource[] = [];
  const dataSources = {
    add: (ds: Cesium.DataSource) => {
      sources.push(ds);
      return ds;
    },
    remove: () => true,
    get: (i: number) => sources[i],
    getByName: (name: string) => sources.filter((s) => s.name === name),
    get length() {
      return sources.length;
    },
  };
  const listeners: Array<() => void> = [];
  const clock = {
    onTick: {
      addEventListener: (fn: () => void) => {
        listeners.push(fn);
        return () => {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },
    currentTime: rawJulian(Date.now()),
    startTime: rawJulian(Date.now()),
    stopTime: rawJulian(Date.now()),
    clockRange: 'UNBOUNDED',
    shouldAnimate: false,
    multiplier: 1,
  };
  const viewer = {
    dataSources,
    camera: { computeViewRectangle: () => undefined },
    clock,
    scene: { requestRender: () => {}, maximumRenderTimeChange: 0 },
    isDestroyed: () => false,
  } as unknown as Cesium.Viewer;
  return {
    viewer,
    getDs: () => sources.find((s) => s.name === 'history-replay') as Cesium.CustomDataSource | undefined,
  };
}

beforeEach(() => {
  useTime.setState({ playing: false, multiplier: 1 });
  mockRoutes();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimeDock — the real transport', () => {
  it('installs HistoryPlayback and creates the history-replay data source on mount', () => {
    const { viewer, getDs } = fakeViewer();
    render(<TimeDock viewer={viewer} />);
    expect(getDs(), 'installHistoryPlayback must add a history-replay CustomDataSource').toBeDefined();
  });

  it('Play drives the real clock.shouldAnimate, not just the store', async () => {
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    // Store starts paused (beforeEach); the mount effect must mirror that.
    await waitFor(() => expect(viewer.clock.shouldAnimate).toBe(false));

    fireEvent.click(screen.getByTitle('Play or pause (space)'));
    await waitFor(() => expect(viewer.clock.shouldAnimate).toBe(true));
  });

  it('seek moves the real clock.currentTime, not just local state', async () => {
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    const beforeMs = rawJulianToMs(viewer.clock.currentTime as unknown as RawJulian);
    fireEvent.click(screen.getByLabelText('Back 15 seconds'));

    await waitFor(() => {
      const afterMs = rawJulianToMs(viewer.clock.currentTime as unknown as RawJulian);
      expect(beforeMs - afterMs).toBeCloseTo(15_000, -2); // within ~50ms of a real 15s seek
    });
  });

  it('picking a replay day calls loadAt: the clock jumps to that UTC day and the fetched track renders', async () => {
    mockRoutes({ trackForTracks: [{ id: 'aircraft:ABC123', kind: 'aircraft', points: [[10.0, 20.0, 1_700_003_600, 90]] }] });
    const { viewer, getDs } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    fireEvent.change(screen.getByLabelText('Replay start day'), { target: { value: '2024-06-01' } });

    await waitFor(() => {
      const ds = getDs();
      expect(ds?.entities.values.length ?? 0).toBeGreaterThan(0);
    });

    // startTime is written by installHistoryPlayback() (HistoryPlayback.ts),
    // via the real Cesium.JulianDate.fromDate — read it back the same way.
    const startMs = Cesium.JulianDate.toDate(viewer.clock.startTime).getTime();
    expect(startMs).toBe(Date.parse('2024-06-01T00:00:00Z'));
  });

  it('every printed shortcut has a listener: Live (L) actually clears the replay', async () => {
    mockRoutes({ trackForTracks: [{ id: 'aircraft:ABC123', kind: 'aircraft', points: [[10.0, 20.0, 1_700_003_600, 90]] }] });
    const { viewer, getDs } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    fireEvent.change(screen.getByLabelText('Replay start day'), { target: { value: '2024-06-01' } });
    await waitFor(() => expect(getDs()?.entities.values.length ?? 0).toBeGreaterThan(0));

    fireEvent.click(screen.getByTitle('Return to live (L)'));
    await waitFor(() => expect(getDs()?.entities.values.length ?? 0).toBe(0));
  });
});

// Ported from the old timeline/Timeline.test.tsx (deleted when Timeline
// became a thin TimeDock wrapper — see Timeline.tsx's header comment) at the
// coordinator's instruction to restore, not drop, this operator-decided
// chrome (docs/replay-flagship-plan.md §3, decisions 2026-07-11).
// Adaptations from the original six cases:
//  - the day picker's accessible name is "Replay start day" here, not the
//    old "Replay a specific day" (TimeDock's own naming, unrelated to this
//    restoration);
//  - the day-picker tooltip and the depth warning are REWORDED, not merely
//    relabeled: Wave 0 means a day before the own archive's real depth is no
//    longer an EMPTY replay (aircraft still come from the upstream tar1090
//    archive) — only vessels (no upstream fallback) actually go missing, so
//    the copy says that instead of implying nothing plays at all. All three
//    structural behaviours the old cases pinned (an informative title once
//    coverage loads, a visible warning below the real depth, no warning at
//    or above it) are still exercised, unchanged.
//  - no case was dropped as no-longer-applicable.
describe('TimeDock — restored archive-ownership chrome (CoverageStrip + chip + depth warning)', () => {
  it('shows the own-archive buffer fallback before coverage loads', async () => {
    mockRoutes({ coverageOk: false });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);
    await waitFor(() => expect(screen.getByText(/buffer/)).toBeInTheDocument());
  });

  it('replaces the buffer fallback with the recording-since/GB/fixes chip once coverage arrives', async () => {
    mockRoutes({ coverage: COVERAGE });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    await waitFor(() => {
      expect(screen.getByText(/recording since 2025-06-15/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2\.3 GB/)).toBeInTheDocument();
    expect(screen.getByText(/987,654 fixes/)).toBeInTheDocument();
    expect(screen.queryByText(/buffer$/)).not.toBeInTheDocument();
  });

  it('renders the own-archive coverage heat-strip alongside the day/time pickers', async () => {
    mockRoutes({ coverage: COVERAGE });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    expect(await screen.findByRole('img', { name: /history coverage/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Replay start day')).toBeInTheDocument();
  });

  it('renders the second row: upstream (tar1090) availability by day', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.startsWith('/api/timeline/density')) return jsonResponse({ from: 0, to: 1, bins: 1, detections: [0], alerts: [0] });
      if (u.startsWith('/api/timeline/events')) return jsonResponse({ lanes: [] });
      if (u === '/api/history/stats') return jsonResponse({ shards: [{ day: '2020-01-01' }], retention_hours: 168 });
      if (u.startsWith('/api/history/upstream/coverage')) {
        return jsonResponse({
          days: [
            { day: '2024-06-01', hosts: ['globe.adsb.fi'] },
            { day: '2024-06-02', hosts: [] },
          ],
        });
      }
      if (u.startsWith('/api/history/coverage')) return jsonResponse(COVERAGE);
      return jsonResponse({});
    });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    const row = await screen.findByRole('img', { name: /upstream archive availability: 1 of 2 days reachable/i });
    expect(row.querySelectorAll('rect')).toHaveLength(2);
  });

  it('tells the operator the own archive real depth once coverage loads, via the day-picker tooltip', async () => {
    mockRoutes({ coverage: COVERAGE });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Replay start day')).toHaveAttribute(
        'title',
        expect.stringContaining('available from 2025-06-15'),
      );
    });
  });

  it('warns visibly when a picked day precedes the own archive real depth (aircraft still replay from upstream)', async () => {
    mockRoutes({ coverage: COVERAGE });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Replay start day')).toHaveAttribute(
        'title',
        expect.stringContaining('available from'),
      );
    });

    // Inside the fallback 2024-01-01..today range, but before oldest_ts
    // (2025-06-15) — own archive has nothing there; upstream still does.
    fireEvent.change(screen.getByLabelText('Replay start day'), { target: { value: '2025-06-01' } });

    expect(await screen.findByText(/vessels unavailable before 2025-06-15/)).toBeInTheDocument();
  });

  it('shows no depth warning once a picked day is on/after the real depth', async () => {
    mockRoutes({ coverage: COVERAGE });
    const { viewer } = fakeViewer();
    render(<TimeDock viewer={viewer} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Replay start day')).toHaveAttribute(
        'title',
        expect.stringContaining('available from'),
      );
    });

    fireEvent.change(screen.getByLabelText('Replay start day'), { target: { value: '2025-06-16' } });

    expect(screen.queryByText(/vessels unavailable before 2025-06-15/)).not.toBeInTheDocument();
  });
});
