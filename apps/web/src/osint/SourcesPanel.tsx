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

/** One row of the backend's measured upstream health (GET /api/status/sources).
 *  `state` is measured, never inferred from configuration: 'unknown' means the
 *  host has not been called this process and is NOT a synonym for healthy. */
interface SourceHealth {
  host: string;
  state: 'ok' | 'failing' | 'unknown';
  ok: number;
  fail: number;
  latency_ms: number | null;
  last_error: string | null;
  success_age_s: number | null;
}

interface SourcesHealthResponse {
  sources: SourceHealth[];
  counts: { total?: number; ok?: number; failing?: number; unknown?: number };
  unmeasured: { where: string; what: string }[];
}

/** The host a catalog row talks to, or null when the row names no URL.
 *  Matching on host is what lets a catalog written by hand line up with a
 *  registry keyed by what was actually called. */
export function hostOf(source: { url_pattern?: string; route?: string }): string | null {
  const raw = source.url_pattern ?? '';
  const m = /^https?:\/\/([^/?#]+)/i.exec(raw);
  return m?.[1]?.toLowerCase() ?? null;
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
  /** Literal, or `@now` / `@now-<seconds>` for an epoch-seconds default.
   *  ponytail: two tokens, not a expression language. The only routes that
   *  need one are the time-window diffs, and a literal epoch there ships a
   *  default that 422s the day after it is written. */
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
  // The 2026-08-08 sweep: `routeCoverage.test.ts` walks every @router decorator
  // in apps/api and demands each route be a layer, a caller in the web source,
  // a row here, or a stated exception. These groups are what that sweep turned
  // up. The analytics ones are scoped by a centre and a radius rather than a
  // bbox because that is the argument an operator can actually type.
  {
    group: 'Area analytics',
    items: [
      {
        id: 'intel-situation',
        label: 'Global situation',
        hint: 'The cheap orienting summary: what is up, at sea, and burning right now.',
        path: '/api/intel/situation',
      },
      {
        id: 'intel-area',
        label: 'Area intel bundle',
        hint: 'Everything known inside a radius, in one call. Set primary=true to also load the area for the background loops.',
        path: '/api/intel/area',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '200', initial: '200' },
          { name: 'primary', label: 'Primary', placeholder: 'false', initial: 'false' },
        ],
      },
      {
        id: 'intel-density',
        label: 'Traffic density grid',
        hint: 'Contacts per cell across the scope. The baseline every anomaly is measured against.',
        path: '/api/intel/density',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '200', initial: '200' },
          { name: 'cell_deg', label: 'Cell deg', placeholder: '1.0', initial: '1.0' },
        ],
      },
      {
        id: 'intel-jamming',
        label: 'GNSS interference',
        hint: 'Aircraft reporting degraded navigation integrity, clustered.',
        path: '/api/intel/jamming',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '32.0', initial: '32.0' },
          { name: 'lon', label: 'Lon', placeholder: '35.0', initial: '35.0' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
        ],
      },
      {
        id: 'intel-anomalies',
        label: 'Anomalies',
        hint: 'Contacts behaving unlike their own baseline: squawks, altitude, gaps.',
        path: '/api/intel/anomalies',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
        ],
      },
      {
        id: 'intel-deception',
        label: 'Deception indicators',
        hint: 'Identity and position claims that do not survive cross-checking.',
        path: '/api/intel/deception',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
        ],
      },
      {
        id: 'intel-emitter',
        label: 'Emitter picture',
        hint: 'What is transmitting in the scope, by domain and tier.',
        path: '/api/intel/emitter',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
        ],
      },
      {
        id: 'intel-baseline',
        label: 'Pattern baseline',
        hint: 'The normal state of the scope, so a departure from it can be named.',
        path: '/api/intel/baseline',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
        ],
      },
      {
        id: 'intel-incident-history',
        label: 'Incident history',
        hint: 'Fused incidents in the scope over a trailing window, not just the current pull.',
        path: '/api/intel/incident-history',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
          { name: 'hours', label: 'Hours', placeholder: '6', initial: '6' },
        ],
      },
      {
        id: 'intel-aircraft-query',
        label: 'Aircraft query',
        hint: 'Filter the live aircraft store by scope, squawk, altitude or callsign fragment.',
        path: '/api/intel/aircraft',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '200', initial: '200' },
          { name: 'callsign_contains', label: 'Callsign has', placeholder: 'RCH', initial: '' },
          { name: 'limit', label: 'Limit', placeholder: '50', initial: '50' },
        ],
      },
      {
        id: 'intel-aircraft-lookup',
        label: 'Aircraft lookup',
        hint: 'One airframe by hex, registration or callsign, with what the store knows about it.',
        path: '/api/intel/aircraft/{ident}',
        args: [{ name: 'ident', label: 'Ident', placeholder: 'RCH123', initial: 'RCH123' }],
      },
      {
        id: 'intel-vessels',
        label: 'Vessel query',
        hint: 'Vessels in the scope. dark_only=true keeps the ones that stopped reporting.',
        path: '/api/intel/vessels',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '500', initial: '500' },
          { name: 'dark_only', label: 'Dark only', placeholder: 'false', initial: 'false' },
          { name: 'limit', label: 'Limit', placeholder: '50', initial: '50' },
        ],
      },
      {
        id: 'intel-aois',
        label: 'Loaded priority areas',
        hint: 'Which areas are currently held PRIMARY by the background loops.',
        path: '/api/intel/aois',
      },
    ],
  },
  {
    group: 'Routing and reach',
    items: [
      {
        id: 'route-road',
        label: 'Road route · OSRM',
        hint: 'Driving, walking or cycling geometry between two points.',
        path: '/api/route/road',
        args: [
          { name: 'from_lat', label: 'From lat', placeholder: '50.45', initial: '50.45' },
          { name: 'from_lon', label: 'From lon', placeholder: '30.52', initial: '30.52' },
          { name: 'to_lat', label: 'To lat', placeholder: '49.99', initial: '49.99' },
          { name: 'to_lon', label: 'To lon', placeholder: '36.23', initial: '36.23' },
          { name: 'mode', label: 'Mode', placeholder: 'driving', initial: 'driving' },
        ],
      },
      {
        id: 'route-offroad',
        label: 'Off-road route',
        hint: 'A path that does not assume a road network exists.',
        path: '/api/route/offroad',
        args: [
          { name: 'from_lat', label: 'From lat', placeholder: '50.45', initial: '50.45' },
          { name: 'from_lon', label: 'From lon', placeholder: '30.52', initial: '30.52' },
          { name: 'to_lat', label: 'To lat', placeholder: '49.99', initial: '49.99' },
          { name: 'to_lon', label: 'To lon', placeholder: '36.23', initial: '36.23' },
        ],
      },
      {
        id: 'route-fastest',
        label: 'Fastest route',
        hint: 'The quickest of the available modes for the pair.',
        path: '/api/route/fastest',
        args: [
          { name: 'from_lat', label: 'From lat', placeholder: '50.45', initial: '50.45' },
          { name: 'from_lon', label: 'From lon', placeholder: '30.52', initial: '30.52' },
          { name: 'to_lat', label: 'To lat', placeholder: '49.99', initial: '49.99' },
          { name: 'to_lon', label: 'To lon', placeholder: '36.23', initial: '36.23' },
        ],
      },
      {
        id: 'route-candidates',
        label: 'Route candidates',
        hint: 'Every mode side by side, so the choice is visible rather than assumed.',
        path: '/api/route/candidates',
        args: [
          { name: 'from_lat', label: 'From lat', placeholder: '50.45', initial: '50.45' },
          { name: 'from_lon', label: 'From lon', placeholder: '30.52', initial: '30.52' },
          { name: 'to_lat', label: 'To lat', placeholder: '49.99', initial: '49.99' },
          { name: 'to_lon', label: 'To lon', placeholder: '36.23', initial: '36.23' },
        ],
      },
    ],
  },
  {
    group: 'Detection and imagery',
    items: [
      {
        id: 'sar-sweep',
        label: 'SAR vessel sweep · latest',
        hint: 'The scheduled Sentinel-1 sweep across chokepoint areas, one summary per area. Empty until the first post-boot sweep finishes.',
        path: '/api/intel/sar/sweep',
      },
      {
        id: 'sar-sweep-aoi',
        label: 'SAR vessel sweep · one area',
        hint: 'Full detection GeoJSON for one swept area. Ask the summary above for the area names.',
        path: '/api/intel/sar/sweep/{aoi}',
        args: [{ name: 'aoi', label: 'Area', placeholder: 'hormuz', initial: 'hormuz' }],
      },
      {
        id: 'imagery-aoi',
        label: 'Imagery availability',
        hint: 'Which scenes exist over a point either side of a date, across the wired providers.',
        path: '/api/imagery/aoi',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '26.5', initial: '26.5' },
          { name: 'lon', label: 'Lon', placeholder: '56.5', initial: '56.5' },
          { name: 'radius_km', label: 'Radius km', placeholder: '5', initial: '5' },
          { name: 'before', label: 'Before', placeholder: '2026-01-01', initial: '2026-01-01' },
          { name: 'after', label: 'After', placeholder: '2026-06-01', initial: '2026-06-01' },
        ],
      },
      {
        id: 'imagery-tasking-providers',
        label: 'Tasking providers',
        hint: 'Which commercial collectors are configured, and what each will accept.',
        path: '/api/imagery/tasking/providers',
      },
    ],
  },
  {
    group: 'Records and history',
    items: [
      {
        id: 'history-diff',
        label: 'Movement diff',
        hint: 'What changed inside a box between two moments. Arrived, departed, still there.',
        path: '/api/history/diff',
        args: [
          { name: 'lamin', label: 'Lat min', placeholder: '24', initial: '24' },
          { name: 'lomin', label: 'Lon min', placeholder: '54', initial: '54' },
          { name: 'lamax', label: 'Lat max', placeholder: '28', initial: '28' },
          { name: 'lomax', label: 'Lon max', placeholder: '58', initial: '58' },
          { name: 'at_a', label: 'Earlier', placeholder: 'epoch s', initial: '@now-3600' },
          { name: 'at_b', label: 'Later', placeholder: 'epoch s', initial: '@now' },
          { name: 'window_sec', label: 'Window s', placeholder: '600', initial: '600' },
        ],
      },
      {
        id: 'news-history',
        label: 'Past editions · news',
        hint: 'Earlier generated editions and briefs, newest first.',
        path: '/api/news/history',
        args: [
          { name: 'kind', label: 'Kind', placeholder: 'edition', initial: 'edition' },
          { name: 'limit', label: 'Limit', placeholder: '20', initial: '20' },
        ],
      },
      {
        id: 'ontology-assertions',
        label: 'Assertion history · ontology',
        hint: 'The evidenced property history of one object, newest first.',
        path: '/api/ontology/assertions/{object_id}',
        args: [
          { name: 'object_id', label: 'Object id', placeholder: 'aircraft:a835af', initial: '' },
          { name: 'limit', label: 'Limit', placeholder: '200', initial: '50' },
        ],
      },
      {
        id: 'ontology-analytics',
        label: 'Link metrics · ontology',
        hint: 'Centrality and neighbourhood metrics around one object.',
        path: '/api/ontology/analytics/{object_id}',
        args: [
          { name: 'object_id', label: 'Object id', placeholder: 'aircraft:a835af', initial: '' },
          { name: 'depth', label: 'Depth', placeholder: '2', initial: '2' },
        ],
      },
      {
        id: 'audit',
        label: 'Audit log',
        hint: 'What this deployment recorded itself doing.',
        path: '/api/audit',
        args: [{ name: 'limit', label: 'Limit', placeholder: '200', initial: '50' }],
      },
      {
        id: 'export',
        label: 'Export live store',
        hint: 'The current contacts as GeoJSON, CSV or KML. Returns a file body, shown here as text.',
        path: '/api/export',
        args: [
          { name: 'fmt', label: 'Format', placeholder: 'geojson', initial: 'geojson' },
          { name: 'kinds', label: 'Kinds', placeholder: 'aircraft', initial: 'aircraft' },
          { name: 'limit', label: 'Limit', placeholder: '100', initial: '100' },
        ],
      },
    ],
  },
  {
    group: 'Live feeds and reference',
    items: [
      {
        id: 'acars-geojson',
        label: 'ACARS positions',
        hint: 'Position-bearing ACARS traffic. The same body the globe layer reads.',
        path: '/api/acars/geojson',
        args: [{ name: 'limit', label: 'Limit', placeholder: '100', initial: '50' }],
      },
      {
        id: 'acars-stats',
        label: 'ACARS coverage',
        hint: 'Station and mode counts from airframes.io, the live measure of reach.',
        path: '/api/acars/stats',
      },
      {
        id: 'adsb-squawk',
        label: 'Aircraft by squawk',
        hint: 'Everything currently squawking a four-digit code. 7700, 7600, 7500 are the interesting ones.',
        path: '/api/adsb/live/squawk/{code}',
        args: [{ name: 'code', label: 'Squawk', placeholder: '7700', initial: '7700' }],
      },
      {
        id: 'adsb-lol-point',
        label: 'Aircraft near a point · adsb.lol',
        hint: 'One upstream tier on its own, useful when a tier is suspected of drifting.',
        path: '/api/adsb/lol/point',
        args: [
          { name: 'lat', label: 'Lat', placeholder: '51.5', initial: '51.5' },
          { name: 'lon', label: 'Lon', placeholder: '-0.1', initial: '-0.1' },
          { name: 'radius_nm', label: 'Radius nm', placeholder: '100', initial: '100' },
        ],
      },
      {
        id: 'places-facility',
        label: 'Facility record',
        hint: 'The full stored row behind one infrastructure or military facility id.',
        path: '/api/places/facility/{fid}',
        args: [
          { name: 'fid', label: 'Facility id', placeholder: 'GEODB0040538', initial: 'GEODB0040538' },
        ],
      },
      {
        id: 'sanctions-summary',
        label: 'Sanctions list summary',
        hint: 'Which list is loaded, how big it is, and what it can be joined on.',
        path: '/api/sanctions/summary',
      },
      {
        id: 'cloudflare-outages',
        label: 'Internet outages · Cloudflare Radar',
        hint: 'Reported national and regional connectivity disruptions.',
        path: '/api/cyber/cloudflare/outages',
        args: [{ name: 'range_days', label: 'Days', placeholder: '7', initial: '7' }],
      },
      {
        id: 'swpc-kp',
        label: 'Planetary K index · NOAA SWPC',
        hint: 'Geomagnetic activity, one-minute series. High Kp degrades HF and GNSS.',
        path: '/api/weather/swpc/kp',
      },
      {
        id: 'country-indicators',
        label: 'Indicator manifest',
        hint: 'The curated World Bank and UN series ids the Country app renders.',
        path: '/api/country/indicators',
      },
      {
        id: 'countries-categories',
        label: 'National source categories',
        hint: 'How the per-country OSINT catalogue is grouped, with counts.',
        path: '/api/osint/countries/categories',
      },
    ],
  },
  {
    group: 'System and provenance',
    items: [
      {
        id: 'intel-sources',
        label: 'Feed health',
        hint: 'Which feeds are always-on and which are key-gated, with the authed tiers actually probed.',
        path: '/api/intel/sources',
      },
      {
        id: 'status-provenance',
        label: 'Who saw the sky',
        hint: 'Per tier: how many contacts it saw, and how many only it saw. The exclusive column is the honest one.',
        path: '/api/status/provenance',
      },
      {
        id: 'status-perf',
        label: 'Backend timing',
        hint: 'Event-loop lag, blob age and per-tier cycle times. Where a stale layer is attributed.',
        path: '/api/status/perf',
      },
      {
        id: 'adsb-snapshot-age',
        label: 'Snapshot age',
        hint: 'Seconds since the last accepted world snapshot, against the freshness budget.',
        path: '/api/adsb/snapshot_age',
      },
      {
        id: 'health-memory',
        label: 'Memory budgets',
        hint: 'Available RAM and the per-cache byte budgets resolved from it.',
        path: '/api/health/memory',
      },
    ],
  },
];

