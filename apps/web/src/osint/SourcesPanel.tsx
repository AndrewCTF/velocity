// Sources panel — the address for every backend feed that is NOT a map layer.
//
// The 2026-08-06 mega-ledger wave added two kinds of route: feeds that return a
// FeatureCollection (those are registered layers and belong on the globe) and
// feeds that answer a QUESTION — a LEI, a docket, a channel, a manifest. The
// second kind has no position, so it has no home on the map, and until this
// panel existed it had no home in the product either.
//
// Deliberately one generic runner rather than eighteen bespoke views: each
// lookup states its route and its arguments, runs it, and shows what came back.
// A source that earns a real reading (a table, a chart, a map pin) graduates out
// of this list to the surface that reads it. This is the directory, not the end
// state.

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../transport/http.js';

interface CatalogSource {
  id: string;
  category: string;
  name: string;
  url_pattern?: string;
  auth?: string;
  note?: string;
  route?: string;
  resolution?: string;
  format?: string;
}

interface CatalogResponse {
  total: number;
  categories: string[];
  sources: CatalogSource[];
}

interface LookupArg {
  /** Query-string key, or `:path` when the value is part of the route. */
  readonly name: string;
  readonly label: string;
  readonly placeholder: string;
  readonly initial: string;
}

interface Lookup {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** `{arg}` is substituted from the matching arg value. */
  readonly path: string;
  readonly args?: readonly LookupArg[];
}

