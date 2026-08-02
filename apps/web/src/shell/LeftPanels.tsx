import { useState, type ReactNode } from 'react';
import { LEFT_PANELS, type LeftPanelId } from './panels.js';

export interface RailItem {
  id: string;
  label: string;
  content: ReactNode;
}

// The four named left panels, replacing the 18-icon rail.
//
// The old rail was eighteen unlabelled icons: a menu you learn by clicking
// every one of them, and one where `layers` and `allsources` were two views of
// the same registry sitting side by side. Four names, each on a number key,
// is a menu you read.
//
// Where the other fourteen went is recorded in panels.ts and asserted by
// panels.test.ts, so the consolidation is checkable rather than a claim.
// Anything this component is handed that does NOT belong to one of the four is
// still rendered, under "More" — a surface never disappears because it has not
// been re-homed yet.
const MEMBERS: Record<LeftPanelId, readonly string[]> = {
  layers: ['layers', 'allsources'],
  find: ['search-objects'],
  histogram: ['filters'],
  info: ['feeds', 'ops', 'acars', 'chokepoints'],
};

export function LeftPanels({
  items,
  initial = 'layers',
}: {
  items: readonly RailItem[];
  initial?: LeftPanelId;
}): JSX.Element {
  const [active, setActive] = useState<LeftPanelId | 'more'>(initial);
  const byId = new Map(items.map((i) => [i.id, i]));

  const claimed = new Set(Object.values(MEMBERS).flat());
  const leftovers = items.filter((i) => !claimed.has(i.id));

  const shown =
    active === 'more'
      ? leftovers
      : MEMBERS[active].map((id) => byId.get(id)).filter((x): x is RailItem => Boolean(x));

  return (
    <aside className="csl2-panel" aria-label="Map panels">
      <div className="csl2-tabs" role="tablist" style={{ borderBottom: '1px solid var(--line)' }}>
        {LEFT_PANELS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            className="csl2-tab"
            aria-selected={active === p.id}
            title={`${p.label} (${p.key})`}
            onClick={() => setActive(p.id)}
          >
            {p.label}
          </button>
        ))}
        {leftovers.length > 0 && (
          <button
            type="button"
            role="tab"
            className="csl2-tab"
            aria-selected={active === 'more'}
            title="Surfaces not yet re-homed"
            onClick={() => setActive('more')}
          >
            More
            <span className="csl2-badge">{leftovers.length}</span>
          </button>
        )}
      </div>
      <div className="csl2-panel-body">
        {shown.length === 0 ? (
          <div className="p-4 text-[12px] text-txt-3">Nothing to show in this panel.</div>
        ) : (
          shown.map((it) => (
            <section key={it.id} aria-label={it.label}>
              {/* A merged panel keeps its parts labelled, so "Info" does not
                  become an undifferentiated column of four other panels. */}
              {shown.length > 1 && (
                <div className="csl2-panel-head" style={{ height: 'var(--g-row-2)', fontSize: 'var(--fs-caption)', letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--txt-2)' }}>
                  {it.label}
                </div>
              )}
              {it.content}
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
