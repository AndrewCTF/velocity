// Regression test: DossierNarrativeCard must reset its generated assessment when
// the selection changes. The card instance persists across selections (EntityPanel
// is toggled by display, never re-keyed), so without the reset effect it would
// show the previous contact's analytic assessment under the new contact.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DossierNarrativeCard } from './DossierNarrativeCard.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

describe('DossierNarrativeCard: assessment does not leak across selections', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(jsonResponse({ ok: true, assessment: 'ASSESSMENT_FOR_A' }));
  });

  it('drops the previous contact assessment on id change', async () => {
    const { rerender } = render(<DossierNarrativeCard id="aircraft:AAA" kind="aircraft" />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('ASSESSMENT_FOR_A')).toBeTruthy();

    // Select a different aircraft — the reset effect must clear A's assessment
    // rather than render it under B, and the button returns to "Generate".
    rerender(<DossierNarrativeCard id="aircraft:BBB" kind="aircraft" />);
    await waitFor(() => expect(screen.queryByText('ASSESSMENT_FOR_A')).toBeNull());
    const btn = screen.getByRole('button');
    expect(btn.textContent).toContain('Generate');
    expect(btn.textContent).not.toContain('Regenerate');
  });
});
