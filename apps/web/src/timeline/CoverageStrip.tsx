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
    const tick = async () => {
      aborter?.abort();
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

  return (
    <div
      className="relative h-[8px] w-full bg-bg-3 border border-line rounded-sm overflow-hidden"
      role="img"
      aria-label="History coverage: recorded-fix density per hour"
      title="Recorded-fix coverage — taller/brighter bars mean more history is retained for that hour"
    >
      <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(buckets.length, 1)} 100`}>
        {buckets.map((b, i) => {
          const h = (b.count / maxCount) * 100;
          if (h <= 0) return null;
          return <rect key={b.t} x={i} y={100 - h} width={1} height={h} fill="var(--accent)" opacity={0.7} />;
        })}
      </svg>
    </div>
  );
}
