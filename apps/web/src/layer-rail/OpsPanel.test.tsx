// Guard test for the "Standing detections" poll's fetch-failure state (persona
// report dana-1): a non-2xx /api/alerts/standing response used to silently
// keep the initial {counts:{}, total:0} state, so "Standing detections (0)"
// read identically whether nothing was firing or the endpoint was
// structurally unreachable. This pins that a non-2xx surfaces an honest
// "unavailable (HTTP <code>)" state instead of a confident zero.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpsPanel } from './OpsPanel.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  } as unknown as Response;
}

describe('OpsPanel — standing detections poll', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders a real empty result, not "unavailable", on a healthy 200', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ detections: [], counts: {}, as_of: 0 }));
    render(<OpsPanel viewer={null} />);

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith('/api/alerts/standing', { cache: 'no-store' }),
    );
    expect(await screen.findByText('no detections firing')).toBeTruthy();
    expect(screen.queryByText(/unavailable/)).toBeNull();
  });

  it('surfaces "unavailable (HTTP <code>)" instead of a confident 0 on a non-2xx poll', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ detail: 'sign-in required' }, 401));
    render(<OpsPanel viewer={null} />);

    expect(
      await screen.findByText('Standing detections unavailable (HTTP 401)'),
    ).toBeTruthy();
    // never a confident zero standing in for the failure
    expect(screen.queryByText('no detections firing')).toBeNull();
  });
});
