import { useEffect, useRef, useState } from 'react';
import { Icon } from '../normal/Icon.js';
import { AC_CAT_LABELS, VES_TYPE_LABELS, bucketLabel } from '../explorer/facets.js';
import { useFilters, useSelection, type FilterFacet } from '../state/stores.js';

// ActionBar — the strip under the body that states the current query and
// carries the verbs on it.
//
// It used to be four literals. A "Filter contact type" button with no handler,
// the sentence "Showing all contact types across the current view" hardcoded so
// it stayed true of nothing the moment a filter was set, a "Clear selection"
// button that cleared nothing, and an accent-filled primary "Add to filter
// path" for a capability that does not exist. Four controls in the most
// prominent row after the title bar, none of them wired.
//
// Everything below runs against `useFilters` and `useSelection`, which the map
// adapter already evaluates against, so setting a type here removes contacts
// from the globe. Nothing is invented: the two facets offered are the two the
// filter evaluator understands for "contact type", and their values come from
// the same label tables the histogram bars use, so a chip here names exactly
// what a bar there counts.

const TYPE_FACETS: ReadonlyArray<{ facet: FilterFacet; group: string; labels: Record<string, string> }> = [
  { facet: 'aircraftCategory', group: 'Aircraft', labels: AC_CAT_LABELS },
  { facet: 'vesselType', group: 'Vessels', labels: VES_TYPE_LABELS },
];

/** A clause named so it is unambiguous outside its menu group. Both facets
 *  carry a `military` bucket, so the bare bucket label reads "Military" for two
 *  different filters and a chip could not be told from its twin. */
function clauseLabel(facet: FilterFacet, value: string): string {
  const base = bucketLabel(facet, value);
  if (facet === 'aircraftCategory') return `${base} aircraft`;
  if (facet === 'vesselType') return `${base} vessels`;
  return base;
}

/** The query as English. Clauses on one facet are an OR; facets AND together. */
function describe(clauses: ReturnType<typeof useFilters.getState>['clauses']): JSX.Element {
  if (clauses.length === 0) {
    return (
      <>
        Showing <b>all contact types</b> across the current view
      </>
    );
  }
  const only = clauses.filter((c) => c.mode === 'only');
  const not = clauses.filter((c) => c.mode === 'not');
  const join = (xs: string[], word: string): string =>
    xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
  const onlyText = join(
    only.map((c) => clauseLabel(c.facet, c.value)),
    'or',
  );
  const notText = join(
    not.map((c) => clauseLabel(c.facet, c.value)),
    'and',
  );
  return (
    <>
      Showing {only.length > 0 ? <b>{onlyText}</b> : <b>all contact types</b>}
      {not.length > 0 ? (
        <>
          , hiding <b>{notText}</b>
        </>
      ) : null}{' '}
      across the current view
    </>
  );
}

export function ActionBar(): JSX.Element {
  const clauses = useFilters((s) => s.clauses);
  const toggleClause = useFilters((s) => s.toggleClause);
  const removeClause = useFilters((s) => s.removeClause);
  const clearFilters = useFilters((s) => s.clear);
  const selected = useSelection((s) => s.selectedEntityId);
  const select = useSelection((s) => s.select);
  const [open, setOpen] = useState(false);

  // Same close-on-outside/Escape contract the title-bar menus use. A dropdown
  // that only closes when you pick something is a trap.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title="Restrict the map to particular aircraft categories or vessel types"
          className={`flex h-6 items-center gap-[6px] rounded-sm border px-[9px] text-[12px] ${
            clauses.length > 0
              ? 'border-accent-line bg-accent-dim text-accent-fg'
              : 'border-line-2 text-txt-1 hover:bg-[var(--hover)]'
          }`}
        >
          <Icon name="filter" className="h-3 w-3" />
          Filter contact type
          {clauses.length > 0 && <span className="mono">{clauses.length}</span>}
          <Icon name="chevron-down" className="h-3 w-3" />
        </button>
        {open && (
          <div
            role="menu"
            aria-label="Contact type"
            className="absolute bottom-[30px] left-0 z-[var(--z-dropdown)] max-h-[60vh] w-[240px] overflow-auto rounded-sm border border-line-2 bg-bg-2 py-1 shadow-[var(--sh-pop)]"
          >
            {TYPE_FACETS.map(({ facet, group, labels }) => (
              <div key={facet}>
                <div className="px-[14px] pb-[3px] pt-[6px] text-[12px] uppercase tracking-[0.6px] text-txt-3">
                  {group}
                </div>
                {Object.entries(labels).map(([value, label]) => {
                  const on = clauses.some(
                    (c) => c.facet === facet && c.value === value && c.mode === 'only',
                  );
                  return (
                    <button
                      key={value}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={on}
                      // The visible label is short because the group heading
                      // above it supplies the rest. A screen reader reads the
                      // item out of that context, and both groups carry a
                      // `military` bucket, so the accessible name has to be the
                      // qualified one or two items announce identically.
                      aria-label={clauseLabel(facet, value)}
                      onClick={() => toggleClause(facet, value, 'only')}
                      className="flex w-full items-center gap-2 px-[10px] py-[5px] text-left text-[12px] text-txt-1 hover:bg-[var(--hover)] hover:text-txt-0"
                    >
                      <Icon
                        name="check"
                        className={`h-3 w-3 shrink-0 ${on ? 'text-accent-fg' : 'invisible'}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      <span className="csl2-sentence">{describe(clauses)}</span>

      {/* Each active clause as a removable chip. Without these the only way to
          undo one filter was to reopen the menu and remember which one you set. */}
      {clauses.map((c) => (
        <button
          key={`${c.facet}:${c.value}:${c.mode}`}
          type="button"
          onClick={() => removeClause(c.facet, c.value, c.mode)}
          title={`Remove this ${c.mode === 'only' ? 'include' : 'exclude'} filter`}
          className="flex h-6 shrink-0 items-center gap-[5px] rounded-sm border border-accent-line bg-accent-dim px-[8px] text-[12px] text-accent-fg hover:brightness-125"
        >
          {c.mode === 'not' ? 'not ' : ''}
          {clauseLabel(c.facet, c.value)}
          <Icon name="x" className="h-3 w-3" />
        </button>
      ))}

      <span className="flex-1" />

      <button
        type="button"
        disabled={!selected}
        onClick={() => select(null)}
        title={selected ? `Deselect ${selected}` : 'Nothing is selected.'}
        className={`h-6 rounded-sm border border-line-2 px-[9px] text-[12px] ${
          selected ? 'text-txt-1 hover:bg-[var(--hover)]' : 'cursor-not-allowed text-txt-3'
        }`}
      >
        Clear selection
      </button>
      <button
        type="button"
        disabled={clauses.length === 0}
        onClick={() => clearFilters()}
        title={clauses.length > 0 ? 'Drop every contact-type filter' : 'No filters are set.'}
        className={`flex h-6 items-center gap-[6px] rounded-sm px-[11px] text-[12px] ${
          clauses.length > 0
            ? 'bg-accent text-white hover:brightness-110'
            : 'cursor-not-allowed border border-line-2 text-txt-3'
        }`}
      >
        <Icon name="x" className="h-3 w-3" />
        Clear filters
      </button>
    </>
  );
}