// Every non-geo route from the mega-ledger wave, grouped by what it answers.
const LOOKUPS: readonly { readonly group: string; readonly items: readonly Lookup[] }[] = [
  {
    group: 'Threat and cyber',
    items: [
      {
        id: 'kev',
        label: 'Exploited vulnerabilities · CISA KEV',
        hint: 'The catalogue of CVEs known to be exploited in the wild.',
        path: '/api/cyber/kev',
      },
      {
        id: 'shodan',
        label: 'Host exposure · Shodan (keyless)',
        hint: 'What an address answers on, as Shodan last saw it.',
        path: '/api/cyber/shodan/{ip}',
        args: [{ name: 'ip', label: 'IPv4', placeholder: '8.8.8.8', initial: '8.8.8.8' }],
      },
    ],
  },
  {
    group: 'Corporate and legal',
    items: [
      {
        id: 'gleif',
        label: 'Legal entities · GLEIF LEI',
        hint: 'The registered name, address and parent behind an LEI.',
        path: '/api/legal/gleif',
        args: [{ name: 'q', label: 'Search', placeholder: 'Sovcomflot', initial: 'Sovcomflot' }],
      },
      {
        id: 'courtlistener',
        label: 'Case law · CourtListener',
        hint: 'US federal and state dockets and opinions.',
        path: '/api/legal/courtlistener',
        args: [{ name: 'q', label: 'Search', placeholder: 'export control', initial: 'sanctions' }],
      },
    ],
  },
  {
    group: 'Humanitarian and population',
    items: [
      {
        id: 'unhcr',
        label: 'Displacement · UNHCR',
        hint: 'Refugee and asylum populations by country of origin and asylum.',
        path: '/api/displacement/unhcr',
        args: [{ name: 'year', label: 'Year', placeholder: '2024', initial: '2024' }],
      },
      {
        id: 'worldpop',
        label: 'Population grids · WorldPop',
        hint: 'The published raster products for a country.',
        path: '/api/population/worldpop',
        args: [{ name: 'iso3', label: 'ISO3', placeholder: 'UKR', initial: 'UKR' }],
      },
      {
        id: 'hdx',
        label: 'Datasets · HDX',
        hint: 'OCHA Humanitarian Data Exchange package search.',
        path: '/api/humanitarian/hdx',
        args: [{ name: 'q', label: 'Search', placeholder: 'ukraine', initial: 'ukraine' }],
      },
    ],
  },
  {
    group: 'News and events',
    items: [
      {
        id: 'telegram',
        label: 'Channel posts · Telegram',
        hint: 'Public channel previews. Claim tier: a post is somebody asserting something.',
        path: '/api/news/telegram',
        args: [
          { name: 'channel', label: 'Channel', placeholder: 'intelslava', initial: 'intelslava' },
          { name: 'limit', label: 'Limit', placeholder: '20', initial: '20' },
        ],
      },
      {
        id: 'meteoalarm',
        label: 'Civil warnings · Meteoalarm (EU)',
        hint: 'CAP warnings by country. They carry a NUTS3 region, not a position.',
        path: '/api/alerts/meteoalarm',
        args: [{ name: 'country', label: 'Country', placeholder: 'france', initial: 'france' }],
      },
      {
        id: 'gdelt-doc',
        label: 'Article search · GDELT DOC',
        hint: 'Worldwide coverage of a query across monitored media.',
        path: '/api/events/gdelt-doc',
        args: [{ name: 'q', label: 'Query', placeholder: 'conflict', initial: 'conflict' }],
      },
      {
        id: 'gdelt-summary',
        label: 'Coverage summary · GDELT',
        hint: 'Volume and tone of a query over time.',
        path: '/api/events/gdelt-summary',
        args: [{ name: 'q', label: 'Query', placeholder: 'conflict', initial: 'conflict' }],
      },
    ],
  },
  {
    group: 'Aviation and space',
    items: [
      {
        id: 'adsb-hex',
        label: 'Airframe by ICAO hex',
        hint: 'The live contact behind a 24-bit address.',
        path: '/api/adsb/hex/{icao}',
        args: [{ name: 'icao', label: 'Hex', placeholder: 'a835af', initial: 'a835af' }],
      },
      {
        id: 'adsb-reg',
        label: 'Airframe by registration',
        hint: 'Tail number to live contact.',
        path: '/api/adsb/registration/{reg}',
        args: [{ name: 'reg', label: 'Reg', placeholder: 'N628TS', initial: 'N628TS' }],
      },
      {
        id: 'adsb-callsign',
        label: 'Airframe by callsign',
        hint: 'The flight currently squawking a callsign.',
        path: '/api/adsb/callsign/{cs}',
        args: [{ name: 'cs', label: 'Callsign', placeholder: 'RCH123', initial: 'RCH123' }],
      },
      {
        id: 'adsb-type',
        label: 'Airframes by ICAO type',
        hint: 'Every airborne example of a type right now.',
        path: '/api/adsb/type/{type_code}',
        args: [{ name: 'type_code', label: 'Type', placeholder: 'C17', initial: 'C17' }],
      },
      {
        id: 'adsb-history',
        label: 'Replay coverage · adsb.lol',
        hint: 'Which historical days the upstream archive holds.',
        path: '/api/adsb/history/dates',
      },
      {
        id: 'aviation-routes',
        label: 'Airline routes · OpenFlights',
        hint: 'Published origin-destination pairs by airline.',
        path: '/api/aviation/routes',
      },
      {
        id: 'fr24',
        label: 'Flight search · FR24',
        hint: 'Resolve a callsign, registration or route.',
        path: '/api/adsb/fr24/search',
        args: [{ name: 'q', label: 'Query', placeholder: 'RCH', initial: 'RCH' }],
      },
      {
        id: 'satnogs-tx',
        label: 'Transmitters · SatNOGS',
        hint: 'Downlink frequencies and modes, optionally for one NORAD id.',
        path: '/api/space/satnogs/transmitters',
        args: [{ name: 'satellite', label: 'NORAD id', placeholder: '25544', initial: '25544' }],
      },
      {
        id: 'tinygs',
        label: 'LoRa packets · tinyGS',
        hint: 'Recent amateur ground-station receptions.',
        path: '/api/space/tinygs',
      },
    ],
  },
  {
    group: 'Imagery and terrain',
    items: [
      {
        id: 'wayback',
        label: 'Imagery history · ESRI Wayback',
        hint: 'Every published version of ESRI World Imagery back to 2014.',
        path: '/api/imagery/wayback',
      },
      {
        id: 'buildings-ms',
        label: 'Building footprints · Microsoft',
        hint: '1.3 billion footprints, one GeoJSONL file per quadkey.',
        path: '/api/buildings/microsoft',
      },
      {
        id: 'buildings-overture',
        label: 'Building footprints · Overture',
        hint: 'GeoParquet on S3, queryable with DuckDB.',
        path: '/api/buildings/overture',
      },
      {
        id: 'splats',
        label: '3D scenes · Sketchfab',
        hint: 'Gaussian-splat and photogrammetry scenes for the City viewer.',
        path: '/api/splats/search',
        args: [{ name: 'q', label: 'Query', placeholder: 'city', initial: 'gaussian splat' }],
      },
      {
        id: 'splats-hf',
        label: '3D datasets · Hugging Face',
        hint: 'Splat datasets published as HF repos.',
        path: '/api/splats/huggingface',
        args: [{ name: 'q', label: 'Query', placeholder: 'splat', initial: 'gaussian splatting' }],
      },
    ],
  },
  {
    group: 'Reference and manifests',
    items: [
      {
        id: 'gpsjam',
        label: 'Jamming archive · GPSJam manifest',
        hint: 'Which daily interference tiles exist, back to 2022.',
        path: '/api/jamming/gpsjam-manifest',
      },
      {
        id: 'insecam',
        label: 'Camera directory · insecam',
        hint: 'Approximate public-webcam counts by country. Gray-area source.',
        path: '/api/cams/insecam',
      },
    ],
  },
];

