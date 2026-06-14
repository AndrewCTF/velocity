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

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  const [layers, setLayers] = useState<CatalogLayer[]>([]);

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
        <button
          type="button"
          onClick={() => setLod1Aoi(lod1Aoi ? null : 'beirut-dahieh')}
          title="Curated war-damage AOI: red = Sentinel-1 SAR collapse candidate"
        >
          {lod1Aoi ? 'Hide war-damage 3D' : 'War-damage 3D — Beirut Dahieh'}
        </button>
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
