// Shared precise-location entry. Replaces "click the map to place X" across the
// COP, annotation, situation and ground-recon panels: the operator types a
// coordinate ("51.9,4.4"), a place / port / airport name, or an IATA/ICAO code
// and the point is placed exactly — clicking the globe stays as a shortcut, not
// the only way. Resolves a free-text query through the same /api/search the top
// search bar uses (coords parsed locally, no round-trip).
import { useState } from 'react';
import * as Cesium from 'cesium';
import { search, LOCATION_KINDS } from '../transport/search.js';
import { flyToPosition } from './camera.js';
import { viewerCenter } from './center.js';

/** Parse "lat,lon" / "lat lon" → {lat,lon}, or null if it isn't a coordinate.
 *  (SimulationOverlay keeps its own two-field variant; this is the single-field
 *  form used by the shared widget — a 10-line parser not worth cross-importing.) */
export function parseLatLon(s: string): { lat: number; lon: number } | null {
  const parts = s.trim().split(/\s*,\s*|\s+/);
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

interface Props {
  viewer: Cesium.Viewer | null;
  /** Called with the resolved point. `label` is set for place/search hits. */
  onPlace: (lat: number, lon: number, label?: string) => void;
  placeholder?: string;
  /** Fly the camera to the placed point (default true). */
  fly?: boolean;
}

export function CoordEntry({ viewer, onPlace, placeholder, fly = true }: Props) {
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const place = (lat: number, lon: number, label?: string): void => {
    if (fly && viewer) flyToPosition(viewer, lon, lat, 200_000, 0.8);
    onPlace(lat, lon, label);
    setQ('');
    setErr(null);
  };

  const resolve = async (): Promise<void> => {
    const text = q.trim();
    if (!text) return;
    const ll = parseLatLon(text);
    if (ll) {
      place(ll.lat, ll.lon);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const results = await search(text);
      const hit = results[0];
      if (!hit) {
        setErr('no match');
        return;
      }
      place(hit.lat, hit.lon, LOCATION_KINDS.has(hit.kind) ? hit.label : undefined);
    } catch {
      setErr('search failed');
    } finally {
      setBusy(false);
    }
  };

  const useCentre = (): void => {
    const c = viewerCenter(viewer);
    if (c) place(c.lat, c.lon, 'map centre');
    else setErr('no map centre');
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void resolve();
            }
          }}
          placeholder={placeholder ?? 'lat,lon · place · airport / port · IATA/ICAO'}
          aria-label="coordinate or place name"
          className="flex-1 mono bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 focus:outline-none focus:border-accent-line"
        />
        <button
          type="button"
          onClick={() => void resolve()}
          disabled={busy}
          className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-1 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-txt-1 disabled:opacity-50"
        >
          {busy ? '…' : 'go'}
        </button>
        <button
          type="button"
          onClick={useCentre}
          title="Use current map centre"
          aria-label="use map centre"
          className="mono text-[11px] px-1.5 py-1 border border-line rounded-sm text-txt-2 hover:border-accent-line hover:text-txt-1"
        >
          ⌖
        </button>
      </div>
      {err && <div className="mono text-[10px] text-alert">{err}</div>}
    </div>
  );
}
