import { useEffect, useState } from 'react';
import { Widget, Caveat } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

// The one sanctioned use of a claim-tier source, in the dossier.
//
// docs/plan-99-2026-08.md §0: a claim never sources a fact, never colours the
// map, and is off by default. Its one legitimate use is corroboration — given
// something an instrument observed, did anybody say anything near it, and how
// long after.
//
// The card is worded to make the thing it CANNOT say impossible to misread.
// Proximity is not aboutness: a shelling report 12 km from a tanker at anchor
// may have nothing to do with the tanker. So the heading counts "reports
// nearby", never "reports about this", and the lag is the number an analyst can
// actually reason with — a claim 40 minutes after a transponder anomaly and one
// three days before it are different kinds of evidence.

interface Report {
  distance_km: number;
  lag_s: number | null;
  actor1: string | null;
  actor2: string | null;
  event: string | null;
  mentions: number | null;
  day: string | null;
}
interface Corroboration {
  nearby: Report[];
  count: number;
  considered: number;
  earliest_lag_s: number | null;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'done'; data: Corroboration };

function lagLabel(s: number | null): string {
  if (s === null) return '—';
  const abs = Math.abs(s);
  const unit = abs < 5400 ? `${Math.round(abs / 60)} min` : `${Math.round(abs / 3600)} h`;
  return s >= 0 ? `+${unit}` : `-${unit}`;
}

export function CorroborationCard({
  lon,
  lat,
  at,
}: {
  lon: number | null | undefined;
  lat: number | null | undefined;
  at?: number | null;
}): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || lon === null || lon === undefined || lat === null || lat === undefined) return;
    setState({ status: 'loading' });
    const ab = new AbortController();
    const q = new URLSearchParams({ lon: String(lon), lat: String(lat), radius_km: '50' });
    if (at) q.set('at', String(at));
    apiFetch(`/api/intel/corroborate?${q}`, { signal: ab.signal })
      .then(async (r) => {
        if (ab.signal.aborted) return;
        if (!r.ok) {
          setState({ status: 'error', code: r.status });
          return;
        }
        setState({ status: 'done', data: (await r.json()) as Corroboration });
      })
      .catch(() => {
        if (!ab.signal.aborted) setState({ status: 'error', code: 0 });
      });
    return () => ab.abort();
  }, [open, lon, lat, at]);

  if (lon === null || lon === undefined || lat === null || lat === undefined) return null;

  if (!open) {
    return (
      <Widget title="Corroboration">
        <div className="flex items-center gap-2 px-[14px] py-[6px]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">
            Claim-tier reports within 50 km
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mono h-[20px] shrink-0 rounded-sm px-[7px] text-[12px] text-txt-2 hover:bg-[var(--hover)]"
          >
            check
          </button>
        </div>
        <Caveat note="Claims never source a fact here. This only measures whether one exists near this observation, and how long after." />
      </Widget>
    );
  }

  if (!state || state.status === 'loading') {
    return (
      <Widget title="Corroboration">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-3">checking…</div>
      </Widget>
    );
  }
  if (state.status === 'error') {
    return (
      <Widget title="Corroboration">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-2">
          {state.code === 502
            ? 'Claim-tier source unavailable, so this is not a "nobody said anything".'
            : `Corroboration unavailable${state.code ? ` (HTTP ${state.code})` : ''}`}
        </div>
      </Widget>
    );
  }

  const d = state.data;
  return (
    <Widget title="Corroboration">
      <div className="flex items-baseline gap-2 px-[14px] py-[6px]">
        <span className="mono text-[18px] tabular-nums text-txt-0">{d.count}</span>
        <span className="text-[12px] text-txt-3">
          {d.count === 1 ? 'report nearby' : 'reports nearby'}, of {d.considered} in the window
        </span>
      </div>
      {d.count === 0 ? (
        <p className="px-[14px] pb-[6px] text-[12px] leading-relaxed text-txt-3">
          Nothing claim-tier was published within 50 km of this position in the window. That is a
          result, not a verdict on the observation.
        </p>
      ) : (
        d.nearby.slice(0, 5).map((r, i) => (
          <div
            key={`${r.day ?? i}-${r.distance_km}-${i}`}
            className="flex min-h-[20px] items-baseline gap-2 px-[14px] py-[1px] text-[12px]"
          >
            <span className="mono w-[52px] shrink-0 tabular-nums text-txt-3">
              {r.distance_km} km
            </span>
            <span className="min-w-0 flex-1 truncate text-txt-1">
              {[r.actor1, r.actor2].filter(Boolean).join(' → ') || '—'} · {r.event ?? '—'}
            </span>
            <span className="mono shrink-0 tabular-nums text-txt-2">{lagLabel(r.lag_s)}</span>
          </div>
        ))
      )}
      <Caveat
        tone="warn"
        note="Proximity is not aboutness. These reports are near this position in space and time; none of them is asserted to be about this contact, and none may be used to source a fact. The feed dates events to the day, so a lag is accurate to about a day."
      />
    </Widget>
  );
}
