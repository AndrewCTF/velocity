import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// Coverage/density heat-strip — fed by GET /api/history/coverage (the archive
// store's real recorded-fix density), distinct from the Row-3 density strip
// in Timeline.tsx which reads /api/timeline/detections/alerts, a different
// signal (see docs/replay-flagship-plan.md §3). This is the "can I see which
// hours/days actually have data before I pick a day to replay" strip.

// Mirrors Timeline.tsx's density-poll cadence (POLL_MS, lines 200-221) — same
// wall-clock rhythm as the rest of the replay bar.
const POLL_MS = 5_000;

// Route bounds (routes/history.py get_coverage): window_hours in [1, 8760],
// bucket_hours in [1, 24]. Clamp defensively so an archive-mode operator with
// an uncapped retention window (§1.2) never sends an out-of-range query.
const MAX_WINDOW_HOURS = 8_760;
const MAX_BUCKET_HOURS = 24;
// Target roughly this many bars regardless of window size — matches the
// density strip's 240-bin resolution (Timeline.tsx `bins`) closely enough
// that both strips read as the same visual language.
const TARGET_BARS = 200;

export interface CoverageBucket {
  t: number; // epoch seconds, bucket start
  count: number;
}

export interface Coverage {
  recording_since: number | null; // epoch seconds, MIN(t) over positions
  // Same value as recording_since (global MIN(t)) under an unambiguous name:
  // "recording_since" reads like a fixed deployment date, but it marches
  // forward whenever the byte cap or hour-window prune drops the oldest
  // rows. Optional so an older cached backend response still type-checks.
  oldest_ts?: number | null;
  total_bytes: number;
  row_count: number;
  buckets: CoverageBucket[];
  degraded?: boolean;
  error?: string;
}

interface Props {
  // Look-back window for the heat-strip, hours — the day-picker's retention
  // bound (retentionHours), so the strip never asks for already-pruned data.
  windowHours: number;
  // CoverageStrip owns the one /api/history/coverage fetch; this lets
  // Timeline.tsx lift the three scalar totals up for the ownership chip
  // without a second request for the same data.
  onCoverage?: (c: Coverage | null) => void;
}

function autoBucketHours(windowHours: number): number {
  const raw = Math.ceil(windowHours / TARGET_BARS);
  return Math.min(MAX_BUCKET_HOURS, Math.max(1, raw));
}

export function CoverageStrip({ windowHours, onCoverage }: Props): JSX.Element {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  // Keep the callback current without re-running the poll effect on every
  // parent render (Timeline.tsx passes a fresh setState-wrapping closure).
  const onCoverageRef = useRef(onCoverage);
  onCoverageRef.current = onCoverage;

  useEffect(() => {
    let aborter: AbortController | null = null;
    const clampedWindow = Math.min(MAX_WINDOW_HOURS, Math.max(1, Math.round(windowHours)));
    const bucketHours = autoBucketHours(clampedWindow);
    // A coverage query over a large archive can take far longer than POLL_MS
    // (measured: 73 s over 78 M fixes for a 168 h window). Aborting the
    // in-flight request on every tick meant it could never finish, so the chip
    // sat on its fallback text forever. Let a slow query run; skip the tick.
    const tick = async () => {
      if (aborter) return;
      aborter = new AbortController();
      try {
        const r = await apiFetch(
          `/api/history/coverage?window_hours=${clampedWindow}&bucket_hours=${bucketHours}`,
          { signal: aborter.signal },
        );
        if (r.ok) {
          const c = (await r.json()) as Coverage;
          setCoverage(c);
          onCoverageRef.current?.(c);
        }
      } catch {
        /* keep last coverage — degrade to the fallback text/empty strip */
      } finally {
        aborter = null;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      window.clearInterval(id);
      aborter?.abort();
    };
  }, [windowHours]);

  const buckets = coverage?.buckets ?? [];
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const gaps = countGaps(buckets);

  return (
    <div
      className="relative h-[8px] w-full bg-bg-3 border border-line rounded-sm overflow-hidden"
      role="img"
      aria-label={coverageSummary(buckets)}
      title={coverageSummary(buckets)}
    >
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(buckets.length, 1)} 100`}>
        {buckets.map((b, i) => {
          const h = (b.count / maxCount) * 100;
          if (h <= 0) {
            // An hour we recorded NOTHING is drawn, not skipped. Skipping it
            // left a hole indistinguishable from the strip's own background, so
            // "we were down" and "there is simply no bar here" looked identical
            // — which is the archive telling a confident story about a period it
            // never saw. A visible mark is the whole point of a coverage strip.
            return <rect key={b.t} x={i} y={0} width={1} height={100} fill="var(--alert)" opacity={0.22} />;
          }
          return <rect key={b.t} x={i} y={100 - h} width={1} height={h} fill="var(--accent)" opacity={0.7} />;
        })}
      </svg>
      {gaps > 0 && <span className="sr-only">{gaps} hours with no recorded fixes</span>}
    </div>
  );
}

/** Hours in the window for which nothing was recorded. */
export function countGaps(buckets: readonly CoverageBucket[]): number {
  return buckets.filter((b) => b.count <= 0).length;
}

/** What the strip actually shows, in words.
 *
 *  Stated rather than implied: a coverage strip whose gaps you have to infer
 *  from missing ink is a strip that lets an operator read "quiet" where the
 *  truth is "not recorded". */
export function coverageSummary(buckets: readonly CoverageBucket[]): string {
  if (buckets.length === 0) return 'History coverage: nothing recorded yet.';
  const gaps = countGaps(buckets);
  if (gaps === 0) {
    return `History coverage: continuous across all ${buckets.length} hours shown.`;
  }
  return (
    `History coverage: ${buckets.length - gaps} of ${buckets.length} hours have ` +
    `recorded fixes. ${gaps} shown in red were not recorded, so they are unknown ` +
    `rather than quiet.`
  );
}
