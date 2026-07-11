// Component tests for the coverage heat-strip. apiFetch is mocked at the
// transport boundary (mirrors CountriesPanel.test.tsx / OsintEntityPanel.test.tsx),
// routed by URL — no real network involved. The backend for
// GET /api/history/coverage is being built in a parallel slice, so these tests
// exercise the frontend purely against the documented response shape
// (docs/replay-flagship-plan.md §2).

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoverageStrip, type Coverage } from './CoverageStrip.js';

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

const COVERAGE: Coverage = {
  recording_since: 1_750_000_000,
  total_bytes: 2_400_000_000, // ~2.24 GB
  row_count: 1_234_567,
  buckets: [
    { t: 1_750_000_000, count: 10 },
    { t: 1_750_003_600, count: 40 },
    { t: 1_750_007_200, count: 0 },
  ],
};

describe('CoverageStrip', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('fetches /api/history/coverage with a window/bucket query and renders one bar per non-zero bucket', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(COVERAGE));
    render(<CoverageStrip windowHours={168} />);

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalled();
    });
    const [url] = mockedFetch.mock.calls[0] as [string];
    expect(url).toMatch(/^\/api\/history\/coverage\?window_hours=168&bucket_hours=\d+$/);

    const strip = await screen.findByRole('img', { name: /history coverage/i });
    // Two non-zero buckets → two <rect> bars; the zero-count bucket renders nothing.
    await waitFor(() => {
      expect(strip.querySelectorAll('rect').length).toBe(2);
    });
  });

  it('lifts the coverage totals up via onCoverage', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(COVERAGE));
    const onCoverage = vi.fn();
    render(<CoverageStrip windowHours={168} onCoverage={onCoverage} />);

    await waitFor(() => {
      expect(onCoverage).toHaveBeenCalledWith(COVERAGE);
    });
  });

  it('clamps window_hours to the route ceiling for an uncapped archive-mode retention', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(COVERAGE));
    render(<CoverageStrip windowHours={50_000} />);

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalled();
    });
    const [url] = mockedFetch.mock.calls[0] as [string];
    expect(url).toContain('window_hours=8760');
  });

  it('renders an empty strip and does not throw when the endpoint fails', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));
    render(<CoverageStrip windowHours={168} />);

    const strip = await screen.findByRole('img', { name: /history coverage/i });
    expect(strip.querySelectorAll('rect').length).toBe(0);
  });
});
