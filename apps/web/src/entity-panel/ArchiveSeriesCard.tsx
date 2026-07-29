// Behaviour from the OWNED archive, not from what this tab happened to see.
//
// The Track card above plots the in-memory ring buffer, which starts empty
// every time the page loads: open the console and click an aircraft and you get
// "insufficient samples" regardless of how long the archive has been running.
// This card asks the archive instead, so the altitude trace is however much
// history you have kept, and it survives a reload.
//
// That distinction is the entire argument for owning history rather than
// renting a live feed (docs/research-last30days-2026-07-29.md §1.1: every
// competitor surveyed is stateless and structurally cannot draw this).
import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { SectionLabel } from '../shell/instruments.js';

interface SeriesPoint {
  t: number;
  alt_m: number | null;
  sog: number | null;
}

const WINDOW_SEC = 3600;

/** Minimal SVG trace over a nullable series. Gaps in the data are gaps in the
 *  line, never interpolated: a straight segment across a coverage hole is a
 *  claim we did not observe. */
export function Trace({
  values,
  width = 260,
  height = 34,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
}): JSX.Element | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const segs: string[] = [];
  let penDown = false;
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      penDown = false; // break the line rather than bridging the gap
      return;
    }
    const x = i * step;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    segs.push(`${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
    penDown = true;
  });
  return (
    <svg width={width} height={height} className="block">
      <path d={segs.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.2" />
    </svg>
  );
}

export function ArchiveSeriesCard({ id, kind }: { id: string | null; kind: string }): JSX.Element | null {
  const [series, setSeries] = useState<SeriesPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const r = await apiFetch(
          `/api/history/track?id=${encodeURIComponent(id)}&from_ts=${now - WINDOW_SEC}&series=true`,
        );
        if (!r.ok) {
          if (!cancelled) {
            setError(`HTTP ${r.status}`);
            setSeries(null);
          }
          return;
        }
        const body = (await r.json()) as { series?: SeriesPoint[] };
        if (!cancelled) {
          setSeries(body.series ?? []);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError('unreachable');
          setSeries(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id || (kind !== 'aircraft' && kind !== 'vessel')) return null;

  const alt = (series ?? []).map((s) => s.alt_m);
  const sog = (series ?? []).map((s) => s.sog);
  const haveAlt = alt.filter((v) => typeof v === 'number').length >= 2;
  const haveSog = sog.filter((v) => typeof v === 'number').length >= 2;

  return (
    <section>
      <SectionLabel
        title="Archive"
        count={series == null ? '' : `${series.length} fixes · 1h`}
      />
      <div className="mt-1.5 space-y-1.5">
        {error && <div className="mono text-[10px] text-alert-fg">Archive unavailable ({error}).</div>}
        {!error && series == null && <div className="mono text-[10px] text-txt-4">Loading…</div>}
        {!error && series != null && series.length === 0 && (
          // An empty archive is a real, useful answer and it says which it is:
          // nothing recorded, not nothing happened.
          <div className="mono text-[10px] text-txt-4">
            Nothing recorded for this contact in the last hour.
          </div>
        )}
        {haveAlt && (
          <div>
            <span className="micro">altitude · archived</span>
            <Trace values={alt} />
          </div>
        )}
        {haveSog && (
          <div>
            <span className="micro">speed · archived</span>
            <Trace values={sog} />
          </div>
        )}
        {!error && series != null && series.length > 0 && !haveAlt && !haveSog && (
          <div className="mono text-[10px] text-txt-4">
            {series.length} positions recorded, no altitude or speed among them.
          </div>
        )}
      </div>
    </section>
  );
}
