import { useEffect, useMemo, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { searchObjects, type ObjectResult } from '../transport/search.js';
import { useSelection } from '../state/stores.js';
import { useSearchRegions, SLOTS, type Slot } from '../state/searchRegions.js';
import { haversineKm, getDrawController } from '../globe/draw.js';
import { flyToPosition } from '../globe/camera.js';
import { CoordEntry } from '../globe/CoordEntry.js';

// Palantir-Gotham "Search Objects" left sidebar. A single scoping surface: object
// type + intrinsic date (static range OR rolling window) + keyword + up to four
// independent geographic REGIONS (A/B/C/D), each a typed-or-drawn circle. The
// non-null regions are unioned into one bbox for GET /api/search/objects, then the
// results are re-filtered to the exact circles client-side. Rows select + fly.
// Renders inside a ~300px LeftIconRail flyout — compact, vertically scrollable.

const OBJECT_TYPES: Array<{ v: string; label: string }> = [
  { v: 'all', label: 'All objects' },
  { v: 'vessel', label: 'Vessel' },
  { v: 'aircraft', label: 'Aircraft' },
  { v: 'satellite', label: 'Satellite' },
  { v: 'emitter', label: 'Emitter' },
  { v: 'event', label: 'Event' },
  { v: 'outage', label: 'Outage' },
  { v: 'detection', label: 'Detection' },
  { v: 'quake', label: 'Quake' },
  { v: 'fire', label: 'Fire' },
];

// Rolling-window presets (mirror ExplorerApp WINDOWS) → sinceS seconds.
const WINDOWS: Array<{ label: string; s: number | undefined }> = [
  { label: 'All', s: undefined },
  { label: '15m', s: 900 },
  { label: '1h', s: 3600 },
  { label: '6h', s: 21600 },
  { label: '24h', s: 86400 },
  { label: '7d', s: 604800 },
];

const DEFAULT_RADIUS_KM = 25;
const REGION_FILL = Cesium.Color.fromCssColorString('#4fa0d8').withAlpha(0.1);
const REGION_LINE = Cesium.Color.fromCssColorString('#4fa0d8');
const REGION_LINE_ACTIVE = Cesium.Color.fromCssColorString('#d946ef'); // selection magenta

type Mode = 'view' | 'draw' | 'select';
type DateMode = 'static' | 'rolling';

function ageLabel(t: number): string {
  const sec = Math.max(0, Date.now() / 1000 - t);
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

// A circle's lat/lon envelope in degrees.
function circleBbox(
  center: { lat: number; lon: number },
  radiusKm: number,
): [number, number, number, number] {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.05, Math.cos((center.lat * Math.PI) / 180)));
  return [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mt-1">{children}</div>
  );
}

