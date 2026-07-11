// Component tests for the ownership chip + coverage heat-strip wiring in
// Timeline.tsx (docs/replay-flagship-plan.md §3, Slice 2). apiFetch is mocked
// at the transport boundary, routed by URL — mirrors CountriesPanel.test.tsx.
// No Cesium viewer is passed (viewer is optional; the effects that use it all
// short-circuit on `!viewer`), so this exercises the chrome only, not replay
// playback itself (covered separately by HistoryPlayback.test.ts, Slice 3).

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline.js';

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

const COVERAGE = {
  recording_since: 1_750_000_000, // 2025-06-15T13:46:40Z
  total_bytes: 2_500_000_000, // 2.3 GB
  row_count: 987_654,
  buckets: [{ t: 1_750_000_000, count: 5 }],
};

function mockRoutes(opts: { coverage?: unknown; coverageOk?: boolean } = {}) {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u === '/api/history/stats') return jsonResponse({ retention_hours: 168 });
    if (u.startsWith('/api/history/coverage')) {
      return jsonResponse(opts.coverage ?? COVERAGE, opts.coverageOk === false ? 500 : 200);
    }
    if (u.startsWith('/api/timeline/density')) {
      return jsonResponse({ from: 0, to: 1, bins: 1, binWidthSec: 1, detections: [0], alerts: [0], gaps: [] });
    }
    if (u.startsWith('/api/timeline/events')) return jsonResponse({ lanes: [] });
    return jsonResponse({}, 404);
  });
}

describe('Timeline — coverage strip + ownership chip', () => {
  it('shows the fallback "~Nd buffer" label before coverage loads', () => {
    mockRoutes({ coverageOk: false });
    render(<Timeline />);
    expect(screen.getByText(/buffer/)).toBeInTheDocument();
  });

  it('replaces the buffer label with the recording-since/GB/fixes chip once coverage arrives', async () => {
    mockRoutes();
    render(<Timeline />);

    await waitFor(() => {
      expect(screen.getByText(/recording since 2025-06-15/)).toBeInTheDocument();
    });
    expect(screen.getByText(/2\.3 GB/)).toBeInTheDocument();
    expect(screen.getByText(/987,654 fixes/)).toBeInTheDocument();
    expect(screen.queryByText(/buffer$/)).not.toBeInTheDocument();
  });

  it('renders the coverage heat-strip alongside the day picker', async () => {
    mockRoutes();
    render(<Timeline />);
    expect(await screen.findByRole('img', { name: /history coverage/i })).toBeInTheDocument();
    // Existing day picker is still present and unchanged.
    expect(screen.getByLabelText('Replay a specific day')).toBeInTheDocument();
  });
});
