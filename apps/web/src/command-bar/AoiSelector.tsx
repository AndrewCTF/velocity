import { useState, useRef, useEffect } from 'react';
import { chokepoints, type Chokepoint } from '../registry/chokepoints.js';
import { useAoi } from '../state/aoi.js';

interface Props {
  onPick: (c: Chokepoint | null) => void;
}

const CATEGORY_LABELS: Record<Chokepoint['category'], string> = {
  maritime: 'Maritime',
  cable: 'Sub-cable',
  aviation: 'Aviation',
  'air-corridor': 'Air corridor',
};

export function AoiSelector({ onPick }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const active = useAoi((s) => s.active);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = chokepoints.filter(
    (c) =>
      c.name.toLowerCase().includes(filter.toLowerCase()) ||
      c.region.toLowerCase().includes(filter.toLowerCase()),
  );
  const grouped = filtered.reduce<Record<string, Chokepoint[]>>((acc, c) => {
    (acc[c.category] ||= []).push(c);
    return acc;
  }, {});

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mono text-[11px] bg-bg-2 border border-line rounded-sm px-2 py-1 text-txt-1 hover:border-accent-line min-w-[180px] text-left flex items-center justify-between gap-2"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{active ? active.name : 'AOI · global'}</span>
        <span aria-hidden className="micro text-txt-3">▾</span>
      </button>
      {open && (
        <div
          className="absolute z-[var(--z-dropdown)] top-full mt-1 left-0 w-[520px] max-w-[92vw] bg-bg-1 border border-line rounded-md"
          style={{
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.05), inset 0 -1px 0 rgba(0,0,0,0.5)',
          }}
        >
          <div className="p-2 border-b border-line flex items-center gap-2">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter chokepoints…"
              className="mono flex-1 bg-bg-2 border border-line rounded-sm px-2 py-1 text-[11px] text-txt-0 placeholder:text-txt-3 focus:outline-none focus:border-accent-line"
            />
            <button
              type="button"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
              className="micro text-txt-2 hover:text-accent"
            >
              clear
            </button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1">
            {Object.entries(grouped).map(([cat, list]) => (
              <section key={cat} className="mb-2">
                <h3 className="micro px-2 pt-1">{CATEGORY_LABELS[cat as Chokepoint['category']]}</h3>
                <ul>
                  {list.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(c);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-2 py-2 rounded-sm hover:bg-bg-2 ${
                          active?.id === c.id ? 'bg-bg-2 border-l-2 border-accent' : ''
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[12px] text-txt-0">{c.name}</span>
                          <span className="micro">{c.region}</span>
                        </div>
                        <p className="text-[10.5px] text-txt-2 mt-0.5 leading-tight">{c.significance}</p>
                        <div className="flex gap-3 mt-1">
                          {c.daily_transits != null && (
                            <span className="micro">
                              <span className="mono text-txt-1">{c.daily_transits}</span> transits/d
                            </span>
                          )}
                          {c.oil_flow_mbpd != null && (
                            <span className="micro">
                              <span className="mono text-txt-1">{c.oil_flow_mbpd}</span> mbpd
                            </span>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {filtered.length === 0 && <p className="micro p-3">no chokepoint matches "{filter}"</p>}
          </div>
        </div>
      )}
    </div>
  );
}
