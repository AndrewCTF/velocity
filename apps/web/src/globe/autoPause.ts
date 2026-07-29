// Auto-pause during replay: stop the clock AT the moments that matter.
//
// Palantir's Time Selection panel exposes "Auto pause at" as an array of
// timestamps the playback halts on (docs/palantir-reference-2026-07.md §11.2),
// and it is the difference between a scrub and a briefing. Scrubbing makes you
// find the interesting moment yourself; auto-pause takes you to it and stops.
//
// We already generate the timestamps: incidents and alerts both carry a time.
// The only missing piece was a rule for "the clock just crossed one".
//
// The rule has to survive a fast clock. At 3600x, one animation frame advances
// the replay clock by a minute of real time, so an equality test would never
// fire and a naive "is now within N seconds of a mark" test would fire on every
// frame across a wide window. Crossing detection is the honest primitive:
// did the interval between the previous tick and this one contain a mark.

export interface PauseMark {
  /** Epoch seconds. */
  t: number;
  label: string;
}

/**
 * The first mark strictly inside the half-open interval the clock just covered,
 * or null.
 *
 * Half-open `(prev, now]` so a mark fires exactly once: the tick that lands on
 * or passes it fires, and the next tick starts after it. Direction-aware, so
 * scrubbing backwards over a mark also stops - an operator running the replay
 * in reverse is looking for the same moments.
 */
export function markCrossed(
  prev: number,
  now: number,
  marks: readonly PauseMark[],
): PauseMark | null {
  if (!Number.isFinite(prev) || !Number.isFinite(now) || prev === now) return null;
  const lo = Math.min(prev, now);
  const hi = Math.max(prev, now);
  // Nearest to the direction of travel, so a jump spanning several marks stops
  // at the FIRST one it reached rather than the last. Skipping past two events
  // to land on a third is how a briefing loses its middle.
  const inside = marks.filter((m) => m.t > lo && m.t <= hi);
  if (inside.length === 0) return null;
  inside.sort((a, b) => (now > prev ? a.t - b.t : b.t - a.t));
  return inside[0] ?? null;
}

/**
 * Collapse marks that are closer together than `minGapSec`.
 *
 * A burst of correlated alerts is one moment, not nine. Without this the replay
 * stops nine times in eight seconds and the operator turns the feature off,
 * which is worse than never having had it.
 */
export function dedupeMarks(marks: readonly PauseMark[], minGapSec = 30): PauseMark[] {
  const sorted = [...marks].filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
  const out: PauseMark[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.t - last.t < minGapSec) continue;
    out.push(m);
  }
  return out;
}
