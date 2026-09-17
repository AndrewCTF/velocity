// Guard for the merge-review section (W2, entity resolution): the backend
// (app/routes/resolve.py) scores merge_candidates for operator review and
// never auto-merges. This locks in that InboxPanel polls the open queue via
// apiFetch — never a raw fetch — renders the count and each row, and that
// clicking Approve/Reject POSTs to the right URL and refreshes the list.
//
// Mocking convention mirrors CountriesPanel.test.tsx / AlertRulesSection.test.tsx:
// apiFetch is mocked at the transport boundary and routed by URL.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { InboxPanel } from './InboxPanel.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  } as unknown as Response;
}

const CANDIDATE = {
  id_a: 'vessel:111',
  id_b: 'vessel:222',
  reason: 'multiple_canonicals',
  score: 0.82,
  ts: 1_700_000_000,
  status: 'open',
  a_kind: 'vessel',
  a_name: 'Alpha',
  b_kind: 'vessel',
  b_name: 'Bravo',
};

function mockRoutes(overrides: { candidates?: unknown[]; approveStatus?: number } = {}) {
  mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = url.toString();
    if (u.startsWith('/api/watch-officer/briefs')) return jsonResponse({ briefs: [] });
    if (u.startsWith('/api/watch-officer/status')) return jsonResponse({});
    if (u === '/api/resolve/candidates?status=open' && (!init || !init.method)) {
      return jsonResponse(overrides.candidates ?? [CANDIDATE]);
    }
    // apiFetch's caller encodeURIComponent()s each id, so a colon (mmsi/icao24
    // ids are `vessel:<mmsi>`) shows up as %3A on the wire.
    if (
      u === '/api/resolve/candidates/vessel%3A111/vessel%3A222/approve' &&
      init?.method === 'POST'
    ) {
      const status = overrides.approveStatus ?? 200;
      return jsonResponse({ status: 'approved', ontology: 'linked same_as in the ontology' }, status);
    }
    if (
      u === '/api/resolve/candidates/vessel%3A111/vessel%3A222/reject' &&
      init?.method === 'POST'
    ) {
      return jsonResponse({ status: 'rejected', ontology: null });
    }
    return jsonResponse({ note: 'no data' }, 404);
  });
}

describe('InboxPanel merge review', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('polls the open queue and renders the count and a row', async () => {
    mockRoutes();
    render(<InboxPanel viewer={null} />);

    expect(await screen.findByText('Merge review · 1')).toBeInTheDocument();
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Bravo/)).toBeInTheDocument();
    expect(screen.getByText(/multiple_canonicals/)).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith('/api/resolve/candidates?status=open');
  });

  it('clicking Approve POSTs to the approve URL and refreshes', async () => {
    mockRoutes();
    render(<InboxPanel viewer={null} />);
    await screen.findByText('Merge review · 1');

    fireEvent.click(screen.getByText('approve'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        '/api/resolve/candidates/vessel%3A111/vessel%3A222/approve',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    // After a successful decide, the hook reloads the (now-empty) open queue.
    await waitFor(() => {
      expect(mockedFetch.mock.calls.filter(([u]) => u === '/api/resolve/candidates?status=open').length).toBeGreaterThan(1);
    });
  });

  it('clicking Reject POSTs to the reject URL', async () => {
    mockRoutes();
    render(<InboxPanel viewer={null} />);
    await screen.findByText('Merge review · 1');

    fireEvent.click(screen.getByText('reject'));

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        '/api/resolve/candidates/vessel%3A111/vessel%3A222/reject',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('shows nothing extra when the queue is empty', async () => {
    mockRoutes({ candidates: [] });
    render(<InboxPanel viewer={null} />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/resolve/candidates?status=open'));
    expect(screen.queryByText(/Merge review/)).not.toBeInTheDocument();
  });
});