/** `@now` / `@now-<seconds>` resolve against the clock at render time. */
function resolveInitial(initial: string): string {
  if (!initial.startsWith('@now')) return initial;
  const offset = Number(initial.slice(4) || 0);
  return String(Math.floor(Date.now() / 1000) + (Number.isFinite(offset) ? offset : 0));
}

// Every single-source connector behind the Investigate fan-out, with the query
// key it takes. The fan-out (POST /api/osint/investigate) runs the ones that
// apply to a target and mints the result into the ontology; this row runs ONE
// of them raw, which is what you want when you are checking a single claim
// rather than opening a case.
const OSINT_CONNECTORS: readonly (readonly [path: string, key: string])[] = [
  ['/api/osint/dns', 'target'],
  ['/api/osint/whois', 'target'],
  ['/api/osint/certs', 'target'],
  ['/api/osint/certspotter', 'target'],
  ['/api/osint/columbus', 'target'],
  ['/api/osint/anubis', 'target'],
  ['/api/osint/hackertarget', 'target'],
  ['/api/osint/urlscan', 'target'],
  ['/api/osint/wayback', 'target'],
  ['/api/osint/ip', 'target'],
  ['/api/osint/shodan', 'target'],
  ['/api/osint/threat', 'target'],
  ['/api/osint/bgpview-ip', 'ip'],
  ['/api/osint/bgpview-asn', 'asn'],
  ['/api/osint/ripestat', 'ip'],
  ['/api/osint/greynoise', 'ip'],
  ['/api/osint/onionoo', 'ip'],
  ['/api/osint/feodo', 'ip'],
  ['/api/osint/urlhaus-host', 'target'],
  ['/api/osint/urlhaus-url', 'target'],
  ['/api/osint/malwarebazaar', 'hash'],
  ['/api/osint/yaraify', 'hash'],
  ['/api/osint/emailrep', 'target'],
  ['/api/osint/phishstats', 'target'],
  ['/api/osint/hibp', 'target'],
  ['/api/osint/username', 'target'],
  ['/api/osint/github', 'target'],
  ['/api/osint/gitlab', 'target'],
  ['/api/osint/gravatar', 'target'],
  ['/api/osint/libravatar', 'target'],
  ['/api/osint/pullpush', 'target'],
  ['/api/osint/mempool', 'address'],
  ['/api/osint/blockstream', 'address'],
  ['/api/osint/blockscout', 'address'],
  ['/api/osint/blockchair', 'chain'],
  ['/api/osint/sec-edgar', 'name'],
  ['/api/osint/opensanctions', 'name'],
  ['/api/osint/opencorporates', 'name'],
  ['/api/osint/openownership', 'name'],
  ['/api/osint/aleph', 'name'],
  ['/api/osint/wikidata', 'name'],
];

