// Country app (shell full-page surface, wired in state/appView.ts +
// shell/AppSurface.tsx). Left rail = all 249 countries (search + region
// groups); selecting one loads World Bank indicators, UN SDG series, and —
// where the 53-country OSINT catalog covers it — the per-country resource
// list with ontology ingest. All backend calls go through apiFetch
// (transport invariant); sparklines are hand-rolled SVG, no chart lib.

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../transport/http.js';

interface CountryRow {
  name: string;
  iso2: string;
  iso3: string;
  m49: string;
  region: string;
  sub_region: string;
}

interface SeriesPoint {
  year: number;
  value: number | null;
}

interface Indicator {
  id: string;
  label: string;
  unit: string;
  series: SeriesPoint[];
  unavailable?: boolean;
}

interface WorldBankResponse {
  iso3: string;
  name: string;
  source: string;
  indicators: Indicator[];
}

interface UnResponse {
  iso3: string;
  name: string;
  m49: string;
  source: string;
  series: Indicator[];
}

// /api/osint/countries shapes (mirrors osint/CountriesPanel.tsx).
interface OsintCountrySummary {
  code: string;
  name: string;
  region: string;
  iso2: string;
  source_url: string;
  resource_count: number;
  category_counts: Record<string, number>;
}

interface OsintCatalog {
  count: number;
  regions: string[];
  categories: string[];
  countries: OsintCountrySummary[];
}

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

