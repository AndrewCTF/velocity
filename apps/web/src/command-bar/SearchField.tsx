import { useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import {
  search,
  KIND_BADGE_LABEL,
  KIND_BADGE_CLASS,
  LOCATION_KINDS,
  type SearchResult,
} from '../transport/search.js';
import { useSelection, useSearchTarget } from '../state/stores.js';
import { flyToPosition } from '../globe/camera.js';

interface Props {
  viewer: Cesium.Viewer | null;
}

export function SearchField({ viewer }: Props): JSX.Element {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // `/` global focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Debounced query
  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const aborter = new AbortController();
    const id = window.setTimeout(() => {
      search(q, aborter.signal)
        .then((res) => {
          setResults(res);
          setActive(0);
        })
        .catch(() => undefined);
    }, 140);
    return () => {
      window.clearTimeout(id);
      aborter.abort();
    };
  }, [q]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (r: SearchResult) => {
    const located = r.lon !== 0 || r.lat !== 0;
    if (LOCATION_KINDS.has(r.kind)) {
      // Static location — no live entity to select. Drop a pinned marker at the
      // exact coordinate so the operator sees WHICH icon they searched for.
      useSelection.getState().select(null);
      useSearchTarget.getState().setTarget(
        located ? { lon: r.lon, lat: r.lat, label: r.label, kind: r.kind } : null,
      );
    } else {
      // Live entity — the selection reticle locks onto it; retire any search pin.
      useSelection.getState().select(r.id);
      useSearchTarget.getState().setTarget(null);
    }
    if (viewer && located) {
      const altKm = r.kind === 'chokepoint' ? 800 : 200;
      flyToPosition(viewer, r.lon, r.lat, altKm * 1000, 1.2);
    }
    setOpen(false);
    setQ('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const LATLON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,/\s]\s*(-?\d+(?:\.\d+)?)\s*$/;
      const m = q.match(LATLON_RE);
      if (m && m[1] && m[2]) {
        const lat = parseFloat(m[1]);
        const lon = parseFloat(m[2]);
        if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
          // A valid coordinate is fully handled here — fly if we have a viewer,
          // and ALWAYS return so it never falls through to pick a coincidental
          // result for a coordinate-looking string.
          useSelection.getState().select(null);
          useSearchTarget.getState().setTarget({
            lon,
            lat,
            label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
            kind: 'place',
          });
          if (viewer) flyToPosition(viewer, lon, lat, 200_000, 1.2);
          setOpen(false);
          setQ('');
          return;
        }
      }
      const r = results[active];
      if (r) pick(r);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQ('');
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={containerRef} className="relative w-80">
      <input
        ref={inputRef}
        type="text"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder="search airport / port / callsign / MMSI / ICAO24 / lat,lon  (press /)"
        className="mono w-full bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-1 placeholder:text-txt-3 focus:outline-none focus:border-accent-line"
        aria-label="Unified search"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && results.length > 0 && (
        <div
          className="absolute z-50 top-full mt-1 left-0 w-[420px] bg-bg-1 border border-line rounded-md max-h-[60vh] overflow-y-auto"
          style={{
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.5)',
          }}
        >
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r)}
              className={`w-full text-left px-2 py-2 flex items-center gap-3 ${i === active ? 'bg-bg-2' : ''}`}
            >
              <span className={KIND_BADGE_CLASS[r.kind]}>{KIND_BADGE_LABEL[r.kind]}</span>
              <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                <span className="truncate text-[12px] text-txt-0">{r.label}</span>
                {r.detail && (
                  <span className="truncate text-[10px] text-txt-3">{r.detail}</span>
                )}
              </span>
              <span className="mono micro tabular-nums">
                {r.lat.toFixed(2)},{r.lon.toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim() && results.length === 0 && (
        <div className="absolute z-50 top-full mt-1 left-0 w-[420px] bg-bg-1 border border-line rounded-md px-3 py-2 micro">
          no match
        </div>
      )}
    </div>
  );
}
