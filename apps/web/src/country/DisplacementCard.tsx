// Displacement card — country-level IDP/refugee counts from
// /api/displacement (UN OCHA HAPI). One shared response covers every
// country (useCachedFetch's URL-keyed cache means switching countries never
// re-fetches this), so the card just finds its own iso3's row. Hides
// cleanly — no card at all — when the country has no reported figures or the
// upstream is degraded, rather than rendering an empty shell.

import { Card, Skeleton, formatCompact, useCachedFetch } from './shared.js';

export interface DisplacementItem {
  iso3: string;
  country: string;
  idps: number | null;
  refugees: number | null;
  asof: string | null;
  source: string;
}

export interface DisplacementResponse {
  items: DisplacementItem[];
  source: string;
  unavailable: boolean;
}

function CountChip({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="flex items-baseline gap-1.5 px-2 py-1 rounded-sm border border-line-2 bg-bg-2">
      <span className="mono text-[13px] text-txt-0">{formatCompact(value)}</span>
      <span className="text-[9.5px] uppercase tracking-[0.5px] text-txt-3">{label}</span>
    </div>
  );
}

export function DisplacementCard({ iso3 }: { iso3: string }): JSX.Element | null {
  const { loading, error, data } = useCachedFetch<DisplacementResponse>('/api/displacement');

  if (loading) {
    return (
      <Card title="Displacement">
        <div className="flex gap-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-7 w-24" />
        </div>
      </Card>
    );
  }

  // Errors and a degraded upstream both hide the card rather than showing a
  // permanent "failed" shell for data that most countries won't have anyway.
  if (error || !data || data.unavailable) return null;

  const item = data.items.find((i) => i.iso3 === iso3);
  if (!item) return null;

  const idps = item.idps ?? 0;
  const refugees = item.refugees ?? 0;
  const total = idps + refugees;
  if (total <= 0) return null;

  const asofMonth = item.asof ? item.asof.slice(0, 7) : null;

  return (
    <Card title="Displacement" meta={item.source}>
      <div className="mono text-[14px] text-txt-0 mb-2">
        {formatCompact(total)} displaced
        {asofMonth ? ` · as of ${asofMonth}` : ''}
      </div>
      <div className="flex flex-wrap gap-2">
        {item.idps != null && <CountChip label="IDPs" value={item.idps} />}
        {item.refugees != null && <CountChip label="refugees" value={item.refugees} />}
      </div>
    </Card>
  );
}
