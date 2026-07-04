import { useEffect, useMemo, useState } from 'react';

import { useImagery } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';
import { SectionLabel, MicroLabel, Btn, Badge, Caveat } from '../shell/instruments.js';

interface CatalogLayer {
  provider: string;
  id: string;
  title: string;
  group: string;
  max_z: number;
  static?: boolean;
}

interface GeocodeHit {
  name: string;
  lat: number;
  lon: number;
  type: string;
}

interface EventFeature {
  id?: string;
  geometry?: { type?: string; coordinates?: number[] };
  properties?: Record<string, unknown>;
}

interface EventsAllResponse {
  features: EventFeature[];
  count: number;
  sources: Record<string, { ok: boolean; kept?: number; note?: string; error?: string }>;
}

// Shared field styling — tokenised mono inputs/selects matching the console.
const FIELD =
  'mono text-[11px] bg-bg-1 border border-line rounded-sm px-1.5 py-1 text-txt-1 placeholder:text-txt-3/60 focus:outline-none focus:border-accent-line disabled:opacity-40';

// Square mono step button for the day stepper — matches the Btn neutral look
// but stays a native <button> so the aria-label is forwarded.
const STEP_BTN =
  'mono text-[11px] w-7 py-[5px] rounded-sm border border-line-2 bg-bg-2 text-txt-1 hover:border-accent-line disabled:opacity-40 transition-colors';

