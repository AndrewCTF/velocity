import { useEffect, useMemo, useState } from 'react';

import { useImagery } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';

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
      .then((r) => r.json())
      .then((b: { layers: CatalogLayer[] }) => {
        if (alive) setLayers(b.layers);
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
    <div className="imagery-control">
      <label className="imagery-control__row">
        <span>Satellite imagery ({layers.length})</span>
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
      </label>
      <div className="imagery-control__events">
        <div className="imagery-control__row">
          <span>Find events at a location</span>
        </div>
        <form
          className="imagery-control__row"
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
          />
          <button type="submit" disabled={geocoding || !cityQuery.trim()}>
            {geocoding ? '…' : 'Search'}
          </button>
        </form>
        {geocodeHits.length > 0 && (
          <ul className="imagery-control__geocode">
            {geocodeHits.map((h) => (
              <li key={`${h.lat},${h.lon},${h.name}`}>
                <button
                  type="button"
                  title={`${h.lat.toFixed(4)}, ${h.lon.toFixed(4)} (${h.type})`}
                  onClick={() => {
                    setGeocodeHits([]);
                    void applyLocation(h.lat, h.lon, h.name);
                  }}
                >
                  {h.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="imagery-control__row imagery-control__latlon">
          <input
            type="number"
            step="any"
            placeholder="lat"
            value={latInput}
            onChange={(e) => setLatInput(e.target.value)}
            aria-label="Latitude"
          />
          <input
            type="number"
            step="any"
            placeholder="lon"
            value={lonInput}
            onChange={(e) => setLonInput(e.target.value)}
            aria-label="Longitude"
          />
          <button type="button" onClick={applyTypedCoords}>
            Go
          </button>
        </div>
        <label className="imagery-control__row">
          <span>Radius {eventsRadiusKm} km</span>
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
          />
        </label>
        {eventsLocation && (
          <div className="imagery-control__events-result">
            {eventsLoading ? (
              <span>Loading events…</span>
            ) : eventsError ? (
              <span className="imagery-control__events-error">Error: {eventsError}</span>
            ) : (
              <>
                <span>
                  {events.length} event{events.length === 1 ? '' : 's'} within{' '}
                  {eventsRadiusKm} km
                  {eventsLocation.name ? ` of ${eventsLocation.name.split(',')[0]}` : ''}
                </span>
                {eventsSummary && (
                  <span className="imagery-control__events-sources">
                    {Object.entries(eventsSummary)
                      .map(([k, v]) => `${k}: ${v.ok ? (v.kept ?? 0) : '×'}`)
                      .join('  ·  ')}
                  </span>
                )}
                {events.length > 0 && (
                  <ul className="imagery-control__events-list">
                    {events.slice(0, 50).map((f, i) => {
                      const c = f.geometry?.coordinates;
                      const flon = c?.[0];
                      const flat = c?.[1];
                      const canFly = typeof flon === 'number' && typeof flat === 'number';
                      return (
                        <li key={f.id ?? i}>
                          <button
                            type="button"
                            disabled={!canFly}
                            onClick={() => {
                              if (typeof flon === 'number' && typeof flat === 'number')
                                requestFlyTo(flat, flon);
                            }}
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
      {overlay && (
        <label className="imagery-control__row">
          <span>Opacity {Math.round(overlayOpacity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(overlayOpacity * 100)}
            onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
          />
        </label>
      )}
      <div className="imagery-control__lod1">
        <button
          type="button"
          onClick={() => requestLod1Here()}
          title="Extrude real OSM building footprints for whatever the camera is currently looking at"
        >
          Load 3D buildings here
        </button>
        <label className="imagery-control__row">
          <span>War-damage 3D</span>
          <select
            value={lod1Aoi ?? ''}
            onChange={(e) => setLod1Aoi(e.target.value || null)}
            title="Curated AOI: red = Sentinel-1 SAR collapse candidate"
          >
            <option value="">Off</option>
            {DAMAGE_AOIS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {overlay && !isStatic && (
        <div className="imagery-control__date">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, -1) })}
          >
            ◀
          </button>
          <span>{overlay.date}</span>
          <button
            type="button"
            aria-label="Next day"
            disabled={overlay.date >= today()}
            onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, 1) })}
          >
            ▶
          </button>
        </div>
      )}
    </div>
  );
}
