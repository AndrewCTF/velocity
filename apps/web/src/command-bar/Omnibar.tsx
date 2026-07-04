// ⌘K Omnibar — a unified jump palette over live entities + app actions.
//
// Type to fuzzy-match ACTIONS (open a workspace, show/hide a layer) and to
// search live ENTITIES (callsign / MMSI / name / lat,lon via the same /api/search
// the SearchField uses). Enter on an entity flies the camera + selects it; Enter
// on an action runs it. ⌘K toggles; ↑↓ navigate; Esc closes.

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import {
  search,
  KIND_BADGE_LABEL,
  KIND_BADGE_CLASS,
  LOCATION_KINDS,
  type SearchResult,
} from '../transport/search.js';
import { useSelection } from '../state/stores.js';
import { useUiMode, type UiMode } from '../state/uiMode.js';
import { flyToPosition } from '../globe/camera.js';
import type { LayerRegistry } from '../registry/LayerRegistry.js';

interface Action {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

// Lightweight fuzzy subsequence match (no dependency). Empty query matches.
function subseq(q: string, s: string): boolean {
  const a = q.toLowerCase();
  const b = s.toLowerCase();
  if (!a) return true;
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) i++;
  }
  return i >= a.length;
}

const MODES: [NonNullable<UiMode>, string][] = [
  ['tasking', 'Tasking'],
  ['targeting', 'Targeting'],
  ['fmv', 'FMV'],
  ['cop', 'COP Editor'],
];

export function Omnibar({
  viewer,
  registry,
}: {
  viewer: Cesium.Viewer | null;
  registry: LayerRegistry;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [ents, setEnts] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K toggles the palette (capture phase so it owns the gesture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced entity search.
  useEffect(() => {
    if (!open || !q.trim()) {
      setEnts([]);
      return;
    }
    const ab = new AbortController();
    const id = window.setTimeout(() => {
      search(q, ab.signal)
        .then((r) => setEnts(r.slice(0, 8)))
        .catch(() => undefined);
    }, 180);
    return () => {
      window.clearTimeout(id);
      ab.abort();
    };
  }, [q, open]);

  // Memoised on the (stable) registry so the downstream filter memo stays stable.
  const actions = useMemo<Action[]>(() => {
    const list: Action[] = [];
    for (const [m, label] of MODES) {
      list.push({
        id: `mode:${m}`,
        label: `Open ${label} workspace`,
        hint: 'mode',
        run: () => useUiMode.getState().setMode(m),
      });
    }
    for (const d of registry.list()) {
      const on = registry.isEnabled(d.id);
      list.push({
        id: `layer:${d.id}`,
        label: `${on ? 'Hide' : 'Show'} layer · ${d.title}`,
        hint: 'layer',
        run: () => (on ? registry.disable(d.id) : registry.enable(d.id)),
      });
    }
    return list;
  }, [registry]);

  const filteredActions = useMemo(() => {
    const term = q.trim();
    if (!term) return actions.filter((a) => a.hint === 'mode'); // default: workspaces
    return actions.filter((a) => subseq(term, a.label)).slice(0, 8);
  }, [actions, q]);

  type Item =
    | { type: 'action'; a: Action }
    | { type: 'entity'; e: SearchResult };
  const items = useMemo<Item[]>(
    () => [
      ...filteredActions.map((a) => ({ type: 'action' as const, a })),
      ...ents.map((e) => ({ type: 'entity' as const, e })),
    ],
    [filteredActions, ents],
  );

  const runItem = (it: Item): void => {
    if (it.type === 'action') {
      it.a.run();
    } else {
      const r = it.e;
      if (LOCATION_KINDS.has(r.kind)) useSelection.getState().select(null);
      else useSelection.getState().select(r.id);
      if (viewer && (r.lon !== 0 || r.lat !== 0)) {
        flyToPosition(viewer, r.lon, r.lat, (r.kind === 'chokepoint' ? 800 : 200) * 1000, 1.2);
      }
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-start justify-center pt-[12vh]"
      onMouseDown={() => setOpen(false)}
      role="dialog"
      aria-label="Command palette"
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-[560px] max-w-[92vw] bg-bg-1 border border-line-2 rounded-md shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const it = items[active];
              if (it) runItem(it);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder="Jump to entity, layer, or workspace…  (callsign / MMSI / name / lat,lon)"
          className="w-full bg-bg-2 border-b border-line-2 px-3 py-2.5 text-[13px] text-txt-0 placeholder:text-txt-3 mono focus:outline-none"
          aria-label="Command palette input"
        />
        <div className="max-h-[52vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-txt-3 mono">
              {q.trim() ? 'no match' : 'type to search entities · actions'}
            </div>
          )}
          {items.map((it, i) => {
            const sel = i === active;
            const label = it.type === 'action' ? it.a.label : it.e.label;
            const hint = it.type === 'action' ? it.a.hint : it.e.kind;
            const key = (it.type === 'action' ? it.a.id : `e:${it.e.id}`) + ':' + i;
            return (
              <button
                key={key}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => runItem(it)}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 ${sel ? 'bg-accent-dim' : ''}`}
              >
                {it.type === 'entity' ? (
                  <span className={KIND_BADGE_CLASS[it.e.kind]}>
                    {KIND_BADGE_LABEL[it.e.kind]}
                  </span>
                ) : (
                  <span className="mono text-[10px] uppercase w-12 shrink-0 text-warn">
                    {hint}
                  </span>
                )}
                <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
                  <span className="truncate text-[12px] text-txt-0">{label}</span>
                  {it.type === 'entity' && it.e.detail && (
                    <span className="truncate text-[10px] text-txt-3">{it.e.detail}</span>
                  )}
                </span>
                {it.type === 'entity' && (
                  <span className="mono text-[10px] text-txt-3 tabular-nums shrink-0">
                    {it.e.lat.toFixed(1)},{it.e.lon.toFixed(1)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="px-3 py-1.5 border-t border-line text-[10px] text-txt-4 mono flex gap-3">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span className="ml-auto">⌘K</span>
        </div>
      </div>
    </div>
  );
}