function eventLabel(f: EventFeature): string {
  const p = f.properties ?? {};
  const title =
    (p.title as string) ||
    (p.name as string) ||
    (p.event_type as string) ||
    (p.html as string) ||
    'event';
  const src = (p.source as string) ?? '';
  return src ? `${title} · ${src}` : title;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Multi-temporal change detection (A/B) ──────────────────────────────────
// The honest metadata the backend reports for a change chip (X-Chip header).
interface ChangeMeta {
  provider: string; // 'sentinel' | 'sentinel-sar'
  mode?: string;
  before: string;
  after: string;
  gsd_m: number | null;
  legend?: { red?: string; green?: string };
  note?: string | null;
}

type ChangeMode = 'optical' | 'radar';

function changeProviderLabel(provider: string): string {
  if (provider === 'sentinel') return 'SENTINEL-2 Δ';
  if (provider === 'sentinel-sar') return 'SENTINEL-1 Δ';
  return provider.toUpperCase();
}

// Curated war-damage AOIs (Sentinel-1 SAR collapse candidates, red). Each maps
// to a backend AOI key in app/intel/sar_damage.py.
const DAMAGE_AOIS: { id: string; label: string }[] = [
  { id: 'beirut-dahieh', label: 'Beirut — Dahieh (2024)' },
  { id: 'south-lebanon', label: 'South Lebanon (2024)' },
  { id: 'gaza-city', label: 'Gaza City (2023–24)' },
  { id: 'khan-younis', label: 'Khan Younis (2023–24)' },
  { id: 'rafah', label: 'Rafah (2024)' },
  { id: 'mariupol', label: 'Mariupol (2022)' },
  { id: 'bakhmut', label: 'Bakhmut (2022–23)' },
];

// Satellite imagery overlay picker + day stepper + opacity. Drives the
// useImagery store's `overlay` (provider + layer + date) and `overlayOpacity`,
// which GlobeCanvas renders on the globe. Lists EVERY keyless GIBS layer +
// keyed CDSE Sentinel layer from /api/imagery/catalog, grouped by category.
export function ImageryControl() {
  const overlay = useImagery((s) => s.overlay);
  const setOverlay = useImagery((s) => s.setOverlay);
  const overlayOpacity = useImagery((s) => s.overlayOpacity);
  const setOverlayOpacity = useImagery((s) => s.setOverlayOpacity);
  const lod1Aoi = useImagery((s) => s.lod1Aoi);
  const setLod1Aoi = useImagery((s) => s.setLod1Aoi);
  const requestLod1Here = useImagery((s) => s.requestLod1Here);
  const eventsLocation = useImagery((s) => s.eventsLocation);
  const setEventsLocation = useImagery((s) => s.setEventsLocation);
  const eventsRadiusKm = useImagery((s) => s.eventsRadiusKm);
  const setEventsRadiusKm = useImagery((s) => s.setEventsRadiusKm);
  const requestFlyTo = useImagery((s) => s.requestFlyTo);
  const [layers, setLayers] = useState<CatalogLayer[]>([]);

  // ── Location / events search state (local UI, applied to the store on submit).
  const [cityQuery, setCityQuery] = useState('');
  const [geocodeHits, setGeocodeHits] = useState<GeocodeHit[]>([]);
  const [geocoding, setGeocoding] = useState(false);
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventFeature[]>([]);
  const [eventsSummary, setEventsSummary] = useState<EventsAllResponse['sources'] | null>(null);

  // ── Change detection (A/B) local state. Drapes a Sentinel before/after diff
  // for the active location; previews it inline with honest labels.
  const [changeBefore, setChangeBefore] = useState(() => daysAgo(30));
  const [changeAfter, setChangeAfter] = useState(() => daysAgo(1));
  const [changeMode, setChangeMode] = useState<ChangeMode>('optical');
  const [changeLoading, setChangeLoading] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changeImg, setChangeImg] = useState<string | null>(null);
  const [changeMeta, setChangeMeta] = useState<ChangeMeta | null>(null);

  // Fetch the change chip for the active events location between the two dates.
  // Keyless route, but a plain XHR (apiFetch) is fine for an inline <img> blob;
  // the SingleTileImageryProvider keyless constraint is only for Cesium-side
  // drapes. Reads the honest X-Chip header so the preview is labeled, never
  // implying live collection. Revokes the prior object URL to avoid leaks.
  async function runChange(): Promise<void> {
    const loc = eventsLocation;
    if (!loc) {
      setChangeError('set a location first (search above)');
      return;
    }
    if (changeBefore >= changeAfter) {
      setChangeError('before date must be earlier than after');
      return;
    }
    setChangeLoading(true);
    setChangeError(null);
    try {
      const p = new URLSearchParams({
        lat: loc.lat.toFixed(5),
        lon: loc.lon.toFixed(5),
        radius_km: '4',
        before: changeBefore,
        after: changeAfter,
        mode: changeMode,
      });
      const r = await apiFetch(`/api/imagery/change?${p.toString()}`);
      if (!r.ok) {
        // Honest upstream states: 503 = needs CDSE creds, 502 = no pair found.
        const reason =
          r.status === 503
            ? 'needs Sentinel/CDSE credentials'
            : r.status === 502
              ? 'no Sentinel pair for this AOI/dates'
              : `change ${r.status}`;
        throw new Error(reason);
      }
      let meta: ChangeMeta | null = null;
      try {
        meta = JSON.parse(r.headers.get('X-Chip') ?? 'null') as ChangeMeta;
      } catch {
        meta = null;
      }
      const blob = await r.blob();
      setChangeImg((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setChangeMeta(meta);
    } catch (e) {
      setChangeImg((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setChangeMeta(null);
      setChangeError(e instanceof Error ? e.message : 'failed');
    } finally {
      setChangeLoading(false);
    }
  }

  // Revoke the change object URL on unmount (avoid leaking the blob).
  useEffect(() => {
    return () => {
      if (changeImg) URL.revokeObjectURL(changeImg);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runGeocode(): Promise<void> {
    const q = cityQuery.trim();
    if (!q) return;
    setGeocoding(true);
    try {
      const r = await apiFetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const b: { results?: GeocodeHit[] } = await r.json();
      setGeocodeHits(b.results ?? []);
    } catch {
      setGeocodeHits([]);
    } finally {
      setGeocoding(false);
    }
  }

  // Apply a location: sync the store, fly the camera there, and fetch every
  // event (eonet+gdelt+acled) within the radius around it.
  async function applyLocation(lat: number, lon: number, name?: string): Promise<void> {
    setEventsLocation({ lat, lon, ...(name !== undefined ? { name } : {}) });
    setLatInput(lat.toFixed(4));
    setLonInput(lon.toFixed(4));
    requestFlyTo(lat, lon);
    setEventsLoading(true);
    setEventsError(null);
    try {
      const r = await apiFetch(
        `/api/events/all?lat=${lat}&lon=${lon}&radius_km=${eventsRadiusKm}`,
      );
      if (!r.ok) throw new Error(`events ${r.status}`);
      const b: EventsAllResponse = await r.json();
      setEvents(b.features ?? []);
      setEventsSummary(b.sources ?? null);
    } catch (e) {
      setEvents([]);
      setEventsSummary(null);
      setEventsError(e instanceof Error ? e.message : 'failed');
    } finally {
      setEventsLoading(false);
    }
  }

  function applyTypedCoords(): void {
    const lat = Number(latInput);
    const lon = Number(lonInput);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setEventsError('lat/lon must be numbers');
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setEventsError('lat ∈ [-90,90], lon ∈ [-180,180]');
      return;
    }
    void applyLocation(lat, lon);
  }

  useEffect(() => {
    let alive = true;
    apiFetch('/api/imagery/catalog')
      // A non-2xx (e.g. 401 when signed out) still has a JSON body — guard so
      // `layers` is always an array and the grouping useMemo can't throw.
      .then((r) => (r.ok ? r.json() : { layers: [] }))
      .then((b: { layers?: CatalogLayer[] }) => {
        if (alive) setLayers(Array.isArray(b?.layers) ? b.layers : []);
      })
      .catch(() => {
        if (alive) setLayers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Group layers by category, preserving catalog order within each group.
  const grouped = useMemo(() => {
    const m = new Map<string, CatalogLayer[]>();
    for (const l of layers) {
      const arr = m.get(l.group) ?? [];
      arr.push(l);
      m.set(l.group, arr);
    }
    return [...m.entries()];
  }, [layers]);

  const date = overlay?.date ?? today();
  const selectedKey = overlay ? `${overlay.provider}:${overlay.layer}` : '';
  const selectedLayer = layers.find((l) => `${l.provider}:${l.id}` === selectedKey);
  const isStatic = selectedLayer?.static === true;

  return (
    <div className="px-3 py-2 flex flex-col gap-3">
      {/* ── Overlay layer picker ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel title="Satellite imagery" count={layers.length} />
        <select
          value={selectedKey}
          onChange={(e) => {
            const hit = layers.find((l) => `${l.provider}:${l.id}` === e.target.value);
            setOverlay(
              hit
                ? { provider: hit.provider, layer: hit.id, date, maxZ: hit.max_z }
                : null,
            );
          }}
          className={`${FIELD} w-full`}
        >
          <option value="">Off</option>
          {grouped.map(([group, ls]) => (
            <optgroup key={group} label={group}>
              {ls.map((l) => (
                <option key={`${l.provider}:${l.id}`} value={`${l.provider}:${l.id}`}>
                  {l.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* ── Find events at a location ─────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel title="Find events at a location" />
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void runGeocode();
          }}
        >
          <input
            type="text"
            placeholder="City or place name…"
            value={cityQuery}
            onChange={(e) => setCityQuery(e.target.value)}
            aria-label="City name"
            className={`${FIELD} flex-1 min-w-0`}
          />
          <Btn tone="accent" disabled={geocoding || !cityQuery.trim()} onClick={() => void runGeocode()}>
            {geocoding ? '…' : 'Search'}
          </Btn>
        </form>
        {geocodeHits.length > 0 && (
          <ul className="flex flex-col rounded-sm border border-line bg-bg-2 overflow-hidden">
            {geocodeHits.map((h) => (
              <li key={`${h.lat},${h.lon},${h.name}`} className="border-b border-[rgba(255,255,255,0.035)] last:border-b-0">
                <button
                  type="button"
                  title={`${h.lat.toFixed(4)}, ${h.lon.toFixed(4)} (${h.type})`}
                  onClick={() => {
                    setGeocodeHits([]);
                    void applyLocation(h.lat, h.lon, h.name);
                  }}
                  className="w-full text-left mono text-[11px] text-txt-1 px-2 py-[5px] hover:bg-accent-dim hover:text-accent transition-colors truncate"
                >
                  {h.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-1">
          <input
            type="number"
            step="any"
            placeholder="lat"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            aria-label="Latitude"
            className={`${FIELD} flex-1 min-w-0 tabular-nums`}
          />
          <input
            type="number"
            step="any"
            placeholder="lon"
            value={lonInput}
            onChange={(e) => setLonInput(e.target.value)}
            aria-label="Longitude"
            className={`${FIELD} flex-1 min-w-0 tabular-nums`}
          />
          <Btn onClick={applyTypedCoords}>Go</Btn>
        </div>
        <div className="flex items-center justify-between gap-2">
          <MicroLabel>Radius</MicroLabel>
          <span className="mono text-[10px] text-txt-1 tabular-nums">{eventsRadiusKm} km</span>
        </div>
        <input
          type="range"
          min={10}
          max={3000}
          step={10}
          value={eventsRadiusKm}
          onChange={(e) => setEventsRadiusKm(Number(e.target.value))}
          onMouseUp={() => {
            if (eventsLocation)
              void applyLocation(eventsLocation.lat, eventsLocation.lon, eventsLocation.name);
          }}
          className="w-full accent-accent"
        />
        {eventsLocation && (
          <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-bg-2 p-2">
            {eventsLoading ? (
              <MicroLabel>Loading events…</MicroLabel>
            ) : eventsError ? (
              <Badge tone="alert">Error: {eventsError}</Badge>
            ) : (
              <>
                <span className="mono text-[10.5px] text-txt-1 tabular-nums">
                  {events.length} event{events.length === 1 ? '' : 's'} within {eventsRadiusKm} km
                  {eventsLocation.name ? ` of ${eventsLocation.name.split(',')[0]}` : ''}
                </span>
                {eventsSummary && (
                  <span className="mono text-[10px] text-txt-3 tabular-nums">
                    {Object.entries(eventsSummary)
                      .map(([k, v]) => `${k}: ${v.ok ? (v.kept ?? 0) : '×'}`)
                      .join('  ·  ')}
                  </span>
                )}
                {events.length > 0 && (
                  <ul className="flex flex-col">
                    {events.slice(0, 50).map((f, i) => {
                      const c = f.geometry?.coordinates;
                      const flon = c?.[0];
                      const flat = c?.[1];
                      const canFly = typeof flon === 'number' && typeof flat === 'number';
                      return (
                        <li
                          key={f.id ?? i}
                          className="border-b border-[rgba(255,255,255,0.035)] last:border-b-0"
                        >
                          <button
                            type="button"
                            disabled={!canFly}
                            onClick={() => {
                              if (typeof flon === 'number' && typeof flat === 'number')
                                requestFlyTo(flat, flon);
                            }}
                            className="w-full text-left mono text-[10.5px] text-txt-1 py-[5px] hover:text-accent disabled:opacity-40 disabled:hover:text-txt-1 transition-colors truncate"
                          >
                            {eventLabel(f)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Change detection (A/B) ────────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel title="Change detection (A/B)" />
        <MicroLabel className="block text-txt-3">
          Sentinel before/after diff at the active location · red = loss · green = gain
        </MicroLabel>
        <div className="flex items-center gap-1">
          <span className="mono text-[10px] text-txt-3 w-3 shrink-0">A</span>
          <input
            type="date"
            value={changeBefore}
            max={today()}
            onChange={(e) => setChangeBefore(e.target.value)}
            aria-label="Before date"
            className={`${FIELD} flex-1 min-w-0 tabular-nums`}
          />
          <span className="mono text-[10px] text-txt-3 w-3 shrink-0">B</span>
          <input
            type="date"
            value={changeAfter}
            max={today()}
            onChange={(e) => setChangeAfter(e.target.value)}
            aria-label="After date"
            className={`${FIELD} flex-1 min-w-0 tabular-nums`}
          />
        </div>
        <div className="flex gap-1">
          <select
            value={changeMode}
            onChange={(e) => setChangeMode(e.target.value as ChangeMode)}
            aria-label="Change mode"
            className={`${FIELD} flex-1 min-w-0`}
          >
            <option value="optical">Optical (S2 · NDVI/NDWI)</option>
            <option value="radar">Radar (S1 · VV ratio)</option>
          </select>
          <Btn
            tone="accent"
            disabled={changeLoading || !eventsLocation}
            onClick={() => void runChange()}
            title={
              eventsLocation
                ? 'Compute the Sentinel change between dates A and B at the active location'
                : 'Set a location above first'
            }
          >
            {changeLoading ? '…' : 'Compute'}
          </Btn>
        </div>
        {!eventsLocation && (
          <MicroLabel className="block text-txt-3">
            Set a location above to enable change detection.
          </MicroLabel>
        )}
        {changeError && <Badge tone="alert">Error: {changeError}</Badge>}
        {changeImg && changeMeta && (
          <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-bg-2 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Caveat
                level={changeProviderLabel(changeMeta.provider)}
                note={changeMeta.gsd_m != null ? `${Math.round(changeMeta.gsd_m)} m` : '— m'}
                tone="warn"
              />
              <Caveat level={`A ${changeMeta.before}`} />
              <Caveat level={`B ${changeMeta.after}`} />
            </div>
            {/* The diverging change render. Honesty: archived passes, not live. */}
            <img
              src={changeImg}
              alt={`Sentinel change ${changeMeta.before} → ${changeMeta.after}`}
              className="w-full rounded-sm border border-line"
            />
            <div className="flex items-center gap-2 mono text-[10px] text-txt-3">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-[#cc2828]" />
                {changeMeta.legend?.red ?? 'loss'}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm bg-[#28cc46]" />
                {changeMeta.legend?.green ?? 'gain'}
              </span>
            </div>
            <MicroLabel className="block text-txt-3">
              archived satellite passes · not live · each window mosaics nearby passes
            </MicroLabel>
          </div>
        )}
      </div>

      {/* ── Overlay opacity (only when a layer is active) ─────────────────── */}
      {overlay && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <MicroLabel>Opacity</MicroLabel>
            <span className="mono text-[10px] text-txt-1 tabular-nums">
              {Math.round(overlayOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(overlayOpacity * 100)}
            onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
            className="w-full accent-accent"
          />
        </div>
      )}

      {/* ── 3D buildings + war-damage AOI ─────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <SectionLabel title="3D buildings" />
        <Btn
          onClick={() => requestLod1Here()}
          title="Extrude real OSM building footprints for whatever the camera is currently looking at"
          className="w-full"
        >
          Load 3D buildings here
        </Btn>
        <div className="flex flex-col gap-1">
          <MicroLabel>War-damage 3D</MicroLabel>
          <select
            value={lod1Aoi ?? ''}
            onChange={(e) => setLod1Aoi(e.target.value || null)}
            title="Curated AOI: red = Sentinel-1 SAR collapse candidate"
            className={`${FIELD} w-full`}
          >
            <option value="">Off</option>
            {DAMAGE_AOIS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Day stepper (time-varying overlays only) ──────────────────────── */}
      {/* Native buttons here to preserve the aria-label="Previous/Next day" the
          Btn primitive does not forward. */}
      {overlay && !isStatic && (
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, -1) })}
            className={STEP_BTN}
          >
            ◀
          </button>
          <span className="mono text-[11px] text-txt-0 tabular-nums">{overlay.date}</span>
          <button
            type="button"
            aria-label="Next day"
            disabled={overlay.date >= today()}
            onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, 1) })}
            className={STEP_BTN}
          >
            ▶
          </button>
        </div>
      )}
    </div>
  );
}