function buildUrl(l: Lookup, values: Record<string, string>): string {
  let path = l.path;
  const query: string[] = [];
  for (const a of l.args ?? []) {
    const v = (values[`${l.id}.${a.name}`] ?? a.initial).trim();
    if (path.includes(`{${a.name}}`)) {
      path = path.replace(`{${a.name}}`, encodeURIComponent(v));
    } else if (v) {
      query.push(`${encodeURIComponent(a.name)}=${encodeURIComponent(v)}`);
    }
  }
  return query.length > 0 ? `${path}?${query.join('&')}` : path;
}

function LookupRow({
  lookup,
  values,
  setValue,
}: {
  lookup: Lookup;
  values: Record<string, string>;
  setValue: (k: string, v: string) => void;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = buildUrl(lookup, values);

  async function run(): Promise<void> {
    setState('running');
    setError(null);
    try {
      const res = await apiFetch(url);
      if (!res.ok) {
        setError(`${lookup.label} unavailable (HTTP ${res.status})`);
        setResult(null);
      } else {
        setResult(JSON.stringify(await res.json(), null, 2));
      }
    } catch {
      setError(`${lookup.label} unavailable (no response)`);
      setResult(null);
    }
    setState('idle');
  }

  return (
    <div className="border-b border-line-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <div className="text-[12px] text-txt-0">{lookup.label}</div>
          <div className="text-[11px] text-txt-3">{lookup.hint}</div>
        </div>
        {(lookup.args ?? []).map((a) => (
          <label key={a.name} className="flex items-center gap-1 text-[11px] text-txt-3">
            {a.label}
            <input
              className="mono w-[110px] rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[11px] text-txt-0"
              value={values[`${lookup.id}.${a.name}`] ?? a.initial}
              placeholder={a.placeholder}
              onChange={(e) => setValue(`${lookup.id}.${a.name}`, e.target.value)}
            />
          </label>
        ))}
        <button
          type="button"
          className="rounded border border-line-2 bg-bg-2 px-2 py-1 text-[11px] text-txt-0 hover:bg-bg-3"
          disabled={state === 'running'}
          onClick={() => void run()}
        >
          {state === 'running' ? 'running…' : 'Run'}
        </button>
      </div>
      <div className="mono mt-1 text-[10px] text-txt-3">{url}</div>
      {error !== null && <div className="mt-1 text-[11px] text-alert">{error}</div>}
      {result !== null && (
        <pre className="mono mt-1 max-h-[280px] overflow-auto rounded bg-bg-2 p-2 text-[11px] text-txt-1">
          {result}
        </pre>
      )}
    </div>
  );
}

export function SourcesPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/sources/catalog');
        if (!res.ok) {
          if (live) setCatalogError(`Source catalog unavailable (HTTP ${res.status})`);
          return;
        }
        const json = (await res.json()) as CatalogResponse;
        if (live) setCatalog(json);
      } catch {
        if (live) setCatalogError('Source catalog unavailable (no response)');
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(
    () =>
      (catalog?.sources ?? []).filter((s) => category === '' || s.category === category),
    [catalog, category],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line-2 px-3 py-2">
        <div className="text-[12px] uppercase tracking-[0.8px] text-txt-0">Lookups</div>
        <div className="text-[11px] text-txt-3">
          Backend feeds that answer a question rather than plot a position. Everything that
          carries coordinates is a map layer instead, in the Layers panel.
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {LOOKUPS.map((g) => (
          <section key={g.group}>
            <div className="bg-bg-2 px-3 py-1 text-[11px] uppercase tracking-[0.8px] text-txt-2">
              {g.group}
            </div>
            {g.items.map((l) => (
              <LookupRow
                key={l.id}
                lookup={l}
                values={values}
                setValue={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
              />
            ))}
          </section>
        ))}

        <div className="border-b border-t border-line-2 px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="text-[12px] uppercase tracking-[0.8px] text-txt-0">Source catalog</div>
            <span className="text-[11px] text-txt-3">
              {catalog ? `${shown.length} of ${catalog.total}` : '—'}
            </span>
            <select
              className="ml-auto rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[11px] text-txt-0"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {(catalog?.categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {catalogError !== null && (
            <div className="mt-1 text-[11px] text-alert">{catalogError}</div>
          )}
        </div>
        {shown.map((s) => (
          <div key={s.id} className="border-b border-line-2 px-3 py-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[12px] text-txt-0">{s.name}</span>
              <span className="mono text-[10px] text-txt-3">{s.category}</span>
              <span className="text-[10px] text-txt-3">{s.auth ? `auth: ${s.auth}` : 'auth: —'}</span>
            </div>
            <div className="mono truncate text-[10px] text-txt-3">
              {s.route ?? s.url_pattern ?? '—'}
            </div>
            {s.note !== undefined && s.note !== '' && (
              <div className="text-[11px] text-txt-2">{s.note}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
