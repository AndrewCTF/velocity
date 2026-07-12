import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { searchObjects, type ObjectResult } from '../transport/search.js';
import { useSelection } from '../state/stores.js';
import { useGeoScope } from '../state/geoScope.js';
import { haversineKm } from '../globe/draw.js';
import { useSavedSearches } from '../state/savedSearches.js';
import { toast } from '../shell/toast.js';

// Explorer app (design §6.1 / §8 "Object Explorer") — top-down analysis over the
// live object store: type facets + keyword + rolling window, live counts, and a
// tabular result set. Clicking a row selects the object (shared selection context)
// and flies the camera to it. Backed by the real GET /api/search/objects.

const WINDOWS: Array<{ label: string; s: number | undefined }> = [
  { label: 'All time', s: undefined },
  { label: '15 min', s: 900 },
  { label: '1 hour', s: 3600 },
  { label: '6 hours', s: 21600 },
];

function ageLabel(t: number): string {
  const sec = Math.max(0, Date.now() / 1000 - t);
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

export function ExplorerApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const [type, setType] = useState<string>('all');
  const [q, setQ] = useState('');
  const [winIdx, setWinIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<{ results: ObjectResult[]; count: number; by_type: Record<string, number> }>(
    { results: [], count: 0, by_type: {} },
  );
  const [loading, setLoading] = useState(false);
  const geoScope = useGeoScope((s) => s.scope);
  const clearGeo = useGeoScope((s) => s.setScope);
  const saveSearch = useSavedSearches((s) => s.add);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    const win = WINDOWS[winIdx];
    // §6.4 geo scope → radius bbox for the backend, then re-filter to the exact
    // circle client-side (the backend filters by bbox only).
    let bbox: [number, number, number, number] | undefined;
    if (geoScope) {
      const dLat = geoScope.radiusKm / 111;
      const dLon = geoScope.radiusKm / (111 * Math.max(0.05, Math.cos((geoScope.lat * Math.PI) / 180)));
      bbox = [geoScope.lon - dLon, geoScope.lat - dLat, geoScope.lon + dLon, geoScope.lat + dLat];
    }
    searchObjects(
      {
        type,
        q,
        limit: 500,
        ...(win && win.s != null ? { sinceS: win.s } : {}),
        ...(bbox ? { bbox } : {}),
      },
      ac.signal,
    )
      .then((d) => {
        if (geoScope) {
          const inside = d.results.filter(
            (r) => haversineKm({ lat: r.lat, lon: r.lon }, { lat: geoScope.lat, lon: geoScope.lon }) <= geoScope.radiusKm,
          );
          const by_type: Record<string, number> = {};
          for (const r of inside) by_type[r.kind] = (by_type[r.kind] ?? 0) + 1;
          setData({ results: inside, count: inside.length, by_type });
        } else {
          setData(d);
        }
      })
      .catch(() => {
        /* aborted / failed — keep last */
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [type, q, winIdx, tick, geoScope]);

  // Refresh on a slow tick so counts stay live without hammering.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  const typeChips = useMemo(() => {
    const entries = Object.entries(data.by_type).sort((a, b) => b[1] - a[1]);
    return [['all', data.count] as [string, number], ...entries];
  }, [data]);

  const exportCsv = (): void => {
    const rows = data.results;
    if (rows.length === 0) return;
    const esc = (v: unknown): string => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['id', 'label', 'kind', 'source', 't', 'lat', 'lon'];
    const body = rows.map((r) => [r.id, r.label, r.kind, r.source, r.t, r.lat, r.lon].map(esc).join(','));
    const blob = new Blob([[header.join(','), ...body].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `objects-${type}-${rows.length}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onRow = (r: ObjectResult): void => {
    useSelection.getState().select(r.id);
    if (viewer && !viewer.isDestroyed()) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 120_000),
        duration: 0.8,
      });
    }
  };

  return (
    <div className="h-full flex flex-col text-txt-1">
      {/* filter bar */}
      <div className="shrink-0 border-b border-line-2 bg-bg-1 px-3 py-2 flex flex-col gap-2">
        {geoScope && (
          <div className="flex items-center gap-2 self-start mono text-[10px] px-2 py-0.5 rounded-sm border border-accent-line bg-accent-dim text-accent">
            within {geoScope.radiusKm} km of {geoScope.label ?? `${geoScope.lat.toFixed(2)}, ${geoScope.lon.toFixed(2)}`}
            <button type="button" onClick={() => clearGeo(null)} aria-label="Clear geo scope" className="text-txt-2 hover:text-txt-0">
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by callsign / name / id…"
            className="flex-1 min-w-0 bg-bg-0 border border-line rounded-sm px-2 py-1 text-[12px] text-txt-0 placeholder:text-txt-4 focus:border-accent-line outline-none"
          />
          <div className="flex items-center gap-1">
            {WINDOWS.map((w, i) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setWinIdx(i)}
                className={`mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-1 rounded-sm border ${
                  i === winIdx ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-3 hover:text-txt-1'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
        {/* type facet chips with live counts */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {typeChips.map(([k, n]) => (
            <button
              key={k}
              type="button"
              onClick={() => setType(k)}
              className={`mono text-[10px] px-2 py-0.5 rounded-sm border ${
                type === k ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-2 hover:text-txt-0'
              }`}
            >
              {k} <b className="text-txt-0">{n.toLocaleString()}</b>
            </button>
          ))}
        </div>
      </div>

      {/* result table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-bg-1 z-[1]">
            <tr className="text-txt-3 mono text-[10px] uppercase tracking-[0.4px]">
              <th className="text-left font-medium px-3 py-1.5">Label</th>
              <th className="text-left font-medium px-2 py-1.5">Type</th>
              <th className="text-left font-medium px-2 py-1.5">Source</th>
              <th className="text-right font-medium px-2 py-1.5">Seen</th>
              <th className="text-right font-medium px-3 py-1.5">Lat, Lon</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr
                key={r.id}
                onClick={() => onRow(r)}
                className="cursor-pointer border-t border-line hover:bg-bg-2"
              >
                <td className="px-3 py-1 text-[12px] text-txt-0 truncate max-w-[180px]">{r.label}</td>
                <td className="px-2 py-1 mono text-[11px] text-txt-2">{r.kind}</td>
                <td className="px-2 py-1 mono text-[11px] text-txt-3 truncate max-w-[110px]">{r.source}</td>
                <td className="px-2 py-1 mono text-[11px] text-txt-2 text-right tabular-nums">{ageLabel(r.t)}</td>
                <td className="px-3 py-1 mono text-[10px] text-txt-3 text-right tabular-nums">
                  {r.lat.toFixed(2)}, {r.lon.toFixed(2)}
                </td>
              </tr>
            ))}
            {data.results.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center mono text-[11px] text-txt-3">
                  {loading ? 'searching…' : 'No objects match. Widen the window or clear the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="shrink-0 border-t border-line-2 bg-bg-1 px-3 py-1.5 mono text-[10px] text-txt-3 flex items-center justify-between">
        <span>
          {data.results.length.toLocaleString()} shown · {data.count.toLocaleString()} match
        </span>
        <div className="flex items-center gap-3">
          {loading && <span className="text-accent">updating…</span>}
          <button
            type="button"
            onClick={() => {
              const win = WINDOWS[winIdx];
              const label = `${type}${q ? ` · "${q}"` : ''}${win && win.s != null ? ` · ${win.label}` : ''}`;
              saveSearch(label, { type, q, ...(win && win.s != null ? { sinceS: win.s } : {}) });
              toast.ok('Search saved');
            }}
            title="Save this filter as an Inbox subscription — you're notified when new objects match"
            className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line"
          >
            Save search
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={data.results.length === 0}
            className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:text-txt-0 hover:border-accent-line disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      </div>
    </div>
  );
}
