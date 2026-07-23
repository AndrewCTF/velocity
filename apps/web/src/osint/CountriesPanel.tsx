// Country-OSINT catalog panel (docs/country-osint-spec.md §Frontend) — the
// 53-country toolkit (unishka.com/osint-world-series) served behind
// /api/osint/countries. On mount, GET the summary list grouped by region
// (collapsible); selecting a country GETs its full resource list grouped by
// category. Ingest mirrors InvestigatePanel's post→select→searchAround flow
// so the country's linked graph (country: -has_resource-> resource: -hosted_at->
// domain:) lands in the Investigation canvas.

import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { useSelection } from '../state/stores.js';

interface CountrySummary {
  code: string;
  name: string;
  region: string;
  iso2: string;
  source_url: string;
  resource_count: number;
  category_counts: Record<string, number>;
}

interface CountryListResponse {
  count: number;
  regions: string[];
  categories: string[];
  countries: CountrySummary[];
}

interface CountryResource {
  name: string;
  url: string;
  category: string;
  note?: string;
  keyless?: boolean;
}

interface CountryDetail {
  code: string;
  name: string;
  region: string;
  iso2: string;
  source_url: string;
  resources: CountryResource[];
}

interface IngestResult {
  root: string;
  objects: number;
  links: number;
}

// Regional-indicator-symbol flag emoji from a 2-letter ISO code (A → 🇦 is
// U+1F1E6, offset from ASCII 'A'). Guards codes that aren't exactly two
// A-Z letters (e.g. a missing/malformed iso2) by falling back to a globe
// glyph instead of emitting garbage codepoints.
function flagEmoji(iso2: string | undefined | null): string {
  if (!iso2 || iso2.length !== 2) return '\u{1F310}';
  const upper = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '\u{1F310}';
  const points = [...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...points);
}

