// Component tests for AisGapCard. apiFetch is mocked at the transport boundary
// (mirrors DossierNarrativeCard.test.tsx / CoverageStrip.test.tsx) — no real
// network involved.
//
// mika-2 (docs/decisions.md finding): the dossier's positions-DB gap window
// used to be a hardcoded 48h regardless of what the byte-cap-bound store
// actually held, and the card rendered nothing when there were zero gaps —
// so a shortened window and "no gaps ever occurred" were visually identical.
// These prove the card now discloses a shortened window even with an empty
// gap list, and stays silent (as before) when the window is effectively full.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AisGapCard } from './AisGapCard.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

const GAP = { start: 1_700_000_000, end: 1_700_000_900, minutes: 15, lon: 5.0, lat: 50.0 };

describe('AisGapCard', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders nothing when there is no mmsi', () => {
    const { container } = render(<AisGapCard mmsi={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the vessel is not found', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ found: false }));
    const { container } = render(<AisGapCard mmsi="477961500" />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the window is effectively full and there are no gaps', async () => {
    // Requested and available line up (a fresh box / generous retention) —
    // preserve the original "render nothing" quiet behaviour, no false alarm.
    const nowS = Date.now() / 1000;
    mockedFetch.mockResolvedValue(
      jsonResponse({
        found: true,
        track: { gaps: [] },
        window_requested_s: 3600,
        window_available_from_ts: nowS - 3600,
      }),
    );
    const { container } = render(<AisGapCard mmsi="477961500" />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the gap list as before when the window is not shortened', async () => {
    const nowS = Date.now() / 1000;
    mockedFetch.mockResolvedValue(
      jsonResponse({
        found: true,
        track: { gaps: [GAP] },
        window_requested_s: 3600,
        window_available_from_ts: nowS - 3600,
      }),
    );
    render(<AisGapCard mmsi="477961500" />);
    expect(await screen.findByText('AIS gaps')).toBeTruthy();
    expect(screen.getByText('15 min')).toBeTruthy();
    expect(screen.queryByText(/available history/)).toBeNull();
  });

  it('discloses a shortened window even with zero gaps — never lets "no gaps shown" read as "no gaps existed"', async () => {
    const nowS = Date.now() / 1000;
    mockedFetch.mockResolvedValue(
      jsonResponse({
        found: true,
        track: { gaps: [] },
        window_requested_s: 10 * 3600, // asked for 10h
        window_available_from_ts: nowS - 2 * 3600, // store only actually holds ~2h
      }),
    );
    render(<AisGapCard mmsi="477961500" />);
    expect(await screen.findByText('AIS gaps')).toBeTruthy();
    expect(screen.getByText('Gaps within available history · last 2.0 h')).toBeTruthy();
  });

  it('shows the shortened-window disclosure alongside a real gap list', async () => {
    const nowS = Date.now() / 1000;
    mockedFetch.mockResolvedValue(
      jsonResponse({
        found: true,
        track: { gaps: [GAP] },
        window_requested_s: 48 * 3600,
        window_available_from_ts: nowS - 1.2 * 3600,
      }),
    );
    render(<AisGapCard mmsi="477961500" />);
    expect(await screen.findByText('15 min')).toBeTruthy();
    expect(screen.getByText('Gaps within available history · last 1.2 h')).toBeTruthy();
  });
});
