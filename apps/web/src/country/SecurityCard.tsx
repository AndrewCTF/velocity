// Security events card — the fused per-country picture from
// /api/country/{iso3}/security: a counts row (GDELT conflict / UCDP / military
// installations), the recent event list (deaths badge when present, source
// tag), and the backend's data-honesty notes as muted caveats. Empty states
// stay honest: a zero is labeled as a coverage gap when the backend says so.

import {
  Card,
  CaveatList,
  Skeleton,
  type FetchState,
  type SecurityEvent,
  type SecurityResponse,
} from './shared.js';

function CountChip({ label, value, hot }: { label: string; value: number; hot: boolean }): JSX.Element {
  return (
    <div
      className={[
        'flex items-baseline gap-1.5 px-2 py-1 rounded-sm border',
        hot ? 'border-warn-line bg-warn-bg' : 'border-line-2 bg-bg-2',
      ].join(' ')}
    >
      <span className={`mono text-[14px] ${hot ? 'text-warn-fg' : 'text-txt-0'}`}>{value}</span>
      <span className="text-[9.5px] uppercase tracking-[0.5px] text-txt-3">{label}</span>
    </div>
  );
}

function EventRow({ ev }: { ev: SecurityEvent }): JSX.Element {
  const actors = (ev.actors ?? []).filter((a): a is string => Boolean(a));
  return (
    <div className="flex items-baseline gap-2 py-1 border-b border-line last:border-b-0 min-w-0">
      <span className="mono text-[9.5px] text-txt-4 shrink-0 w-[72px]">{ev.date ?? '—'}</span>
      <div className="min-w-0 flex-1">
        <span className="text-[11px] text-txt-1">{ev.label || 'event'}</span>
        {actors.length > 0 && (
          <span className="text-[10px] text-txt-3"> · {actors.join(' vs ')}</span>
        )}
      </div>
      {ev.deaths != null && ev.deaths > 0 && (
        <span className="mono text-[9.5px] px-1 py-px rounded-sm border border-alert-line bg-alert-bg text-alert-fg shrink-0">
          {ev.deaths} killed
        </span>
      )}
      <span className="mono text-[9px] uppercase px-1 py-px rounded-sm border border-line-2 bg-bg-3 text-txt-3 shrink-0">
        {ev.source ?? '?'}
      </span>
    </div>
  );
}

export function SecurityCard({ state }: { state: FetchState<SecurityResponse> }): JSX.Element {
  const { loading, error, data } = state;
  return (
    <Card title="Security events" meta={data ? `last ${data.window_hours} h` : undefined}>
      {loading && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-7 w-32" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {!loading && error && <div className="mono text-[10px] text-alert-fg">Failed to load security picture: {error}</div>}
      {!loading && !error && data && (
        <>
          <div className="flex flex-wrap gap-2 mb-2">
            <CountChip label="conflict (GDELT)" value={data.counts.conflict} hot={data.counts.conflict > 0} />
            <CountChip label="UCDP" value={data.counts.ucdp} hot={data.counts.ucdp > 0} />
            <CountChip label="installations" value={data.counts.installations} hot={false} />
          </div>
          {data.events.length === 0 ? (
            <div className="mono text-[10px] text-txt-4">
              No matching events in the last {data.window_hours} h
              {data.sources.ucdp?.unavailable ? ' — UCDP source token-gated' : ''}.
            </div>
          ) : (
            <div className="flex flex-col">
              {data.events.map((ev, i) => (
                <EventRow key={`${ev.source}-${ev.date}-${ev.label}-${i}`} ev={ev} />
              ))}
            </div>
          )}
          <CaveatList notes={data.notes} />
        </>
      )}
    </Card>
  );
}