export function SearchObjectsSidebar({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const [mode, setMode] = useState<Mode>('view');
  const [type, setType] = useState<string>('all');
  const [dateMode, setDateMode] = useState<DateMode>('rolling');
  const [start, setStart] = useState<string>(''); // YYYY-MM-DD
  const [end, setEnd] = useState<string>('');
  const [winIdx, setWinIdx] = useState(0);
  const [q, setQ] = useState('');
  const [liveUpdate, setLiveUpdate] = useState(false);
  const [title, setTitle] = useState('Untitled search');

  const regions = useSearchRegions((s) => s.regions);
  const active = useSearchRegions((s) => s.active);
  const setActive = useSearchRegions((s) => s.setActive);
  const setRegion = useSearchRegions((s) => s.setRegion);
  const clearAll = useSearchRegions((s) => s.clearAll);

  // Per-slot intended radius — lets the operator set a radius before placing a
  // centre (typed or drawn), and edit it for an existing region.
  const [radii, setRadii] = useState<Record<Slot, number>>({
    A: DEFAULT_RADIUS_KM,
    B: DEFAULT_RADIUS_KM,
    C: DEFAULT_RADIUS_KM,
    D: DEFAULT_RADIUS_KM,
  });

  const [data, setData] = useState<{
    results: ObjectResult[];
    count: number;
    by_type: Record<string, number>;
  }>({ results: [], count: 0, by_type: {} });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // ── runSearch ─────────────────────────────────────────────────────────────
  const runSearch = (): void => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    setErr(null);

    const live = SLOTS.map((s) => regions[s]).filter((r): r is NonNullable<typeof r> => r != null);

    // Union every region circle's envelope into one bbox for the backend.
    let bbox: [number, number, number, number] | undefined;
    for (const r of live) {
      const [minLon, minLat, maxLon, maxLat] = circleBbox(r.center, r.radiusKm);
      if (!bbox) bbox = [minLon, minLat, maxLon, maxLat];
      else {
        bbox = [
          Math.min(bbox[0], minLon),
          Math.min(bbox[1], minLat),
          Math.max(bbox[2], maxLon),
          Math.max(bbox[3], maxLat),
        ];
      }
    }

    // Date facets: only one mode's values are sent.
    const dateFacets: { sinceS?: number; startS?: number; endS?: number } = {};
    if (dateMode === 'rolling') {
      const win = WINDOWS[winIdx];
      if (win && win.s != null) dateFacets.sinceS = win.s;
    } else {
      if (start) dateFacets.startS = new Date(start).getTime() / 1000;
      if (end) dateFacets.endS = new Date(`${end}T23:59:59`).getTime() / 1000;
    }

    // searchObjects drops type==='all' and empty q internally, so pass them
    // directly (exactOptionalPropertyTypes forbids explicit `undefined`).
    searchObjects(
      {
        type,
        q,
        limit: 500,
        ...(bbox ? { bbox } : {}),
        ...dateFacets,
      },
      ac.signal,
    )
      .then((d) => {
        if (live.length > 0) {
          const inside = d.results.filter((res) =>
            live.some((rg) => haversineKm({ lat: res.lat, lon: res.lon }, rg.center) <= rg.radiusKm),
          );
          const by_type: Record<string, number> = {};
          for (const res of inside) by_type[res.kind] = (by_type[res.kind] ?? 0) + 1;
          setData({ results: inside, count: inside.length, by_type });
        } else {
          setData(d);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setErr('search failed');
      })
      .finally(() => setLoading(false));
  };

  // Keep the latest runSearch in a ref so the live-update interval always calls
  // the current closure (fresh facets) without re-arming the interval.
  const runRef = useRef(runSearch);
  runRef.current = runSearch;

  useEffect(() => {
    if (!liveUpdate) return;
    const id = window.setInterval(() => runRef.current(), 5000);
    return () => window.clearInterval(id);
  }, [liveUpdate]);

  useEffect(() => () => abort.current?.abort(), []);

  // ── region map render (self-contained CustomDataSource) ─────────────────────
  const dsRef = useRef<Cesium.CustomDataSource | null>(null);
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;
    const ds = new Cesium.CustomDataSource('__search_regions');
    void viewer.dataSources.add(ds);
    dsRef.current = ds;
    return () => {
      dsRef.current = null;
      try {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      } catch {
        /* viewer gone */
      }
    };
  }, [viewer]);

  useEffect(() => {
    const ds = dsRef.current;
    if (!ds || !viewer || viewer.isDestroyed()) return;
    ds.entities.removeAll();
    for (const slot of SLOTS) {
      const r = regions[slot];
      if (!r) continue;
      const isActive = slot === active;
      ds.entities.add({
        id: `__search_region_${slot}`,
        position: Cesium.Cartesian3.fromDegrees(r.center.lon, r.center.lat),
        ellipse: {
          semiMajorAxis: r.radiusKm * 1000,
          semiMinorAxis: r.radiusKm * 1000,
          material: REGION_FILL,
          outline: true,
          outlineColor: isActive ? REGION_LINE_ACTIVE : REGION_LINE,
          outlineWidth: 2,
          height: 0,
        },
        label: {
          text: slot,
          font: 'bold 13px "IBM Plex Mono", monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    if (!viewer.isDestroyed()) viewer.scene.requestRender();
  }, [regions, active, viewer]);

  const onRow = (r: ObjectResult): void => {
    useSelection.getState().select(r.id);
    if (viewer && !viewer.isDestroyed()) flyToPosition(viewer, r.lon, r.lat, 200_000, 0.8);
  };

  const byTypeSummary = useMemo(
    () =>
      Object.entries(data.by_type)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6),
    [data.by_type],
  );

  const modeHint =
    mode === 'select'
      ? 'Click an object on the map to select it.'
      : mode === 'draw'
        ? 'Use a region’s "draw" button, then click a centre + edge on the map.'
        : null;

  return (
    <div className="h-full flex flex-col text-txt-1">
      {/* header + segmented mode */}
      <div className="shrink-0 border-b border-line-2 bg-bg-1 px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0">
            Search Objects
          </span>
          <span className="mono text-[10px] text-txt-3">{data.count.toLocaleString()} match</span>
        </div>
        <div className="flex items-center gap-1">
          {(['view', 'draw', 'select'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-1 rounded-sm border ${
                mode === m
                  ? 'border-accent-line text-accent bg-accent-dim'
                  : 'border-line text-txt-3 hover:text-txt-1'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {modeHint && <div className="mono text-[10px] text-txt-3">{modeHint}</div>}
      </div>

      {/* scrollable controls */}
      <div className="flex-1 min-h-0 overflow-auto px-3 py-2 flex flex-col gap-2">
        {/* object type */}
        <div className="flex flex-col gap-1">
          <SectionLabel>Object type</SectionLabel>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="bg-bg-0 border border-line rounded-sm px-2 py-1 text-[12px] text-txt-0 focus:border-accent-line outline-none"
          >
            {OBJECT_TYPES.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* intrinsic date */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <SectionLabel>Intrinsic date</SectionLabel>
            <div className="flex items-center gap-1">
              {(['static', 'rolling'] as DateMode[]).map((dm) => (
                <button
                  key={dm}
                  type="button"
                  onClick={() => setDateMode(dm)}
                  className={`mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-0.5 rounded-sm border ${
                    dateMode === dm
                      ? 'border-accent-line text-accent bg-accent-dim'
                      : 'border-line text-txt-3 hover:text-txt-1'
                  }`}
                >
                  {dm === 'static' ? 'Static' : 'Rolling'}
                </button>
              ))}
            </div>
          </div>
          {dateMode === 'static' ? (
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="start date"
                className="flex-1 min-w-0 mono bg-bg-0 border border-line rounded-sm px-1.5 py-1 text-[11px] text-txt-0 focus:border-accent-line outline-none"
              />
              <span className="mono text-[10px] text-txt-3">→</span>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                aria-label="end date"
                className="flex-1 min-w-0 mono bg-bg-0 border border-line rounded-sm px-1.5 py-1 text-[11px] text-txt-0 focus:border-accent-line outline-none"
              />
            </div>
          ) : (
            <div className="flex items-center gap-1 flex-wrap">
              {WINDOWS.map((w, i) => (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => setWinIdx(i)}
                  className={`mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-1 rounded-sm border ${
                    i === winIdx
                      ? 'border-accent-line text-accent bg-accent-dim'
                      : 'border-line text-txt-3 hover:text-txt-1'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* keyword */}
        <div className="flex flex-col gap-1">
          <SectionLabel>Keyword</SectionLabel>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
            placeholder="callsign / name / id…"
            className="bg-bg-0 border border-line rounded-sm px-2 py-1 text-[12px] text-txt-0 placeholder:text-txt-4 focus:border-accent-line outline-none"
          />
        </div>

        {/* regions A-D */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <SectionLabel>Regions</SectionLabel>
            <button
              type="button"
              onClick={clearAll}
              className="mono text-[10px] text-txt-3 hover:text-txt-0"
            >
              clear all
            </button>
          </div>
          {SLOTS.map((slot) => {
            const r = regions[slot];
            const isActive = slot === active;
            return (
              <div
                key={slot}
                onClick={() => setActive(slot)}
                className={`flex flex-col gap-1 rounded-sm border p-1.5 cursor-pointer ${
                  isActive ? 'border-accent-line bg-accent-dim/40' : 'border-line hover:border-line-2'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`mono text-[11px] font-bold w-4 text-center rounded-sm ${
                      isActive ? 'text-accent' : 'text-txt-2'
                    }`}
                  >
                    {slot}
                  </span>
                  <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                    <CoordEntry
                      viewer={viewer}
                      fly={false}
                      placeholder={`Region ${slot} — coord or place`}
                      onPlace={(lat, lon) =>
                        setRegion(slot, { center: { lat, lon }, radiusKm: radii[slot] })
                      }
                    />
                  </div>
                </div>
                <div
                  className="flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="number"
                    min={1}
                    value={radii[slot]}
                    onChange={(e) => {
                      const km = Math.max(1, Number(e.target.value) || 1);
                      setRadii((prev) => ({ ...prev, [slot]: km }));
                      if (r) setRegion(slot, { center: r.center, radiusKm: km });
                    }}
                    aria-label={`Region ${slot} radius km`}
                    className="w-14 mono bg-bg-0 border border-line rounded-sm px-1.5 py-0.5 text-[11px] text-txt-0 focus:border-accent-line outline-none"
                  />
                  <span className="mono text-[10px] text-txt-3">km</span>
                  <button
                    type="button"
                    onClick={() => {
                      setActive(slot);
                      getDrawController()?.drawCircle((c, rk) => {
                        setRegion(slot, { center: c, radiusKm: rk });
                        setRadii((prev) => ({ ...prev, [slot]: Math.round(rk) }));
                      });
                    }}
                    className="mono text-[10px] uppercase tracking-[0.4px] px-1.5 py-0.5 rounded-sm border border-line text-txt-2 hover:border-accent-line hover:text-accent"
                  >
                    draw
                  </button>
                  {r && (
                    <button
                      type="button"
                      onClick={() => setRegion(slot, null)}
                      aria-label={`Clear region ${slot}`}
                      className="mono text-[11px] px-1 text-txt-3 hover:text-alert"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {r && (
                  <div className="mono text-[10px] text-txt-2 pl-5">
                    {r.center.lat.toFixed(2)}, {r.center.lon.toFixed(2)} · {r.radiusKm}km
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* live update + title */}
        <label className="flex items-center gap-1.5 mono text-[11px] text-txt-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={liveUpdate}
            onChange={(e) => setLiveUpdate(e.target.checked)}
            className="accent-accent"
          />
          Live update (5s)
        </label>
        <div className="flex flex-col gap-1">
          <SectionLabel>Search title</SectionLabel>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-bg-0 border border-line rounded-sm px-2 py-1 text-[12px] text-txt-0 focus:border-accent-line outline-none"
          />
        </div>

        <button
          type="button"
          onClick={runSearch}
          className="mono text-[11px] uppercase tracking-[0.6px] py-1.5 rounded-sm border border-accent-line text-accent bg-accent-dim hover:bg-accent-dim/70"
        >
          {loading ? 'Searching…' : 'Search'}
        </button>

        {err && <div className="mono text-[10px] text-alert">{err}</div>}

        {/* results */}
        <div className="flex flex-col gap-1 mt-1">
          <div className="flex items-center justify-between">
            <SectionLabel>Results · {data.results.length.toLocaleString()}</SectionLabel>
            {byTypeSummary.length > 0 && (
              <div className="mono text-[10px] text-txt-3 truncate max-w-[160px]">
                {byTypeSummary.map(([k, n]) => `${k} ${n}`).join(' · ')}
              </div>
            )}
          </div>
          <div className="flex flex-col">
            {data.results.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onRow(r)}
                className="flex items-center gap-2 px-1 py-1 text-left border-t border-line hover:bg-bg-2"
              >
                <span className="mono text-[10px] uppercase text-txt-3 w-14 shrink-0 truncate">
                  {r.kind}
                </span>
                <span className="text-[12px] text-txt-0 truncate flex-1 min-w-0">{r.label}</span>
                <span className="mono text-[10px] text-txt-3 tabular-nums shrink-0">
                  {ageLabel(r.t)}
                </span>
              </button>
            ))}
            {data.results.length === 0 && (
              <div className="mono text-[11px] text-txt-3 py-4 text-center">
                {loading ? 'searching…' : 'No results yet — set your scope and hit Search.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
