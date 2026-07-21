// Stress card — headline 0-100 score plus a per-component horizontal bar list
// from /api/markets/stress. Kept deliberately simple per the dataviz skill: a
// component bar list using the app's own tokens, no chart library. Weight +
// raw inputs surface as a title tooltip on hover rather than extra chrome.
import { Widget, ErrorLine } from './primitives.js';
import type { FetchState, StressComponent, StressResponse } from './types.js';

// Score → tone, tracking the same ok/warn/alert bands used elsewhere for a
// 0-100 risk figure (higher = more stressed).
function scoreTone(score: number): 'ok' | 'warn' | 'alert' {
  if (score >= 66) return 'alert';
  if (score >= 33) return 'warn';
  return 'ok';
}

function toneClass(tone: 'ok' | 'warn' | 'alert'): { text: string; bar: string } {
  switch (tone) {
    case 'alert':
      return { text: 'text-alert-fg', bar: 'bg-alert' };
    case 'warn':
      return { text: 'text-warn-fg', bar: 'bg-warn' };
    default:
      return { text: 'text-ok', bar: 'bg-ok' };
  }
}

function componentTitle(c: StressComponent): string {
  const parts = [`weight ${(c.weight * 100).toFixed(0)}%`];
  if (c.value != null) parts.push(`value ${c.value}`);
  if (c.inputs && Object.keys(c.inputs).length > 0) {
    parts.push(
      Object.entries(c.inputs)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' · '),
    );
  }
  return parts.join(' · ');
}

function ComponentBar({ c }: { c: StressComponent }): JSX.Element {
  const pct = Math.max(0, Math.min(100, c.normalized * 100));
  const tone = toneClass(scoreTone(pct));
  return (
    <div className="flex items-center gap-2 min-w-0" title={componentTitle(c)}>
      <span className="text-[11px] text-txt-3 w-32 shrink-0 truncate">{c.key}</span>
      <span className="relative flex-1 h-[6px] bg-bg-3 rounded-sm overflow-hidden">
        <span className={`absolute left-0 top-0 bottom-0 rounded-sm ${tone.bar}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="mono text-[10px] text-txt-4 w-10 text-right shrink-0 tabular-nums">{pct.toFixed(0)}</span>
    </div>
  );
}

export function StressCard({ state }: { state: FetchState<StressResponse> }): JSX.Element {
  const { loading, error, data } = state;
  const tone = data ? scoreTone(data.score) : 'ok';
  return (
    <Widget title="Stress index" {...(data?.asof_utc ? { count: data.asof_utc } : {})}>
      {loading && !data && <div className="mono text-[10px] text-txt-4">Loading…</div>}
      {!loading && error && <ErrorLine>Stress index unavailable ({error}).</ErrorLine>}
      {!loading && !error && data && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-baseline gap-2">
            <span className={`mono text-[24px] leading-none tabular-nums ${toneClass(tone).text}`}>
              {data.score.toFixed(0)}
            </span>
            <span className="text-[10px] text-txt-4">/ 100</span>
            {data.degraded && <span className="mono text-[10px] text-txt-4">· degraded inputs</span>}
          </div>
          {data.components.length === 0 ? (
            <div className="mono text-[10px] text-txt-4">No components reported.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {data.components.map((c) => (
                <ComponentBar key={c.key} c={c} />
              ))}
            </div>
          )}
        </div>
      )}
    </Widget>
  );
}
