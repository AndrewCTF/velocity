// Deterministic render test for the country-OSINT catalog panel. Mirrors the
// mocking convention in OsintEntityPanel.test.tsx: apiFetch is mocked at the
// transport boundary and routed by URL, no real network involved.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CountriesPanel } from './CountriesPanel.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { useSelection } from '../state/stores.js';

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
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const LIST = {
  count: 2,
  regions: ['Oceania', 'Europe'],
  categories: ['business-registry', 'open-data'],
  countries: [
    {
      code: 'au',
      name: 'Australia',
      region: 'Oceania',
      iso2: 'AU',
      source_url: 'https://unishka.substack.com/p/osint-of-australia',
      resource_count: 2,
      category_counts: { 'business-registry': 1, 'open-data': 1 },
    },
    {
      code: 'gb',
      name: 'United Kingdom',
      region: 'Europe',
      iso2: 'GB',
      source_url: 'https://unishka.substack.com/p/osint-of-united-kingdom',
      resource_count: 1,
      category_counts: { 'open-data': 1 },
    },
  ],
};

const AU_DETAIL = {
  code: 'au',
  name: 'Australia',
  region: 'Oceania',
  iso2: 'AU',
  source_url: 'https://unishka.substack.com/p/osint-of-australia',
  resources: [
    {
      name: 'ABN Lookup',
      url: 'https://abr.business.gov.au',
      category: 'business-registry',
      note: 'official company register',
      keyless: true,
    },
    {
      name: 'data.gov.au',
      url: 'https://data.gov.au',
      category: 'open-data',
      note: 'national open-data portal',
      keyless: true,
    },
  ],
};

function mockRoutes(overrides: { ingestStatus?: number } = {}) {
  mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = url.toString();
    if (u === '/api/osint/countries') return jsonResponse(LIST);
    if (u === '/api/osint/countries/au' && (!init || init.method === undefined)) return jsonResponse(AU_DETAIL);
    if (u === '/api/osint/countries/au/ingest' && init?.method === 'POST') {
      const status = overrides.ingestStatus ?? 200;
      if (status === 401) return jsonResponse({ detail: 'unauthorized' }, 401);
      return jsonResponse({ root: 'country:au', objects: 3, links: 2 }, status);
    }
    return jsonResponse({ note: 'no data' }, 404);
  });
}

describe('CountriesPanel', () => {
  it('renders the country list grouped by region on mount', async () => {
    mockRoutes();
    render(<CountriesPanel />);
    expect(await screen.findByText(/Australia/)).toBeInTheDocument();
    expect(screen.getByText(/United Kingdom/)).toBeInTheDocument();
    expect(screen.getByText(/Oceania/)).toBeInTheDocument();
    expect(screen.getByText(/Europe/)).toBeInTheDocument();
    expect(mockedFetch).toHaveBeenCalledWith('/api/osint/countries');
  });

  it('selecting a country fetches and shows its resources grouped by category', async () => {
    mockRoutes();
    render(<CountriesPanel />);
    const auRow = await screen.findByText(/Australia/);
    fireEvent.click(auRow);

    expect(await screen.findByText('ABN Lookup')).toBeInTheDocument();
    expect(screen.getByText('data.gov.au')).toBeInTheDocument();
    expect(screen.getByText('official company register')).toBeInTheDocument();
    // "business-registry" / "open-data" appear both as category-section headers
    // and as options in the category <select> — assert at least one of each.
    expect(screen.getAllByText('business-registry').length).toBeGreaterThan(0);
    expect(screen.getAllByText('open-data').length).toBeGreaterThan(0);

    const link = screen.getByText('ABN Lookup').closest('a');
    expect(link).toHaveAttribute('href', 'https://abr.business.gov.au');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Ingest posts to /{code}/ingest then selects and centres the investigation graph', async () => {
    mockRoutes();
    render(<CountriesPanel />);
    fireEvent.click(await screen.findByText(/Australia/));
    await screen.findByText('ABN Lookup');

    const before = useInvestigation.getState().openSeq;
    fireEvent.click(screen.getByText('Ingest'));

    await waitFor(() => {
      expect(screen.getByText(/3 objects · 2 links/)).toBeInTheDocument();
    });
    expect(mockedFetch).toHaveBeenCalledWith('/api/osint/countries/au/ingest', expect.objectContaining({ method: 'POST' }));
    expect(useSelection.getState().selectedEntityId).toBe('country:au');
    expect(useInvestigation.getState().rootId).toBe('country:au');
    expect(useInvestigation.getState().openSeq).toBe(before + 1);
  });

  it('Ingest shows "Sign in to persist" on a 401', async () => {
    mockRoutes({ ingestStatus: 401 });
    render(<CountriesPanel />);
    fireEvent.click(await screen.findByText(/Australia/));
    await screen.findByText('ABN Lookup');

    fireEvent.click(screen.getByText('Ingest'));
    expect(await screen.findByText('Sign in to persist')).toBeInTheDocument();
  });

  it('the free-text filter narrows the country list', async () => {
    mockRoutes();
    render(<CountriesPanel />);
    await screen.findByText(/Australia/);
    fireEvent.change(screen.getByPlaceholderText('Filter countries / resources…'), {
      target: { value: 'kingdom' },
    });
    expect(screen.getByText(/United Kingdom/)).toBeInTheDocument();
    expect(screen.queryByText(/Australia/)).not.toBeInTheDocument();
  });
});
