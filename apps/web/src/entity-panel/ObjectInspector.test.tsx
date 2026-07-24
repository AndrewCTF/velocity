// Component tests for ObjectInspector's Properties tab. apiFetch is mocked at
// the transport boundary (repo convention, see DossierNarrativeCard.test.tsx).
//
// riley-1 (docs/decisions.md finding): positionless ontology nodes (domain/ip/
// org/company-screening/…) never get plotted as a Cesium map entity, so the
// Cesium property lookup always read null for them — even though the backend
// persisted real props via POST /api/ontology/object (company-screening
// counts, in particular). These prove the ontology-fallback path (GET
// /api/ontology/object/{id}) renders those props, including a genuine zero
// count (must NOT be filtered out — "0 sanctions matches" is the whole point
// of a clean screening result), and that its loading/error/404 states degrade
// the way the rest of the panel does. `viewer={null}` stands in for "no
// Cesium entity was ever found for this id" without needing to boot Cesium.

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PropertiesTab } from './ObjectInspector.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

describe('PropertiesTab: ontology fallback for positionless nodes', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('shows the loading… micro-label while the ontology fetch is in flight', async () => {
    mockedFetch.mockImplementation(() => new Promise(() => {}));
    render(<PropertiesTab viewer={null} id="ext:organization:acme" />);
    expect(await screen.findByText('loading…')).toBeTruthy();
  });

  it('renders ontology props, including a zero-value screening count', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({
        id: 'ext:organization:acme',
        kind: 'object',
        props: {
          name: 'Acme Corp',
          sanctions_matches: 0,
          opencorporates_matches: 3,
          officers: 0,
        },
      }),
    );
    render(<PropertiesTab viewer={null} id="ext:organization:acme" />);
    expect(await screen.findByText('Acme Corp')).toBeTruthy();
    // A zero screening count must render, not disappear as "no value" — that
    // is the entire point of a clean screening result.
    expect(screen.getByText('sanctions_matches').closest('tr')?.textContent).toContain('0');
    expect(screen.getByText('officers').closest('tr')?.textContent).toContain('0');
    expect(screen.getByText('opencorporates_matches').closest('tr')?.textContent).toContain('3');
    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/ontology/object/ext%3Aorganization%3Aacme',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('keeps "No properties resolved." on a 404 (id in neither Cesium nor ontology)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ detail: 'object not found' }, 404));
    render(<PropertiesTab viewer={null} id="ext:organization:ghost" />);
    expect(await screen.findByText('No properties resolved.')).toBeTruthy();
  });

  it('renders a sentence with the HTTP code on a non-2xx, non-404 failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ detail: 'boom' }, 500));
    render(<PropertiesTab viewer={null} id="ext:organization:acme" />);
    expect(await screen.findByText('Properties unavailable (HTTP 500).')).toBeTruthy();
  });

  it('renders a network-error sentence when the fetch throws', async () => {
    mockedFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<PropertiesTab viewer={null} id="ext:organization:acme" />);
    expect(await screen.findByText('Properties unavailable. Network error.')).toBeTruthy();
  });
});