function ConnectorRow(): JSX.Element {
  const [path, setPath] = useState<string>('/api/osint/dns');
  const [value, setValue] = useState<string>('example.com');
  // blockchair takes chain AND address; rather than model per-connector arg
  // lists for one outlier, the extra field appends verbatim.
  const [extra, setExtra] = useState<string>('');
  const [state, setState] = useState<'idle' | 'running'>('idle');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = OSINT_CONNECTORS.find(([p]) => p === path)?.[1] ?? 'target';
  const url =
    `${path}?${encodeURIComponent(key)}=${encodeURIComponent(value)}` +
    (extra.trim() === '' ? '' : `&${extra.trim().replace(/^&/, '')}`);

  async function run(): Promise<void> {
    setState('running');
    setError(null);
    try {
      const res = await apiFetch(url);
      if (!res.ok) {
        setError(`Connector unavailable (HTTP ${res.status})`);
        setResult(null);
      } else {
        setResult(JSON.stringify(await res.json(), null, 2));
      }
    } catch {
      setError('Connector unavailable (no response)');
      setResult(null);
    }
    setState('idle');
  }

  return (
    <div className="border-b border-line-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <div className="text-[12px] text-txt-0">Single connector</div>
          <div className="text-[11px] text-txt-3">
            One source on its own, unmined. Investigate runs the whole fan-out and keeps the
            result; this answers one question and keeps nothing.
          </div>
        </div>
        <select
          className="mono rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[11px] text-txt-0"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          aria-label="Connector"
        >
          {OSINT_CONNECTORS.map(([p]) => (
            <option key={p} value={p}>
              {p.replace('/api/osint/', '')}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-txt-3">
          {key}
          <input
            className="mono w-[150px] rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[11px] text-txt-0"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-txt-3">
          extra
          <input
            className="mono w-[130px] rounded border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[11px] text-txt-0"
            value={extra}
            placeholder="address=bc1…"
            onChange={(e) => setExtra(e.target.value)}
          />
        </label>
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

function buildUrl(l: Lookup, values: Record<string, string>): string {
  let path = l.path;
  const query: string[] = [];
  for (const a of l.args ?? []) {
    const v = (values[`${l.id}.${a.name}`] ?? resolveInitial(a.initial)).trim();
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
        // /api/export answers CSV and KML as well as GeoJSON, so a hard
        // res.json() reported a working route as "no response".
        const text = await res.text();
        try {
          setResult(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          setResult(text);
        }
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
              value={values[`${lookup.id}.${a.name}`] ?? resolveInitial(a.initial)}
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

/** Measured state for one catalog row.
 *
 *  A source with no row has not been called this session. That is reported as
 *  "not called", never as healthy: treating never-attempted as green is the
 *  exact defect /api/status carried for two hardcoded feeds. */
function SourceState({ row }: { row: SourceHealth | null }): JSX.Element {
  if (row === null) {
    return <span className="text-[10px] text-txt-3">not called</span>;
  }
  const tone =
    row.state === 'ok' ? 'text-ok' : row.state === 'failing' ? 'text-alert' : 'text-txt-3';
  const detail =
    row.state === 'failing'
      ? (row.last_error ?? 'failing')
      : row.state === 'ok'
        ? `${row.success_age_s === null ? '—' : `${Math.round(row.success_age_s)}s ago`}` +
          `${row.latency_ms === null ? '' : ` · ${Math.round(row.latency_ms)}ms`}`
        : 'not called';
  return (
    <span className={`text-[10px] ${tone}`} title={`${row.ok} ok · ${row.fail} failed`}>
      {row.state} · {detail}
    </span>
  );
}

export function SourcesPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [health, setHealth] = useState<SourcesHealthResponse | null>(null);
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

  // Measured health, alongside the catalog. The catalog says what EXISTS; this
  // says what answered. Best effort: the panel is still useful without it.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/status/sources');
        if (!res.ok) return;
        const json = (await res.json()) as SourcesHealthResponse;
        if (live) setHealth(json);
      } catch {
        /* the status column simply reads "—" */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const byHost = useMemo(() => {
    const m = new Map<string, SourceHealth>();
    for (const r of health?.sources ?? []) m.set(r.host.toLowerCase(), r);
    return m;
  }, [health]);

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
          Backend routes that answer a question rather than plot a position: feeds, analytics
          over a scope, routing, records and system provenance. Everything that returns a layer
          of coordinates is on the globe instead, in the Layers panel.
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

        <section>
          <div className="bg-bg-2 px-3 py-1 text-[11px] uppercase tracking-[0.8px] text-txt-2">
            Digital OSINT connectors
          </div>
          <ConnectorRow />
        </section>

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
          <div className="mt-1 text-[11px] text-txt-3">
            {health
              ? `Measured this session · ${health.counts.ok ?? 0} answering · ` +
                `${health.counts.failing ?? 0} failing · ${health.unmeasured.length} ` +
                'upstreams build their own client and are not measured here'
              : 'Measured health unavailable'}
          </div>
        </div>
        {shown.map((s) => (
          <div key={s.id} className="border-b border-line-2 px-3 py-1.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[12px] text-txt-0">{s.name}</span>
              <span className="mono text-[10px] text-txt-3">{s.category}</span>
              <span className="text-[10px] text-txt-3">{s.auth ? `auth: ${s.auth}` : 'auth: —'}</span>
              <SourceState row={byHost.get(hostOf(s) ?? '') ?? null} />
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
