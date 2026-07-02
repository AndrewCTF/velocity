// NormalSearchPanel — Palantir "Search for Objects" workspace (reference images 22/26).
// Left-docked panel: object-type facet + keyword + intrinsic date (static/rolling) +
// geographic AOI (draw a circle) + live-update → a results list that flies the camera and
// selects on click. Backed by the FACETED /api/search/objects endpoint (transport/searchObjects),
// which searches the whole live object store server-side (not the 10-result resolver) and
// returns per-type counts so the object-type dropdown shows live totals for the current
// AOI + window. Reuses globe/draw (circle), globe/camera, useSelection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { searchObjects, type ObjectResult } from '../transport/search.js';
import { getDrawController, haversineKm } from '../globe/draw.js';
import { flyToPosition } from '../globe/camera.js';
import { useSelection } from '../state/stores.js';
import { Icon } from './Icon.js';

export interface NormalSearchPanelProps {
  viewer: Cesium.Viewer | null;
  onClose: () => void;
}

// Object types = the store's emits_kind values (plus "all"). These are the real
// object classes the faceted endpoint can filter, unlike the resolver's
// place/chokepoint which aren't in the live store.
type Kind = 'all' | 'aircraft' | 'vessel' | 'quake' | 'fire' | 'satellite' | 'event' | 'outage';
const KINDS: { id: Kind; label: string }[] = [
  { id: 'all', label: 'All objects' },
  { id: 'aircraft', label: 'Aircraft' },
  { id: 'vessel', label: 'Vessels' },
  { id: 'quake', label: 'Earthquakes' },
  { id: 'fire', label: 'Fires' },
  { id: 'satellite', label: 'Satellites' },
  { id: 'event', label: 'Events' },
  { id: 'outage', label: 'Outages' },
];

interface Aoi {
  lat: number;
  lon: number;
  radiusKm: number;
}

const KM_PER_DEG_LAT = 111.32;

// Circle AOI → bounding box the backend can filter on (it takes a bbox); the
// exact circle is re-applied client-side below so the radius stays honest.
function aoiBbox(aoi: Aoi): [number, number, number, number] {
  const dLat = aoi.radiusKm / KM_PER_DEG_LAT;
  const dLon = aoi.radiusKm / (KM_PER_DEG_LAT * Math.max(0.05, Math.cos((aoi.lat * Math.PI) / 180)));
  return [aoi.lon - dLon, aoi.lat - dLat, aoi.lon + dLon, aoi.lat + dLat];
}

export function NormalSearchPanel({ viewer, onClose }: NormalSearchPanelProps): JSX.Element {
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const [dateMode, setDateMode] = useState<'static' | 'rolling'>('rolling');
  const [rollingH, setRollingH] = useState(24);
  const [aoi, setAoi] = useState<Aoi | null>(null);
  const [live, setLive] = useState(false);
  const [results, setResults] = useState<ObjectResult[]>([]);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const ab = new AbortController();
    abortRef.current = ab;
    setBusy(true);
    try {
      // Build facets omitting absent keys (exactOptionalPropertyTypes). Rolling
      // window constrains freshness; static range is a UI stub (the store only
      // holds the recent buffer, so "hours back" is the useful time axis).
      const facets: Parameters<typeof searchObjects>[0] = { type: kind, q, limit: 300 };
      if (aoi) facets.bbox = aoiBbox(aoi);
      if (dateMode === 'rolling') facets.sinceS = rollingH * 3600;
      const res = await searchObjects(facets, ab.signal);
      // Re-apply the exact circle client-side (the server filtered a bbox).
      const within = aoi
        ? res.results.filter((r) => haversineKm({ lat: r.lat, lon: r.lon }, { lat: aoi.lat, lon: aoi.lon }) <= aoi.radiusKm)
        : res.results;
      setResults(within);
      setByType(res.by_type);
      setCount(aoi ? within.length : res.count);
    } catch {
      /* aborted / offline */
    } finally {
      setBusy(false);
    }
  }, [kind, q, aoi, dateMode, rollingH]);

  // Live update: re-run every 5s while on.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void run(), 5000);
    return () => clearInterval(t);
  }, [live, run]);

  const drawAoi = (): void => {
    getDrawController()?.drawCircle((center, radiusKm) => setAoi({ lat: center.lat, lon: center.lon, radiusKm }));
  };

  const pick = (r: ObjectResult): void => {
    if (viewer) flyToPosition(viewer, r.lon, r.lat, 200 * 1000, 1.2);
    useSelection.getState().select(r.id);
  };

  // Compact per-type facet summary (Gotham shows live counts per object type).
  const facetSummary = useMemo(
    () =>
      Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(' · '),
    [byType],
  );

  return (
    <div className="nrm-workspace" style={{ left: 52, top: 48, bottom: 12, width: 330 }}>
      <div className="nrm-ws-head">
        <span className="nrm-ws-title">Search for objects</span>
        <button type="button" className="nrm-ws-x" aria-label="Close search" onClick={onClose}>
          <Icon name="x" className="ico" />
        </button>
      </div>
      <div className="nrm-ws-body">
        {/* Object type */}
        <label className="nrm-lbl">Object type</label>
        <select className="nrm-input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
              {byType[k.id] != null ? ` (${byType[k.id]})` : ''}
            </option>
          ))}
        </select>

        {/* Intrinsic date */}
        <label className="nrm-lbl">Intrinsic date</label>
        <div className="nrm-seg">
          <button type="button" className={dateMode === 'static' ? 'on' : ''} onClick={() => setDateMode('static')}>Static range</button>
          <button type="button" className={dateMode === 'rolling' ? 'on' : ''} onClick={() => setDateMode('rolling')}>Rolling window</button>
        </div>
        {dateMode === 'static' ? (
          <div className="nrm-row2">
            <input className="nrm-input" type="date" aria-label="Start date" />
            <input className="nrm-input" type="date" aria-label="End date" />
          </div>
        ) : (
          <div className="nrm-row2">
            <input className="nrm-input" type="number" min={1} value={rollingH} onChange={(e) => setRollingH(Number(e.target.value) || 1)} aria-label="Rolling hours" />
            <span className="nrm-unit">hours back</span>
          </div>
        )}

        {/* Keyword */}
        <label className="nrm-lbl">Keyword</label>
        <input
          className="nrm-input"
          value={q}
          placeholder="callsign, MMSI, name…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />

        {/* Geographic AOI */}
        <label className="nrm-lbl">Area of interest</label>
        {aoi ? (
          <div className="nrm-aoi">
            <span>{aoi.lat.toFixed(3)}, {aoi.lon.toFixed(3)} · r {aoi.radiusKm.toFixed(0)} km</span>
            <button type="button" onClick={() => setAoi(null)}>clear</button>
          </div>
        ) : (
          <button type="button" className="nrm-btn" onClick={drawAoi}>◯ Draw circle on map</button>
        )}

        <label className="nrm-check">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live update
        </label>

        <button type="button" className="nrm-btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>

        {/* Results */}
        <div className="nrm-ws-results">
          <div className="nrm-lbl" style={{ marginTop: '0.4em' }}>{count} result{count === 1 ? '' : 's'}</div>
          {facetSummary && <div className="nrm-unit" style={{ marginBottom: '0.3em' }}>{facetSummary}</div>}
          {results.map((r) => (
            <div className="row" key={r.id} onClick={() => pick(r)}>
              <span className="nm" title={r.label}>{r.label}</span>
              <span className="gcount">{r.kind}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