export function CountriesPanel(): JSX.Element {
  const [list, setList] = useState<CountryListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CountryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [collapsedRegions, setCollapsedRegions] = useState<Record<string, boolean>>({});

  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);

  useEffect(() => {
    apiFetch('/api/osint/countries')
      .then((r) => (r.ok ? (r.json() as Promise<CountryListResponse>) : Promise.reject(new Error(String(r.status)))))
      .then(setList)
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)));
  }, []);

  const latestCodeRef = useRef<string | null>(null);

  function selectCountry(code: string): void {
    latestCodeRef.current = code;
    setSelected(code);
    setDetail(null);
    setDetailError(null);
    setIngestResult(null);
    setIngestError(null);
    setDetailLoading(true);
    // Guard every state write against the CURRENT selection: click France then
    // Germany quickly and, if France resolves last, its detail would otherwise
    // paint under a Germany selection and Ingest (keyed off `selected`) would act
    // on Germany with France's resources on screen.
    apiFetch(`/api/osint/countries/${code}`)
      .then((r) => (r.ok ? (r.json() as Promise<CountryDetail>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (latestCodeRef.current === code) setDetail(d);
      })
      .catch((e: unknown) => {
        if (latestCodeRef.current === code) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (latestCodeRef.current === code) setDetailLoading(false);
      });
  }

  async function ingest(): Promise<void> {
    if (!selected) return;
    setIngestBusy(true);
    setIngestError(null);
    setIngestResult(null);
    try {
      const r = await apiFetch(`/api/osint/countries/${selected}/ingest`, { method: 'POST' });
      if (!r.ok) {
        const detailText = await r.text();
        setIngestError(
          r.status === 401 ? 'Sign in to persist' : `${r.status}: ${detailText.slice(0, 200)}`,
        );
        return;
      }
      const res = (await r.json()) as IngestResult;
      setIngestResult(res);
      // Centre the graph on the new root AND select it, exactly like InvestigatePanel.
      useSelection.getState().select(res.root);
      useInvestigation.getState().searchAround(res.root);
    } catch (e) {
      setIngestError(String(e));
    } finally {
      setIngestBusy(false);
    }
  }

  function toggleRegion(region: string): void {
    setCollapsedRegions((s) => ({ ...s, [region]: !s[region] }));
  }

  // Country list grouped by region — filtered by the free-text box against
  // name/code (client-side, per spec §Frontend).
  const grouped = useMemo(() => {
    if (!list) return [] as [string, CountrySummary[]][];
    const q = filter.trim().toLowerCase();
    const byRegion = new Map<string, CountrySummary[]>();
    for (const c of list.countries) {
      if (q && !c.name.toLowerCase().includes(q) && !c.code.toLowerCase().includes(q)) continue;
      const arr = byRegion.get(c.region) ?? [];
      arr.push(c);
      byRegion.set(c.region, arr);
    }
    return [...byRegion.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list, filter]);

  // Selected country's resources grouped by category — filtered by the same
  // free-text box (over name/note) plus the category dropdown.
  const resourcesByCategory = useMemo(() => {
    if (!detail) return [] as [string, CountryResource[]][];
    const q = filter.trim().toLowerCase();
    const byCat = new Map<string, CountryResource[]>();
    for (const res of detail.resources) {
      if (categoryFilter && res.category !== categoryFilter) continue;
      if (q && !res.name.toLowerCase().includes(q) && !(res.note ?? '').toLowerCase().includes(q)) continue;
      const arr = byCat.get(res.category) ?? [];
      arr.push(res);
      byCat.set(res.category, arr);
    }
    return [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [detail, filter, categoryFilter]);

  const detailCategories = useMemo(
    () => (detail ? [...new Set(detail.resources.map((r) => r.category))].sort() : []),
    [detail],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontSize: 13, height: '100%', minHeight: 0 }}>
      <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>Countries</div>
      <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
        {list
          ? `${list.count} country toolkits: open-data, registries, court/legal, sanctions, and more.`
          : listError
            ? 'Failed to load catalog.'
            : 'Loading catalog…'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          placeholder="Filter countries / resources…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ ...inputStyle, flex: '1 1 140px' }}
        />
        {detail && (
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={inputStyle}>
            <option value="">All categories</option>
            {detailCategories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        )}
      </div>
      {listError && <div style={{ fontSize: 11, color: 'var(--alert)' }}>{listError}</div>}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8 }}>
        {!selected && (
          <div style={{ flex: '1 1 auto', overflow: 'auto' }}>
          {grouped.map(([region, countries]) => (
            <div key={region} style={{ marginBottom: 4 }}>
              <button type="button" onClick={() => toggleRegion(region)} style={sectionBtnStyle}>
                <span>
                  {collapsedRegions[region] ? '▸' : '▾'} {region}
                </span>
                <span style={{ color: 'var(--txt-3)' }}>{countries.length}</span>
              </button>
              {!collapsedRegions[region] &&
                countries.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => selectCountry(c.code)}
                    style={{
                      ...rowBtnStyle,
                      background: selected === c.code ? 'rgba(59,130,246,0.15)' : 'transparent',
                    }}
                  >
                    <span>
                      {flagEmoji(c.iso2)} {c.name}
                    </span>
                    <span style={{ color: 'var(--txt-3)', fontSize: 11 }}>{c.resource_count}</span>
                  </button>
                ))}
            </div>
          ))}
          </div>
        )}
        {selected && (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{ ...btnStyle, marginBottom: 6 }}
            >
              ← All countries
            </button>
            {detailLoading && <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>Loading…</div>}
            {detailError && <div style={{ fontSize: 11, color: 'var(--alert)' }}>{detailError}</div>}
            {detail && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6 }}>
                  <div style={{ fontWeight: 600 }}>
                    {flagEmoji(detail.iso2)} {detail.name}
                  </div>
                  <button disabled={ingestBusy} onClick={() => void ingest()} style={btnStyle}>
                    {ingestBusy ? '…' : 'Ingest'}
                  </button>
                </div>
                {ingestError && <div style={{ fontSize: 11, color: 'var(--alert)' }}>{ingestError}</div>}
                {ingestResult && (
                  <div style={{ fontSize: 11, color: 'var(--txt-2)', marginBottom: 6 }}>
                    {ingestResult.objects} objects · {ingestResult.links} links minted into the graph.
                  </div>
                )}
                {resourcesByCategory.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>No resources match.</div>
                )}
                {resourcesByCategory.map(([category, resources]) => (
                  <div key={category} style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--txt-3)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                        marginBottom: 2,
                      }}
                    >
                      {category}
                    </div>
                    {resources.map((res) => (
                      <div key={res.url} style={{ fontSize: 12, padding: '3px 0' }}>
                        <a href={res.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--txt-1)' }}>
                          {res.name}
                        </a>
                        {res.note && <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>{res.note}</div>}
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  color: 'inherit',
  colorScheme: 'dark',
  padding: '4px 6px',
};

const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 4,
  color: 'inherit',
  padding: '5px 10px',
  cursor: 'pointer',
};

const sectionBtnStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
  background: 'transparent',
  border: 'none',
  color: 'var(--txt-2)',
  fontSize: 11,
  fontWeight: 600,
  padding: '4px 2px',
  cursor: 'pointer',
  textAlign: 'left',
};

const rowBtnStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  width: '100%',
  border: 'none',
  borderRadius: 4,
  color: 'inherit',
  fontSize: 12,
  padding: '4px 6px',
  cursor: 'pointer',
  textAlign: 'left',
};
