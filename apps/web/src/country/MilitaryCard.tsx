// Military posture card — Wikidata armed-forces service branches (chips) plus
// the World Bank MS.MIL.* indicators (expenditure %GDP / USD / % of gov,
// personnel, SIPRI arms transfer TIVs) rendered with sparklines. The MS.MIL.*
// ids are pulled OUT of the WB payload here; the Statistics grid excludes
// them so a figure never appears twice.

import {
  Card,
  IndicatorCard,
  Skeleton,
  type FetchState,
  type ProfileResponse,
  type WorldBankResponse,
} from './shared.js';

// WB military indicator ids, in display order (see routes/country_stats.py).
const MIL_IDS = [
  'MS.MIL.XPND.GD.ZS',
  'MS.MIL.XPND.CD',
  'MS.MIL.XPND.ZS',
  'MS.MIL.TOTL.P1',
  'MS.MIL.MPRT.KD',
  'MS.MIL.XPRT.KD',
];

export function isMilitaryIndicator(id: string): boolean {
  return id.startsWith('MS.MIL.');
}

export function MilitaryCard({
  profile,
  wb,
}: {
  profile: FetchState<ProfileResponse>;
  wb: FetchState<WorldBankResponse>;
}): JSX.Element {
  const branches = profile.data?.military_branches ?? [];
  const milInds = (wb.data?.indicators ?? [])
    .filter((i) => isMilitaryIndicator(i.id))
    .sort((a, b) => {
      const ai = MIL_IDS.indexOf(a.id);
      const bi = MIL_IDS.indexOf(b.id);
      return (ai === -1 ? MIL_IDS.length : ai) - (bi === -1 ? MIL_IDS.length : bi);
    });
  return (
    <Card title="Military posture" meta={wb.data ? 'worldbank + wikidata' : undefined}>
      <div className="mb-2">
        <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">Service branches</div>
        {profile.loading && (
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-28" />
          </div>
        )}
        {!profile.loading && profile.error && (
          <div className="mono text-[10px] text-alert-fg">Failed: {profile.error}</div>
        )}
        {!profile.loading && !profile.error && branches.length === 0 && (
          <div className="mono text-[10px] text-txt-4">
            {profile.data?.unavailable ? 'Wikidata unavailable.' : 'No service-branch structure on Wikidata.'}
          </div>
        )}
        {branches.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {branches.map((b) => (
              <span
                key={b}
                className="px-1.5 py-0.5 text-[10px] rounded-sm border border-line-2 bg-bg-2 text-txt-1"
              >
                {b}
              </span>
            ))}
          </div>
        )}
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">Indicators</div>
        {wb.loading && (
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[74px]" />
            ))}
          </div>
        )}
        {!wb.loading && wb.error && <div className="mono text-[10px] text-alert-fg">Failed: {wb.error}</div>}
        {!wb.loading && !wb.error && wb.data && milInds.length === 0 && (
          <div className="mono text-[10px] text-txt-4">No military indicators in the World Bank payload.</div>
        )}
        {milInds.length > 0 && (
          <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
            {milInds.map((ind) => (
              <IndicatorCard key={ind.id} ind={ind} />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
