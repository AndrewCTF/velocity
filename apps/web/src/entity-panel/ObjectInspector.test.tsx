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

import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PropertiesTab, RegistryAndFilings } from './ObjectInspector.js';

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

// ── Registry and filings (T0 ↔ T2 join, gap-analysis-2026-09-13.md §6 rows 6-7) ─
// The block rides on /api/entity/{eid}: the ontology's assertions for the same
// id, tiered by source and lagged against the live fix. Rows render grouped by
// source; an empty block renders NOTHING (no "nothing here" canvas).
describe('RegistryAndFilings: the Tier-0 ↔ Tier-2 join under the kinematics', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  function registryBlock(): unknown {
    return {
      id: 'aircraft:4ca7b3',
      kind: 'aircraft',
      registration: 'EI-ABC',
      registry: {
        degraded: false,
        tiers: { 'registry:gleif': 'registry', adsb: 'sensor', gdelt: 'claim' },
        assertions: [
          {
            prop: 'operator',
            value: 'Ryanair Holdings plc',
            source: 'registry:gleif',
            confidence: 0.9,
            observed_at: '2026-09-17T05:00:00Z',
            derivation: { note: 'LEI parent' },
            tier: 'registry',
            lag_s: 10800,
          },
          {
            prop: 'callsign',
            value: 'RYR123',
            source: 'adsb',
            confidence: 1.0,
            observed_at: '2026-09-17T02:00:00Z',
            tier: 'sensor',
            lag_s: -21600,
          },
          {
            prop: 'sighting',
            value: null,
            source: 'gdelt',
            observed_at: '2026-09-17T02:00:00Z',
            tier: 'claim',
            lag_s: 0,
          },
        ],
      },
    };
  }

  it('renders the assertions grouped by source, each with its tier and lag', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(registryBlock()));
    render(<RegistryAndFilings id="aircraft:4ca7b3" />);

    expect(await screen.findByText('Registry and filings')).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledWith('/api/entity/aircraft%3A4ca7b3', expect.objectContaining({ cache: 'no-store' }));

    // group headers: tier chip + the source that said it
    expect(screen.getByText('registry:gleif')).toBeTruthy();
    expect(screen.getByText('adsb')).toBeTruthy();
    expect(screen.getByText('gdelt')).toBeTruthy();

    // prop = value · observed_at (UTC) · lag
    expect(screen.getByText('operator = Ryanair Holdings plc · 2026-09-17 05:00:00Z · +3 h after the fix')).toBeTruthy();
    expect(screen.getByText('callsign = RYR123 · 2026-09-17 02:00:00Z · 6 h before the fix')).toBeTruthy();
    // an unreported value is the lone '—', and a zero lag is not a fake "+0 s"
    expect(screen.getByText('sighting = — · 2026-09-17 02:00:00Z · at the fix')).toBeTruthy();
  });

  it('renders nothing when the block is empty (no "nothing here" canvas)', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ id: 'aircraft:4ca7b3', kind: 'aircraft', registry: { assertions: [], tiers: {}, degraded: true } }),
    );
    const { container } = render(<RegistryAndFilings id="aircraft:4ca7b3" />);
    // Let the fetch settle before asserting the empty render.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
    expect(screen.queryByText('Registry and filings')).toBeNull();
  });

  it('renders nothing when /api/entity has no registry block or the fetch fails', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ id: 'aircraft:4ca7b3', kind: 'aircraft' }));
    const first = render(<RegistryAndFilings id="aircraft:4ca7b3" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.container.textContent).toBe('');
    first.unmount();

    mockedFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const second = render(<RegistryAndFilings id="aircraft:4ca7b3" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(second.container.textContent).toBe('');
  });
});
