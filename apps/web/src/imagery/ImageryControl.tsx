import { useEffect, useState } from 'react';

import { useImagery } from '../state/stores.js';
import { apiFetch } from '../transport/http.js';

interface CatalogLayer {
  id: string;
  title: string;
  group: string;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Keyless NASA GIBS imagery overlay picker + day stepper. Drives the
// useImagery store's `overlay`, which GlobeCanvas renders on the globe.
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

  return (
    <div className="imagery-control">
      <label className="imagery-control__row">
        <span>Satellite imagery</span>
        <select
          value={overlay?.layer ?? ''}
          onChange={(e) =>
            setOverlay(e.target.value ? { layer: e.target.value, date } : null)
          }
        >
          <option value="">Off</option>
          {layers.map((l) => (
            <option key={l.id} value={l.id}>
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
