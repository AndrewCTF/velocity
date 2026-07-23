// Country intelligence app (shell full-page surface, wired in
// state/appView.ts + shell/AppSurface.tsx). Left rail = all 249 countries
// (sticky search + region groups); the main surface for a selected country is
// an instrument stack: header band (flag + quick stats), Wikidata leadership
// portraits, military posture (branches + WB MS.MIL.* series), fused security
// events, an on-demand LLM country brief, then the World Bank / UN SDG /
// OSINT-resource sections. Profile + security load in parallel on selection
// (AbortController on switch); every card owns its own error/empty state so
// one failed upstream never blanks the page; responses cache per iso3 in a
// module map (shared.tsx) so switching back is instant. All backend calls go
// through apiFetch (transport invariant).

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { AdvisoryCard } from './AdvisoryCard.js';
import { BriefCard } from './BriefCard.js';
import { CountryNewsCard } from './CountryNewsCard.js';
import { DisplacementCard } from './DisplacementCard.js';
import { InstabilityCard } from './InstabilityCard.js';
import { LeadershipCard } from './LeadershipCard.js';
import { MilitaryCard } from './MilitaryCard.js';
import { SecurityCard } from './SecurityCard.js';
import { OsintSection, UnSection, WorldBankSection } from './StatsSections.js';
import {
  Skeleton,
  flagEmoji,
  formatCompact,
  useCachedFetch,
  type CountryRow,
  type FetchState,
  type ProfileResponse,
  type SecurityResponse,
  type UnResponse,
  type WorldBankResponse,
} from './shared.js';

// /api/osint/countries summary shape (mirrors osint/CountriesPanel.tsx).
interface OsintCountrySummary {
  code: string;
  iso2: string;
}

interface OsintCatalog {
  count: number;
  countries: OsintCountrySummary[];
}

// Header-band quick stats, pulled from the WB payload once it lands.
const CHIP_IDS: [string, string][] = [
  ['SP.POP.TOTL', 'Population'],
  ['NY.GDP.MKTP.CD', 'GDP'],
  ['MS.MIL.XPND.CD', 'Mil spend'],
];

