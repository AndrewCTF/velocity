// Component tests for the coverage heat-strip. apiFetch is mocked at the
// transport boundary (mirrors CountriesPanel.test.tsx / OsintEntityPanel.test.tsx),
// routed by URL — no real network involved. The GET /api/history/coverage
// backend is live (routes/history.py); these tests exercise the frontend
// against its response shape (docs/replay-flagship-plan.md §2).

import { act, render, screen, waitFor } from '@testing-library/react';
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

  // Regression: the poll used to abort the in-flight request at the top of
  // every tick. On a real archive the coverage query runs far longer than
  // POLL_MS (measured 73 s over 78 M fixes), so every tick killed the previous
  // one and the strip never resolved — the chip sat on its fallback forever.
  // A slow query must be allowed to finish.
  it('lets a query slower than the poll interval finish instead of aborting it every tick', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch: ((r: Response) => void) | undefined;
      mockedFetch.mockReturnValue(
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
      );
      render(<CoverageStrip windowHours={168} />);
      expect(mockedFetch).toHaveBeenCalledTimes(1);

      // Several poll intervals elapse while the first request is still open.
      await vi.advanceTimersByTimeAsync(5_000 * 4);

      // No second request was issued, and nothing aborted the first.
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockedFetch.mock.calls[0] as [string, { signal: AbortSignal }];
      expect(init.signal.aborted).toBe(false);

      // The slow response finally lands and is rendered.
      await act(async () => {
        resolveFetch?.(jsonResponse(COVERAGE));
        await vi.advanceTimersByTimeAsync(0);
      });
      const strip = screen.getByRole('img', { name: /history coverage/i });
      expect(strip.querySelectorAll('rect').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
