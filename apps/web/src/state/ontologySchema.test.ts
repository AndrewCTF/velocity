// Guards for the ontology-schema label lookup.
//
// The behaviour that matters is the fallback path: the graph has to stay
// readable when the schema has not arrived yet, when the deployment answers
// 404, and when a relation was invented by an analyst or a language model
// (routes/extract.py mints model-authored rels) and so is not declared at all.
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

import {
  __resetOntologySchema,
  loadOntologySchema,
  relLabel,
  type OntologySchema,
} from './ontologySchema.js';

const SCHEMA: OntologySchema = {
  relations: {
    officer_of: {
      forward: 'officer of',
      inverse: 'has officer',
      src_kinds: ['person'],
      dst_kinds: ['org'],
    },
    same_as: { forward: 'same as', inverse: 'same as', src_kinds: [], dst_kinds: [] },
  },
  kinds: { aircraft: { callsign: 'str' } },
};

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));
const { apiFetch } = await import('../transport/http.js');
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetOntologySchema();
  mockFetch.mockReset();
});
afterEach(() => {
  __resetOntologySchema();
});

describe('relLabel', () => {
  it('reads a relation forwards', () => {
    expect(relLabel(SCHEMA, 'officer_of')).toBe('officer of');
  });

  it('reads a relation from the target end', () => {
    expect(relLabel(SCHEMA, 'officer_of', true)).toBe('has officer');
  });

  it('reads a symmetric relation the same both ways', () => {
    expect(relLabel(SCHEMA, 'same_as')).toBe(relLabel(SCHEMA, 'same_as', true));
  });

  it('opens up an undeclared relation rather than printing snake_case', () => {
    expect(relLabel(SCHEMA, 'model_invented_this')).toBe('model invented this');
    expect(relLabel(SCHEMA, 'model_invented_this', true)).toBe('model invented this');
  });

  it('still renders before the schema has loaded', () => {
    expect(relLabel(null, 'officer_of')).toBe('officer of');
    expect(relLabel(null, 'has_subdomain')).toBe('has subdomain');
  });
});

describe('loadOntologySchema', () => {
  it('fetches once and caches', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => SCHEMA });
    expect(await loadOntologySchema()).toEqual(SCHEMA);
    expect(await loadOntologySchema()).toEqual(SCHEMA);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('answers null on a non-ok response instead of throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await loadOntologySchema()).toBeNull();
  });

  it('answers null when the request itself fails', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    expect(await loadOntologySchema()).toBeNull();
  });

  it('retries after a failure rather than caching it', async () => {
    mockFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await loadOntologySchema()).toBeNull();
    mockFetch.mockResolvedValue({ ok: true, json: async () => SCHEMA });
    expect(await loadOntologySchema()).toEqual(SCHEMA);
  });
});
