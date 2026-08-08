import { useEffect, useState } from 'react';

import { apiFetch } from '../../transport/http.js';
import { useSelection } from '../../state/stores.js';

// "In the graph" — the Find panel's second answer.
//
// Find searches the LIVE store: what is being emitted right now, near a point.
// That silently excludes everything the operator already decided mattered,
// because a promoted object outlives the feed that produced it. Until
// GET /api/ontology/search existed there was no way to ask, so the panel could
// not have offered it; now not offering it is the omission.
//
// Same shape as the OrgCard group above it: keyed off the same search box,
// supplementary to the radius results rather than a second search UI.

interface OntObject {
  id: string;
  kind: string;
  props: Record<string, unknown>;
}

/** The most name-like property an object carries, for a one-line label. */
function label(o: OntObject): string {
  for (const key of ['name', 'callsign', 'title', 'label', 'registration']) {
    const v = o.props[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return o.id;
}

export function OntologyHits({ q, limit = 6 }: { q: string; limit?: number }): JSX.Element | null {
  const [hits, setHits] = useState<OntObject[] | null>(null);
  const select = useSelection((s) => s.select);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setHits(null);
      return;
    }
    const ac = new AbortController();
    // Debounced: every keystroke is an FTS query against the store.
    const id = window.setTimeout(() => {
      apiFetch(`/api/ontology/search?q=${encodeURIComponent(term)}&limit=${limit}`, {
        signal: ac.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<OntObject[]>) : Promise.reject(new Error('http'))))
        .then(setHits)
        // A keyless deployment with an empty graph, or a backend that did not
        // answer, both mean "nothing to show here" rather than an error the
        // operator can act on: the radius results above are unaffected.
        .catch(() => setHits(null));
    }, 250);
    return () => {
      window.clearTimeout(id);
      ac.abort();
    };
  }, [q, limit]);

  if (hits === null || hits.length === 0) return null;

  return (
    <div className="mt-[8px] border-t border-line pt-[8px]" data-testid="ontology-hits">
      <div className="px-[14px] mono text-[10px] uppercase tracking-[0.5px] text-txt-3">
        In the graph · {hits.length}
      </div>
      <ul>
        {hits.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => select(o.id)}
              className="w-full text-left px-[14px] py-[5px] hover:bg-[var(--hover)]"
            >
              <span className="block text-[12px] text-txt-1 truncate">{label(o)}</span>
              <span className="block mono text-[10px] text-txt-3 truncate">
                {o.kind} · {o.id}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
