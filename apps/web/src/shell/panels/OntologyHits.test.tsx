// Guards for the Find panel's "In the graph" group.
//
// It sits under the radius results, so the behaviour that matters is when it
// must stay out of the way: too short a query, no matches, or a backend that
// did not answer. Any of those rendering an empty box or an error strip would
// push the live results the operator actually asked for down the panel.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('../../transport/http.js', () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import('../../transport/http.js');
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const { OntologyHits } = await import('./OntologyHits.js');

const HIT = {
  id: 'vessel:636092000',
  kind: 'vessel',
  props: { name: 'EVER GIVEN', flag: 'PA' },
};

beforeEach(() => {
  mockFetch.mockReset();
  vi.useRealTimers();
});

function ok(rows: unknown[]) {
  mockFetch.mockResolvedValue({ ok: true, json: async () => rows });
}

describe('OntologyHits', () => {
  it('does not search for a query shorter than three characters', async () => {
    ok([HIT]);
    render(<OntologyHits q="ev" />);
    await new Promise((r) => setTimeout(r, 400));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ontology-hits')).toBeNull();
  });

  it('renders a hit with its most name-like property', async () => {
    ok([HIT]);
    render(<OntologyHits q="ever" />);
    await waitFor(() => expect(screen.getByTestId('ontology-hits')).toBeTruthy());
    expect(screen.getByText('EVER GIVEN')).toBeTruthy();
    expect(screen.getByText(/vessel · vessel:636092000/)).toBeTruthy();
  });

  it('falls back to the id when nothing name-like is present', async () => {
    ok([{ id: 'incident:abc', kind: 'incident', props: { score: 3 } }]);
    render(<OntologyHits q="abc" />);
    await waitFor(() => expect(screen.getByTestId('ontology-hits')).toBeTruthy());
    expect(screen.getAllByText(/incident:abc/).length).toBeGreaterThan(0);
  });

  it('renders nothing at all when the graph has no match', async () => {
    ok([]);
    render(<OntologyHits q="nothing" />);
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('ontology-hits')).toBeNull();
  });

  it('renders nothing when the backend does not answer', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    render(<OntologyHits q="ever" />);
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('ontology-hits')).toBeNull();
  });

  it('renders nothing on a non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => [] });
    render(<OntologyHits q="ever" />);
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByTestId('ontology-hits')).toBeNull();
  });

  it('debounces: one request for a query typed a character at a time', async () => {
    ok([HIT]);
    const { rerender } = render(<OntologyHits q="eve" />);
    rerender(<OntologyHits q="ever" />);
    rerender(<OntologyHits q="ever " />);
    rerender(<OntologyHits q="ever g" />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('q=ever%20g');
  });
});
