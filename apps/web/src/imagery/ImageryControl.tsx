import { useEffect, useState } from 'react';

import { useImagery } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';

interface CatalogLayer {
  provider: string;
  id: string;
  title: string;
  group: string;
  max_z: number;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Satellite imagery overlay picker + day stepper. Drives the useImagery store's
// `overlay` (provider + layer + date), which GlobeCanvas renders on the globe.
// Lists keyless GIBS + keyed CDSE Sentinel layers from /api/imagery/catalog.
export function ImageryControl() {
  const overlay = useImagery((s) => s.overlay);
  const setOverlay = useImagery((s) => s.setOverlay);
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

  const date = overlay?.date ?? today();
  const selectedKey = overlay ? `${overlay.provider}:${overlay.layer}` : '';

  return (
    <div className="imagery-control">
      <label className="imagery-control__row">
        <span>Satellite imagery</span>
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
          {layers.map((l) => (
            <option key={`${l.provider}:${l.id}`} value={`${l.provider}:${l.id}`}>
              {l.title}
            </option>
          ))}
        </select>
      </label>
      {overlay && (
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
