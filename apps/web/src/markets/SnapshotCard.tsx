// Snapshot card — four sections (indices/commodities/fx/crypto) from
// /api/markets/snapshot. Each row is symbol · name · last · 24h change, with
// change colored up/down and a `—` for any value the backend didn't report.
import { Widget, Skeleton } from './primitives.js';
import type { FetchState, SnapshotItem, SnapshotResponse } from './types.js';

const SECTIONS: [keyof Pick<SnapshotResponse, 'indices' | 'commodities' | 'fx' | 'crypto'>, string][] = [
  ['indices', 'Indices'],
  ['commodities', 'Commodities'],
  ['fx', 'FX'],
  ['crypto', 'Crypto'],
];

function fmtNumber(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toFixed(4);
}

function ChangePct({ v }: { v: number | null }): JSX.Element {
  if (v == null || !Number.isFinite(v)) return <span className="mono text-[11px] text-txt-4">—</span>;
  const up = v > 0;
  const flat = v === 0;
  const color = flat ? 'text-txt-3' : up ? 'text-ok' : 'text-alert-fg';
  const sign = up ? '+' : '';
  return (
    <span className={`mono text-[11px] tabular-nums ${color}`}>
      {sign}
      {v.toFixed(2)}%
    </span>
  );
}

function Row({ item }: { item: SnapshotItem }): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1 border-b border-line/60 last:border-b-0 min-w-0">
      <span className="mono text-[11px] text-txt-0 w-16 shrink-0 truncate" title={item.symbol}>
        {item.symbol}
      </span>
      <span className="text-[11px] text-txt-3 flex-1 min-w-0 truncate" title={item.name}>
        {item.name}
      </span>
      <span className="mono text-[11px] text-txt-1 tabular-nums w-20 text-right shrink-0">
        {fmtNumber(item.last)}
      </span>
      <span className="w-16 text-right shrink-0">
        <ChangePct v={item.change_pct_24h} />
      </span>
    </div>
  );
}

function Section({ label, items }: { label: string; items: SnapshotItem[] }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.5px] text-txt-4 mb-1">{label}</div>
      {items.length === 0 ? (
        <div className="mono text-[10px] text-txt-4">No data.</div>
      ) : (
        <div className="flex flex-col">
          {items.map((it) => (
            <Row key={it.symbol} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

export function SnapshotCard({ state }: { state: FetchState<SnapshotResponse> }): JSX.Element {
  const { loading, error, data } = state;
  return (
    <Widget title="Snapshot" {...(data?.asof_utc ? { count: data.asof_utc } : {})}>
      {loading && !data && (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}
      {!loading && error && (
        <div className="mono text-[10px] text-alert-fg">Markets unavailable ({error}).</div>
      )}
      {!loading && !error && data?.unavailable && (
        <div className="mono text-[10px] text-txt-4">Markets snapshot unavailable · retries on the next poll.</div>
      )}
      {!loading && !error && data && !data.unavailable && (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
          {SECTIONS.map(([key, label]) => (
            <Section key={key} label={label} items={data[key] ?? []} />
          ))}
        </div>
      )}
    </Widget>
  );
}
