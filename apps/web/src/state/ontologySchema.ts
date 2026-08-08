// The ontology's declared shape, fetched once per session.
//
// A graph edge is stored one way (`src --officer_of--> dst`) but is read from
// whichever node the analyst is standing on, so every relation carries two
// names (`apps/api/app/intel/ontology_schema.py`). Without this the canvas
// printed the raw verb, which reads as a lie the moment you look at the edge
// from the target's end: `org --officer_of--> person` says the organisation is
// an officer of the person.
//
// ponytail: a module-scope promise, not a store. The payload is static per
// deployment, so there is nothing to invalidate and nobody to notify.
import { apiFetch } from '../transport/http.js';
import { useEffect, useState } from 'react';

export interface RelType {
  forward: string;
  inverse: string;
  src_kinds: string[];
  dst_kinds: string[];
}

export interface OntologySchema {
  relations: Record<string, RelType>;
  /** kind → property name → one of str|num|bool|ts|geo|id. */
  kinds: Record<string, Record<string, string>>;
}

let cached: OntologySchema | null = null;
let inflight: Promise<OntologySchema | null> | null = null;

/** Reset the module cache. Tests only. */
export function __resetOntologySchema(): void {
  cached = null;
  inflight = null;
}

export async function loadOntologySchema(): Promise<OntologySchema | null> {
  if (cached) return cached;
  if (!inflight) {
    inflight = apiFetch('/api/ontology/schema')
      .then((r) => (r.ok ? (r.json() as Promise<OntologySchema>) : null))
      .then((s) => {
        cached = s;
        return s;
      })
      // A missing schema is not an error the analyst can act on: relLabel falls
      // back to the raw verb, so the graph still reads. Retry on the next call.
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * The label for `rel`, read forwards or from the target's end.
 *
 * Falls back to the verb with its underscores opened up, which is also what the
 * backend does for a relation an analyst or a model invented.
 */
export function relLabel(
  schema: OntologySchema | null,
  rel: string,
  reverse = false,
): string {
  const rt = schema?.relations?.[rel];
  if (!rt) return rel.replace(/_/g, ' ');
  return reverse ? rt.inverse : rt.forward;
}

/** The schema, or null until it arrives. Never suspends, never throws. */
export function useOntologySchema(): OntologySchema | null {
  const [schema, setSchema] = useState<OntologySchema | null>(cached);
  useEffect(() => {
    if (cached) return;
    let live = true;
    void loadOntologySchema().then((s) => {
      if (live) setSchema(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return schema;
}