// Regional-indicator flag emoji from iso2 (same guard as CountriesPanel).
function flagEmoji(iso2: string | undefined | null): string {
  if (!iso2 || iso2.length !== 2) return '\u{1F310}';
  const upper = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '\u{1F310}';
  return String.fromCodePoint(...[...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

// Compact number: 1.2T / 340M / 12.3 — trims trailing ".0".
function formatCompact(v: number): string {
  const abs = Math.abs(v);
  const fmt = (n: number, suffix: string): string => {
    const s = n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
    return `${s}${suffix}`;
  };
  if (abs >= 1e12) return fmt(v / 1e12, 'T');
  if (abs >= 1e9) return fmt(v / 1e9, 'B');
  if (abs >= 1e6) return fmt(v / 1e6, 'M');
  if (abs >= 1e4) return fmt(v / 1e3, 'k');
  if (abs >= 100 || Number.isInteger(v)) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v.toFixed(abs >= 1 ? 1 : 2).replace(/\.0+$/, '');
}

function Sparkline({ series }: { series: SeriesPoint[] }): JSX.Element | null {
  const pts = series.filter((p): p is { year: number; value: number } => p.value != null);
  if (pts.length < 2) return null;
  const w = 96;
  const h = 24;
  const xs = pts.map((p) => p.year);
  const ys = pts.map((p) => p.value);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const sx = (x: number): number => (x1 === x0 ? w / 2 : ((x - x0) / (x1 - x0)) * (w - 2) + 1);
  const sy = (y: number): number => (y1 === y0 ? h / 2 : h - 1 - ((y - y0) / (y1 - y0)) * (h - 2));
  const path = pts.map((p) => `${sx(p.year).toFixed(1)},${sy(p.value).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" aria-hidden>
      <polyline points={path} fill="none" stroke="var(--accent, #3b82f6)" strokeWidth="1.25" />
    </svg>
  );
}

function IndicatorCard({ ind }: { ind: Indicator }): JSX.Element {
  const latest = [...ind.series].reverse().find((p) => p.value != null);
  const noData = ind.unavailable || !latest;
  return (
    <div className="border border-line-2 bg-bg-1 rounded-sm p-2.5 flex flex-col gap-1 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 truncate" title={ind.label}>
        {ind.label}
      </div>
      {noData ? (
        <div className="mono text-[11px] text-txt-4">no data</div>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="mono text-[16px] text-txt-0">{formatCompact(latest.value as number)}</span>
            {ind.unit && <span className="text-[10px] text-txt-3 truncate">{ind.unit}</span>}
            <span className="mono text-[9.5px] text-txt-4 ml-auto shrink-0">{latest.year}</span>
          </div>
          <Sparkline series={ind.series} />
        </>
      )}
    </div>
  );
}

function SectionHeader({ title, meta }: { title: string; meta?: string | undefined }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 mb-2">
      <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0">{title}</span>
      {meta && <span className="mono text-[9.5px] text-txt-4">{meta}</span>}
    </div>
  );
}

type FetchState<T> = { loading: boolean; error: string | null; data: T | null };

function useCountryFetch<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ loading: false, error: null, data: null });
  useEffect(() => {
    if (!url) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    let live = true;
    setState({ loading: true, error: null, data: null });
    apiFetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => live && setState({ loading: false, error: null, data }))
      .catch((e: unknown) => live && setState({ loading: false, error: e instanceof Error ? e.message : String(e), data: null }));
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

export function CountryApp(): JSX.Element {
  const [countries, setCountries] = useState<CountryRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [osintCatalog, setOsintCatalog] = useState<OsintCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CountryRow | null>(null);

  useEffect(() => {
    apiFetch('/api/country/list')
      .then((r) => (r.ok ? (r.json() as Promise<CountryRow[]>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCountries)
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)));
    // OSINT catalog is optional — a failure only hides section 3.
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

  const wb = useCountryFetch<WorldBankResponse>(selected ? `/api/country/${selected.iso3}/worldbank` : null);
  const un = useCountryFetch<UnResponse>(selected ? `/api/country/${selected.iso3}/un` : null);

  // OSINT detail only when the catalog covers the selected country's iso2.
  const osintCode = useMemo(() => {
    if (!selected || !osintCatalog) return null;
    const code = selected.iso2.toLowerCase();
    return osintCatalog.countries.some((c) => c.iso2.toLowerCase() === code || c.code === code) ? code : null;
  }, [selected, osintCatalog]);
  const osint = useCountryFetch<OsintDetail>(osintCode ? `/api/osint/countries/${osintCode}` : null);

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

  const osintByCategory = useMemo(() => {
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
    <div className="h-full flex text-txt-1 bg-bg-0">
      {/* Left rail: search + region-grouped country list */}
      <nav className="w-[240px] shrink-0 border-r border-line-2 bg-bg-1 flex flex-col min-h-0">
        <div className="p-2 border-b border-line-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 249 countries…"
            className="w-full bg-bg-2 border border-line-2 rounded-sm px-2 py-1.5 text-[12px] text-txt-0 placeholder:text-txt-4 outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-auto py-1">
          {!countries && !listError && <div className="mono text-[10px] text-txt-4 px-3 py-2">Loading countries…</div>}
          {listError && <div className="mono text-[10px] text-[var(--alert,#ef4444)] px-3 py-2">Failed to load: {listError}</div>}
          {grouped.map(([region, rows]) => (
            <div key={region} className="mb-1">
              <div className="px-3 pt-2 pb-1 text-[9.5px] uppercase tracking-[0.6px] text-txt-4 flex justify-between">
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
                    className={[
                      'w-full text-left px-3 py-1 flex items-center gap-2 text-[12px] border-l-2 transition-colors',
                      on
                        ? 'border-accent bg-accent-dim text-txt-0'
                        : 'border-transparent text-txt-2 hover:text-txt-0 hover:bg-bg-2',
                    ].join(' ')}
                  >
                    <span aria-hidden>{flagEmoji(c.iso2)}</span>
                    <span className="truncate">{c.name}</span>
                    <span className="mono text-[9.5px] text-txt-4 ml-auto shrink-0">{c.iso3}</span>
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

      {/* Main area */}
      <div className="flex-1 min-w-0 overflow-auto">
        {!selected ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <div className="text-[13px] text-txt-2">Select a country</div>
              <div className="mono text-[10px] text-txt-4 mt-1">
                World Bank indicators · UN SDG series · country OSINT toolkits
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 flex flex-col gap-6 max-w-[1100px]">
            <div className="flex items-baseline gap-3">
              <span className="text-[18px]" aria-hidden>
                {flagEmoji(selected.iso2)}
              </span>
              <span className="text-[15px] font-semibold text-txt-0">{selected.name}</span>
              <span className="mono text-[10px] text-txt-4">
                {selected.iso2} · {selected.iso3} · m49 {selected.m49}
              </span>
              <span className="mono text-[10px] text-txt-3">
                {selected.region}
                {selected.sub_region ? ` · ${selected.sub_region}` : ''}
              </span>
            </div>

            <section>
              <SectionHeader title="Statistics — World Bank" meta={wb.data?.source} />
              {wb.loading && <div className="mono text-[10px] text-txt-4">Loading…</div>}
              {wb.error && <div className="mono text-[10px] text-[var(--alert,#ef4444)]">Failed: {wb.error}</div>}
              {wb.data && (
                <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
                  {wb.data.indicators.map((ind) => (
                    <IndicatorCard key={ind.id} ind={ind} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <SectionHeader title="UN SDG series" meta={un.data?.source} />
              {un.loading && <div className="mono text-[10px] text-txt-4">Loading…</div>}
              {un.error && <div className="mono text-[10px] text-[var(--alert,#ef4444)]">Failed: {un.error}</div>}
              {un.data &&
                (un.data.series.length === 0 ? (
                  <div className="mono text-[10px] text-txt-4">No UN series for this country.</div>
                ) : (
                  <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(170px,1fr))]">
                    {un.data.series.map((ind) => (
                      <IndicatorCard key={ind.id} ind={ind} />
                    ))}
                  </div>
                ))}
            </section>

            <section>
              <SectionHeader title="OSINT resources" meta={osint.data ? `${osint.data.resources.length} resources` : undefined} />
              {!osintCode && (
                <div className="mono text-[10px] text-txt-4">
                  {osintCatalog
                    ? 'Not in the country-OSINT catalog (53 countries covered).'
                    : 'OSINT catalog unavailable.'}
                </div>
              )}
              {osintCode && osint.loading && <div className="mono text-[10px] text-txt-4">Loading…</div>}
              {osintCode && osint.error && (
                <div className="mono text-[10px] text-[var(--alert,#ef4444)]">Failed: {osint.error}</div>
              )}
              {osint.data && (
                <>
                  <div className="flex items-center gap-3 mb-3">
                    <button
                      type="button"
                      disabled={ingestBusy}
                      onClick={() => void ingest()}
                      className="px-2.5 py-1.5 text-[11px] rounded-sm border border-line-2 bg-bg-2 text-txt-1 hover:text-txt-0 hover:border-accent disabled:opacity-50"
                    >
                      {ingestBusy ? 'Ingesting…' : 'Ingest into ontology'}
                    </button>
                    {ingestError && <span className="mono text-[10px] text-[var(--alert,#ef4444)]">{ingestError}</span>}
                    {ingestResult && (
                      <span className="mono text-[10px] text-txt-2">
                        {ingestResult.objects} objects · {ingestResult.links} links minted.
                      </span>
                    )}
                  </div>
                  <div className="grid gap-x-6 gap-y-4 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
                    {osintByCategory.map(([category, resources]) => (
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
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
