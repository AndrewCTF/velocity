// Statistics / UN SDG / OSINT-resources sections — the original Country app
// surfaces, restyled onto the shared Card chrome. The World Bank grid excludes
// MS.MIL.* ids (those live in the Military posture card); the OSINT section
// owns its own detail fetch + ontology-ingest state.

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { isMilitaryIndicator } from './MilitaryCard.js';
import {
  Card,
  IndicatorCard,
  Skeleton,
  useCachedFetch,
  type FetchState,
  type Indicator,
  type UnResponse,
  type WorldBankResponse,
} from './shared.js';

function IndicatorGrid({ indicators }: { indicators: Indicator[] }): JSX.Element {
  return (
    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
      {indicators.map((ind) => (
        <IndicatorCard key={ind.id} ind={ind} />
      ))}
    </div>
  );
}

function GridSkeleton(): JSX.Element {
  return (
    <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Skeleton key={i} className="h-[74px]" />
      ))}
    </div>
  );
}

export function WorldBankSection({ state }: { state: FetchState<WorldBankResponse> }): JSX.Element {
  const civil = (state.data?.indicators ?? []).filter((i) => !isMilitaryIndicator(i.id));
  return (
    <Card title="Statistics — World Bank" meta={state.data ? `${state.data.source} · military series above` : undefined}>
      {state.loading && <GridSkeleton />}
      {!state.loading && state.error && (
        <div className="mono text-[10px] text-alert-fg">Failed: {state.error}</div>
      )}
      {!state.loading && !state.error && state.data && <IndicatorGrid indicators={civil} />}
    </Card>
  );
}

export function UnSection({ state }: { state: FetchState<UnResponse> }): JSX.Element {
  return (
    <Card title="UN SDG series" meta={state.data?.source}>
      {state.loading && <GridSkeleton />}
      {!state.loading && state.error && (
        <div className="mono text-[10px] text-alert-fg">Failed: {state.error}</div>
      )}
      {!state.loading && !state.error && state.data &&
        (state.data.series.length === 0 ? (
          <div className="mono text-[10px] text-txt-4">No UN series for this country.</div>
        ) : (
          <IndicatorGrid indicators={state.data.series} />
        ))}
    </Card>
  );
}

// ── OSINT resources (53-country awesome-osint catalog + ontology ingest) ────

interface OsintResource {
  name: string;
  url: string;
  category: string;
  note?: string;
  keyless?: boolean;
}

interface OsintDetail {
  code: string;
  name: string;
  region: string;
  iso2: string;
  source_url: string;
  resources: OsintResource[];
}

interface IngestResult {
  root: string;
  objects: number;
  links: number;
}

export function OsintSection({
  osintCode,
  catalogLoaded,
}: {
  osintCode: string | null;
  catalogLoaded: boolean;
}): JSX.Element {
  const osint = useCachedFetch<OsintDetail>(osintCode ? `/api/osint/countries/${osintCode}` : null);

  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  useEffect(() => {
    setIngestError(null);
    setIngestResult(null);
  }, [osintCode]);

  async function ingest(): Promise<void> {
    if (!osintCode) return;
    setIngestBusy(true);
    setIngestError(null);
    setIngestResult(null);
    try {
      const r = await apiFetch(`/api/osint/countries/${osintCode}/ingest`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.text();
        setIngestError(r.status === 401 ? 'Sign in to persist into the ontology' : `HTTP ${r.status}: ${body.slice(0, 200)}`);
        return;
      }
      setIngestResult((await r.json()) as IngestResult);
    } catch (e) {
      setIngestError(e instanceof Error ? e.message : String(e));
    } finally {
      setIngestBusy(false);
    }
  }

  const byCategory = useMemo(() => {
    if (!osint.data) return [] as [string, OsintResource[]][];
    const byCat = new Map<string, OsintResource[]>();
    for (const res of osint.data.resources) {
      const arr = byCat.get(res.category) ?? [];
      arr.push(res);
      byCat.set(res.category, arr);
    }
    return [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [osint.data]);

  return (
    <Card
      title="OSINT resources"
      meta={osint.data ? `${osint.data.resources.length} resources` : undefined}
    >
      {!osintCode && (
        <div className="mono text-[10px] text-txt-4">
          {catalogLoaded
            ? 'Not in the country-OSINT catalog (53 countries covered).'
            : 'OSINT catalog unavailable.'}
        </div>
      )}
      {osintCode && osint.loading && (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      )}
      {osintCode && !osint.loading && osint.error && (
        <div className="mono text-[10px] text-alert-fg">Failed: {osint.error}</div>
      )}
      {osint.data && (
        <>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <button
              type="button"
              disabled={ingestBusy}
              onClick={() => void ingest()}
              className="px-2.5 py-1.5 text-[11px] rounded-sm border border-line-2 bg-bg-2 text-txt-1 hover:text-txt-0 hover:border-accent disabled:opacity-50"
            >
              {ingestBusy ? 'Ingesting…' : 'Ingest into ontology'}
            </button>
            {ingestError && <span className="mono text-[10px] text-alert-fg">{ingestError}</span>}
            {ingestResult && (
              <span className="mono text-[10px] text-txt-2">
                {ingestResult.objects} objects · {ingestResult.links} links minted.
              </span>
            )}
          </div>
          <div className="grid gap-x-6 gap-y-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
            {byCategory.map(([category, resources]) => (
              <div key={category} className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">{category}</div>
                {resources.map((res) => (
                  <div key={res.url} className="py-0.5 min-w-0">
                    <a
                      href={res.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12px] text-txt-1 hover:text-accent truncate block"
                    >
                      {res.name}
                    </a>
                    {res.note && <div className="text-[10px] text-txt-4 truncate">{res.note}</div>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
