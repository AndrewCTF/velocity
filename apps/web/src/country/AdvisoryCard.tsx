// Travel advisories card — /api/advisories returns a flat, country-level list
// pooled across three official keyless sources (US State, UK FCDO, Australia
// Smartraveller); this card filters that shared list down to the selected
// iso3 client-side, so the fetch (and its cache entry) is reused across every
// country tab switch instead of re-hitting the backend per country.

import { useCachedFetch, Card, CaveatList } from './shared.js';

interface AdvisoryItem {
  country: string;
  iso3: string | null;
  level: 1 | 2 | 3 | 4;
  source: 'us-state' | 'uk-fcdo' | 'au-smartraveller';
  title: string;
  link: string | null;
  updated_utc: string | null;
}

interface AdvisoriesResponse {
  items: AdvisoryItem[];
  sources: string[];
  unavailable: boolean;
}

const SOURCE_LABEL: Record<AdvisoryItem['source'], string> = {
  'us-state': 'US State Dept',
  'uk-fcdo': 'UK FCDO',
  'au-smartraveller': 'Australia Smartraveller',
};

const LEVEL_TONE: Record<number, string> = {
  1: 'border-line-2 bg-bg-2 text-txt-1',
  2: 'border-line-2 bg-bg-2 text-txt-1',
  3: 'border-warn-line bg-warn-bg text-warn-fg',
  4: 'border-alert-line bg-alert-bg text-alert-fg',
};

function LevelChip({ level }: { level: number }): JSX.Element {
  return (
    <span
      className={`mono text-[9.5px] uppercase px-1.5 py-px rounded-sm border shrink-0 ${LEVEL_TONE[level] ?? LEVEL_TONE[1]}`}
    >
      Level {level}
    </span>
  );
}

function AdvisoryRow({ item }: { item: AdvisoryItem }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-1 border-b border-line last:border-b-0 min-w-0">
      <LevelChip level={item.level} />
      <div className="min-w-0 flex-1">
        {item.link ? (
          <a
            href={item.link}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-txt-1 hover:text-txt-0 hover:underline"
          >
            {item.title}
          </a>
        ) : (
          <span className="text-[11px] text-txt-1">{item.title}</span>
        )}
        <span className="text-[10px] text-txt-3"> · {SOURCE_LABEL[item.source]}</span>
      </div>
    </div>
  );
}

export function AdvisoryCard({ iso3 }: { iso3: string }): JSX.Element {
  const { loading, error, data } = useCachedFetch<AdvisoriesResponse>('/api/advisories');
  const items = (data?.items ?? []).filter((it) => it.iso3 === iso3);
  const notes: string[] = [];
  if (data?.unavailable) notes.push('All advisory sources are unavailable — try again shortly.');

  return (
    <Card title="Travel advisories" meta={data ? `${items.length} of ${data.sources.length} sources` : undefined}>
      {loading && <div className="mono text-[10px] text-txt-4">loading…</div>}
      {!loading && error && (
        <div className="mono text-[10px] text-alert-fg">Advisories unavailable: {error}</div>
      )}
      {!loading && !error && data && (
        <>
          {items.length === 0 ? (
            <div className="mono text-[10px] text-txt-4">
              {data.unavailable ? 'No advisory data available.' : 'No advisories reported for this country.'}
            </div>
          ) : (
            <div className="flex flex-col">
              {items.map((it) => (
                <AdvisoryRow key={`${it.source}-${it.country}`} item={it} />
              ))}
            </div>
          )}
          <CaveatList notes={notes} />
        </>
      )}
    </Card>
  );
}
