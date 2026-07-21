// Render tests for the Markets app. apiFetch is mocked at the transport
// boundary (repo convention, see country/CountryApp.test.tsx) so nothing hits
// a live backend. Covers: snapshot sections rendering from a mocked payload,
// the stress score + component bars, predictions rows, and graceful
// degradation when an endpoint 404s / reports unavailable.
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MarketsApp } from './MarketsApp.js';
import type { PredictionsResponse, SnapshotResponse, StressResponse } from './types.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const SNAPSHOT: SnapshotResponse = {
  indices: [{ symbol: 'SPX', name: 'S&P 500', last: 5123.45, change_pct_24h: 1.2, ts: '2026-07-21T00:00:00Z' }],
  commodities: [{ symbol: 'CL', name: 'Crude Oil', last: 78.1, change_pct_24h: -0.8, ts: '2026-07-21T00:00:00Z' }],
  fx: [{ symbol: 'EURUSD', name: 'Euro / US Dollar', last: 1.09, change_pct_24h: null, ts: null }],
  crypto: [{ symbol: 'BTC', name: 'Bitcoin', last: 61000, change_pct_24h: 3.4, ts: '2026-07-21T00:00:00Z' }],
  asof_utc: '2026-07-21T00:00:00Z',
};

const STRESS: StressResponse = {
  score: 42,
  components: [
    { key: 'vix', value: 18.2, normalized: 0.4, weight: 0.5, inputs: { level: 18.2 } },
    { key: 'credit_spread', value: 1.1, normalized: 0.3, weight: 0.5 },
  ],
  asof_utc: '2026-07-21T00:00:00Z',
};

const PREDICTIONS: PredictionsResponse = {
  items: [{ question: 'Will X happen by year end?', prob: 0.62, volume_24h: 125_000, url: 'https://example.com/m' }],
};

describe('MarketsApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders snapshot sections, stress score + components, and predictions', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes('/api/markets/snapshot')) return jsonResponse(SNAPSHOT);
      if (u.includes('/api/markets/stress')) return jsonResponse(STRESS);
      if (u.includes('/api/markets/predictions')) return jsonResponse(PREDICTIONS);
      return jsonResponse({});
    });

    render(<MarketsApp />);

    await waitFor(() => {
      expect(screen.getByText('S&P 500')).toBeTruthy();
    });
    expect(screen.getByText('Crude Oil')).toBeTruthy();
    expect(screen.getByText('Euro / US Dollar')).toBeTruthy();
    expect(screen.getByText('Bitcoin')).toBeTruthy();
    // FX row has no change_pct → dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByText('42')).toBeTruthy();
    });
    expect(screen.getByText('vix')).toBeTruthy();
    expect(screen.getByText('credit_spread')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Will X happen by year end?')).toBeTruthy();
    });
    expect(screen.getByText('62%')).toBeTruthy();
  });

  it('degrades gracefully when an endpoint 404s', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes('/api/markets/snapshot')) return jsonResponse({}, false, 404);
      if (u.includes('/api/markets/stress')) return jsonResponse(STRESS);
      if (u.includes('/api/markets/predictions')) return jsonResponse({ items: [], unavailable: true });
      return jsonResponse({});
    });

    render(<MarketsApp />);

    await waitFor(() => {
      expect(screen.getByText(/Markets unavailable \(HTTP 404\)/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText(/Predictions unavailable/)).toBeTruthy();
    });
    // Stress still renders even though snapshot/predictions degraded.
    expect(screen.getByText('42')).toBeTruthy();
  });
});