function QuickStats({ wb }: { wb: FetchState<WorldBankResponse> }): JSX.Element {
  if (wb.loading) {
    return (
      <div className="flex gap-2">
        {CHIP_IDS.map(([id]) => (
          <Skeleton key={id} className="h-9 w-24" />
        ))}
      </div>
    );
  }
  if (!wb.data) return <></>;
  const byId = new Map(wb.data.indicators.map((i) => [i.id, i]));
  return (
    <div className="flex gap-2 flex-wrap">
      {CHIP_IDS.map(([id, label]) => {
        const ind = byId.get(id);
        const latest = ind ? [...ind.series].reverse().find((p) => p.value != null) : undefined;
        return (
          <div key={id} className="px-2 py-1 rounded-sm border border-line-2 bg-bg-1 min-w-[88px]">
            <div className="text-[9px] uppercase tracking-[0.5px] text-txt-4">{label}</div>
            <div className="flex items-baseline gap-1">
              <span className="mono text-[13px] text-txt-0">
                {latest ? formatCompact(latest.value as number) : '—'}
              </span>
              {latest && <span className="mono text-[9px] text-txt-4">{latest.year}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HeaderBand({
  country,
  wb,
}: {
  country: CountryRow;
  wb: FetchState<WorldBankResponse>;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-[26px] leading-none" aria-hidden>
        {flagEmoji(country.iso2)}
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[16px] font-semibold text-txt-0">{country.name}</span>
          <span className="mono text-[10px] text-txt-4">
            {country.iso2} · {country.iso3} · m49 {country.m49}
          </span>
        </div>
        <div className="mono text-[10px] text-txt-3">
          {country.region}
          {country.sub_region ? ` · ${country.sub_region}` : ''}
        </div>
      </div>
      <div className="ml-auto">
        <QuickStats wb={wb} />
      </div>
    </div>
  );
}

export function CountryApp(): JSX.Element {
  const [countries, setCountries] = useState<CountryRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [osintCatalog, setOsintCatalog] = useState<OsintCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CountryRow | null>(null);

  useEffect(() => {
    apiFetch('/api/country/list')
      .then((r) => (r.ok ? (r.json() as Promise<CountryRow[]>) : Promise.reject(new Error(`Country list unavailable (HTTP ${r.status})`))))
      .then(setCountries)
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)));
    // OSINT catalog is optional — a failure only degrades the resources card.
    apiFetch('/api/osint/countries')
      .then((r) => (r.ok ? (r.json() as Promise<OsintCatalog>) : null))
      .then((c) => c && setOsintCatalog(c))
      .catch(() => undefined);
  }, []);

  const grouped = useMemo(() => {
    if (!countries) return [] as [string, CountryRow[]][];
    const q = query.trim().toLowerCase();
    const byRegion = new Map<string, CountryRow[]>();
    for (const c of countries) {
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !c.iso2.toLowerCase().includes(q) &&
        !c.iso3.toLowerCase().includes(q)
      )
        continue;
      const region = c.region || 'Other';
      const arr = byRegion.get(region) ?? [];
      arr.push(c);
      byRegion.set(region, arr);
    }
    for (const arr of byRegion.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
    return [...byRegion.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [countries, query]);

  // Per-selection loads — the two new intel endpoints fire in parallel with
  // the WB/UN stats; each hook aborts its in-flight request on switch and
  // serves repeat visits from the module cache.
  const iso3 = selected?.iso3 ?? null;
  const profile = useCachedFetch<ProfileResponse>(iso3 ? `/api/country/${iso3}/profile` : null);
  const security = useCachedFetch<SecurityResponse>(iso3 ? `/api/country/${iso3}/security?hours=24` : null);
  const wb = useCachedFetch<WorldBankResponse>(iso3 ? `/api/country/${iso3}/worldbank` : null);
  const un = useCachedFetch<UnResponse>(iso3 ? `/api/country/${iso3}/un` : null);

  // OSINT detail only when the catalog covers the selected country's iso2.
  const osintCode = useMemo(() => {
    if (!selected || !osintCatalog) return null;
    const code = selected.iso2.toLowerCase();
    return osintCatalog.countries.some((c) => c.iso2.toLowerCase() === code || c.code === code) ? code : null;
  }, [selected, osintCatalog]);

  return (
    <div className="h-full flex text-txt-1 bg-bg-0">
      {/* Left rail: sticky search + region-grouped country list */}
      <nav className="w-[240px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col min-h-0">
        <div className="p-2 border-b border-line-2 sticky top-0 bg-bg-1 z-10">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 249 countries…"
            aria-label="Search countries"
            className="w-full bg-bg-2 border border-line-2 rounded-sm px-2 py-1.5 text-[12px] text-txt-0 placeholder:text-txt-4 outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-auto py-1">
          {!countries && !listError && (
            <div className="px-3 py-2 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          )}
          {listError && <div className="mono text-[10px] text-alert-fg px-3 py-2">Failed to load: {listError}</div>}
          {grouped.map(([region, rows]) => (
            <div key={region} className="mb-1">
              <div className="px-3 pt-2 pb-1 text-[9.5px] uppercase tracking-[0.6px] text-txt-4 flex justify-between sticky top-0 bg-bg-1 z-[5]">
                <span>{region}</span>
                <span className="mono">{rows.length}</span>
              </div>
              {rows.map((c) => {
                const on = selected?.iso3 === c.iso3;
                return (
                  <button
                    key={c.iso3}
                    type="button"
                    onClick={() => setSelected(c)}
                    aria-current={on ? 'true' : undefined}
                    className={[
                      'w-full text-left px-3 py-1 flex items-center gap-2 text-[12px] border-l-2 transition-colors',
                      on
                        ? 'border-accent bg-accent-dim text-txt-0'
                        : 'border-transparent text-txt-2 hover:text-txt-0 hover:bg-bg-2',
                    ].join(' ')}
                  >
                    <span aria-hidden>{flagEmoji(c.iso2)}</span>
                    <span className="truncate">{c.name}</span>
                    <span
                      className={[
                        'mono text-[9.5px] ml-auto shrink-0 px-1 py-px rounded-sm border',
                        on ? 'border-accent-line text-accent-fg' : 'border-line text-txt-4',
                      ].join(' ')}
                    >
                      {c.iso3}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {countries && grouped.length === 0 && (
            <div className="mono text-[10px] text-txt-4 px-3 py-2">No match.</div>
          )}
        </div>
      </nav>

      {/* Main surface */}
      <div className="flex-1 min-w-0 overflow-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-[13px] text-txt-2">Select a country</div>
              <div className="mono text-[10px] text-txt-4 mt-1">
                leadership · military posture · security events · AI brief · statistics
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-3 max-w-[1100px]">
            <HeaderBand country={selected} wb={wb} />
            <LeadershipCard state={profile} />
            <MilitaryCard profile={profile} wb={wb} />
            <SecurityCard state={security} />
            <CountryNewsCard iso3={selected.iso3} />
            <AdvisoryCard iso3={selected.iso3} />
            <DisplacementCard iso3={selected.iso3} />
            <InstabilityCard iso3={selected.iso3} />
            {/* key= so an in-flight generation aborts + state resets on switch */}
            <BriefCard key={selected.iso3} iso3={selected.iso3} />
            <WorldBankSection state={wb} />
            <UnSection state={un} />
            <OsintSection osintCode={osintCode} catalogLoaded={osintCatalog != null} />
          </div>
        )}
      </div>
    </div>
  );
}
