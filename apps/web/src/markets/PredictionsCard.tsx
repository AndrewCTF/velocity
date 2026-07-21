// Predictions card — prediction-market questions from /api/markets/predictions:
// question, probability as a percent, 24h volume, outbound link to the market.
import { Widget, ErrorLine } from './primitives.js';
import type { FetchState, PredictionItem, PredictionsResponse } from './types.js';

function fmtVolume(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

function Row({ item }: { item: PredictionItem }): JSX.Element {
  const pct = Math.round(item.prob * 100);
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-center gap-2 py-1.5 border-b border-line/60 last:border-b-0 min-w-0 hover:bg-bg-2 rounded-sm px-1 -mx-1"
    >
      <span className="text-[11px] text-txt-1 flex-1 min-w-0 truncate" title={item.question}>
        {item.question}
      </span>
      <span className="mono text-[11px] text-txt-0 tabular-nums w-10 text-right shrink-0">{pct}%</span>
      <span className="mono text-[10px] text-txt-4 tabular-nums w-16 text-right shrink-0">
        {fmtVolume(item.volume_24h)} · 24h
      </span>
    </a>
  );
}

export function PredictionsCard({ state }: { state: FetchState<PredictionsResponse> }): JSX.Element {
  const { loading, error, data } = state;
  return (
    <Widget title="Predictions">
      {loading && !data && <div className="mono text-[10px] text-txt-4">Loading…</div>}
      {!loading && error && <ErrorLine>Predictions unavailable ({error}).</ErrorLine>}
      {!loading && !error && data?.unavailable && (
        <div className="mono text-[10px] text-txt-4">Predictions unavailable · retries on the next poll.</div>
      )}
      {!loading && !error && data && !data.unavailable && (
        <>
          {data.items.length === 0 ? (
            <div className="mono text-[10px] text-txt-4">No open markets.</div>
          ) : (
            <div className="flex flex-col">
              {data.items.map((it) => (
                <Row key={it.question} item={it} />
              ))}
            </div>
          )}
        </>
      )}
    </Widget>
  );
}
