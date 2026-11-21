import { useMemo, useState } from "react";
import type { ObjectResult } from "../../../transport/search.js";
import { deriveFacets } from "../../../explorer/facets.js";
import "./facetChecklist.css";

// FacetChecklist: D81 "Search-dialog facet checklist with counts and bars
// (flag state of the live vessels), matched field underlined in the results".
// Checklist rows for each flag state with a count and a bar proportional to
// the max. Reachable from the Explorer search dialog (live source).

export function FacetChecklist({
  results,
  checked,
  onToggle,
  query,
}: {
  results: readonly ObjectResult[];
  checked: ReadonlySet<string>;
  onToggle: (flag: string) => void;
  query?: string;
}): React.JSX.Element {
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) {
      const props = (r as unknown as { props?: Record<string, unknown> }).props ?? {};
      const { flag } = deriveFacets(props);
      const k = flag ?? "other";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((a, b) => b.count - a.count);
  }, [results]);

  const max = counts[0]?.count ?? 1;

  const highlighted = (label: string): React.ReactNode => {
    if (!query || !label.toLowerCase().includes(query.toLowerCase())) return label;
    const idx = label.toLowerCase().indexOf(query.toLowerCase());
    return (
      <>
        {label.slice(0, idx)}
        <u>{label.slice(idx, idx + query.length)}</u>
        {label.slice(idx + query.length)}
      </>
    );
  };

  return (
    <div className="mv-facet-checklist" role="group" aria-label="Flag facets">
      {counts.map(({ flag, count }) => {
        const on = checked.has(flag);
        return (
          <label key={flag} className={`mv-facet-row${on ? " is-on" : ""}`}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(flag)}
              aria-label={flag}
            />
            <span className="mv-facet-name">{highlighted(flag)}</span>
            <span className="mv-facet-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((count / max) * 100)}%` }} />
            </span>
            <span className="mv-facet-count">{count.toLocaleString()}</span>
          </label>
        );
      })}
      {counts.length === 0 && (
        <div className="mv-facet-empty">No vessels in view</div>
      )}
    </div>
  );
}

export function useFacetChecked(): [ReadonlySet<string>, (flag: string) => void] {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const toggle = (flag: string): void =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  return [checked, toggle];
}
