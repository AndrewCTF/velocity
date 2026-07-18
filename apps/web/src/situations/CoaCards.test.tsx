// Regression: proposed COAs must not leak across situations. CoaCards (inside
// SituationPanel) persists across selections and is not re-keyed, so without the
// reset effect a "Verify" click would file the previous situation's course of
// action under the newly-selected one — a wrong-data write, not a display glitch.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CoaCards } from './CoaCards.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

describe('CoaCards: proposed COAs do not leak across situations', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(
      jsonResponse({
        ok: true,
        coas: [{ title: 'COA_FOR_A', side: 'enemy', likelihood: 'high', rationale: 'r' }],
      }),
    );
  });

  it('clears proposed COAs when the situation changes', async () => {
    const { rerender } = render(<CoaCards situationId="situation:A" />);
    fireEvent.click(screen.getByRole('button', { name: /Propose/ }));
    expect(await screen.findByText('COA_FOR_A')).toBeTruthy();

    // Select a different situation — the reset effect must clear A's COAs so a
    // subsequent Verify can't file A's course of action under B.
    rerender(<CoaCards situationId="situation:B" />);
    await waitFor(() => expect(screen.queryByText('COA_FOR_A')).toBeNull());
  });
});
