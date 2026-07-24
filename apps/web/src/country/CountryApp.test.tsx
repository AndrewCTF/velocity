// Render tests for the Country intelligence app. apiFetch is mocked at the
// transport boundary (repo convention, see city/CityApp.test.tsx) so nothing
// hits a live backend. Covers: leadership tiles incl. the initials-avatar
// fallback when a portrait is absent, the honest security empty state, the
// brief card's ok:false degrade, and a full-app selection smoke test.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BriefCard } from './BriefCard.js';
import { CountryApp } from './CountryApp.js';
import { InstabilityCard } from './InstabilityCard.js';
import { LeadershipCard } from './LeadershipCard.js';
import { SecurityCard } from './SecurityCard.js';
import type { ProfileResponse, SecurityResponse } from './shared.js';

vi.mock('../transport/http.js', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../transport/http.js';

const mockedFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const PROFILE: ProfileResponse = {
  iso3: 'TST',
  name: 'Testland',
  source: 'wikidata',
  leadership: [
    {
      role: 'Head of state',
      person: 'Maria Rossi',
      position: 'President of Testland',
      start: '2024-05-01',
      image: 'https://commons.wikimedia.org/wiki/Special:FilePath/Maria%20Rossi.jpg',
    },
    {
      role: 'Minister of Defence',
      person: 'John Quincy Doe',
      position: 'Minister of Defence',
      start: '2025-12-04',
      image: null,
    },
  ],
  military_branches: ['Testland Army', 'Testland Navy'],
};

const EMPTY_SECURITY: SecurityResponse = {
  iso3: 'TST',
  name: 'Testland',
  window_hours: 24,
  counts: { conflict: 0, ucdp: 0, installations: 0 },
  events: [],
  sources: {
    conflict: { unavailable: false, note: null },
    ucdp: { unavailable: true, note: 'token-gated' },
    installations: { unavailable: true, note: 'US-only' },
  },
  notes: ['UCDP GED is token-gated (set OSINT_UCDP_TOKEN).'],
};

describe('LeadershipCard', () => {
  it('renders leader tiles from the profile payload, with an initials avatar when no image', () => {
    render(<LeadershipCard state={{ loading: false, error: null, data: PROFILE }} />);
    expect(screen.getByText('Maria Rossi')).toBeTruthy();
    expect(screen.getByText('John Quincy Doe')).toBeTruthy();
    expect(screen.getByText('Head of state')).toBeTruthy();
    expect(screen.getByText('since 2025-12-04')).toBeTruthy();
    // Maria has an image → <img> with the ?width=128 thumbnail param.
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toContain('width=128');
    // John has image:null → initials fallback "JD" (first + last word).
    const avatars = screen.getAllByTestId('initials-avatar');
    expect(avatars).toHaveLength(1);
    expect(avatars[0]!.textContent).toBe('JD');
  });

  it('shows the unavailable state when Wikidata degrades', () => {
    render(
      <LeadershipCard
        state={{
          loading: false,
          error: null,
          data: {
            iso3: 'TST',
            source: 'wikidata',
            leadership: [],
            military_branches: [],
            unavailable: true,
            note: 'wikidata sparql unavailable (timeout/429)',
          },
        }}
      />,
    );
    expect(screen.getByText(/Wikidata unavailable/)).toBeTruthy();
  });
});

describe('SecurityCard', () => {
  it('renders the counts row and an honest empty state with caveat notes', () => {
    render(<SecurityCard state={{ loading: false, error: null, data: EMPTY_SECURITY }} />);
    expect(screen.getByText('conflict (GDELT)')).toBeTruthy();
    expect(screen.getByText(/No matching events in the last 24 h/)).toBeTruthy();
    // ucdp source is unavailable → the empty state names the token gate.
    expect(screen.getByText(/UCDP source token-gated/)).toBeTruthy();
    expect(screen.getByText(/OSINT_UCDP_TOKEN/)).toBeTruthy();
  });

  it('renders event rows with deaths badge and source tag', () => {
    const data: SecurityResponse = {
      ...EMPTY_SECURITY,
      counts: { conflict: 0, ucdp: 1, installations: 0 },
      events: [
        {
          label: 'state-based violence',
          date: '2026-07-10',
          actors: ['Side A', 'Side B'],
          deaths: 12,
          lat: 1,
          lon: 2,
          source: 'ucdp',
        },
      ],
    };
    render(<SecurityCard state={{ loading: false, error: null, data }} />);
    expect(screen.getByText('state-based violence')).toBeTruthy();
    expect(screen.getByText('12 killed')).toBeTruthy();
    expect(screen.getByText('ucdp')).toBeTruthy();
  });
});

describe('BriefCard', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('fetches only on click and shows the ok:false reason with the settings hint', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ ok: false, reason: 'no LLM backend configured' }),
    );
    render(<BriefCard iso3="ZZF" />);
    // Nothing fetched on mount — the brief is click-only (10-90 s LLM call).
    expect(mockedFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));
    await waitFor(() => {
      expect(screen.getByText(/no LLM backend configured/)).toBeTruthy();
    });
    expect(mockedFetch).toHaveBeenCalledWith('/api/country/ZZF/brief', expect.anything());
    expect(screen.getByText(/Settings → Local AI/)).toBeTruthy();
  });

  it('promises the real 90s server budget while generating (priya-2: was a stale 60s ceiling)', async () => {
    mockedFetch.mockImplementation(() => new Promise(() => {}));
    render(<BriefCard iso3="ZZM" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));
    expect(await screen.findByText(/up to ~90 s/)).toBeTruthy();
  });

  it('renders the markdown brief on ok:true', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ ok: true, markdown: '## Overview\n\nStable.', backend: 'llama.cpp', model: 'test-model' }),
    );
    render(<BriefCard iso3="ZZK" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate brief' }));
    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeTruthy();
    });
    expect(screen.getByText('Stable.')).toBeTruthy();
    expect(screen.getByText(/llama\.cpp/)).toBeTruthy();
  });
});

describe('InstabilityCard', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('renders nothing when the backend has no snapshot for the country (404)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'no snapshot' }, false));
    const { container } = render(<InstabilityCard iso3="ZZZ" />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/api/country/instability/ZZZ', expect.anything());
    });
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});

describe('CountryApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('lists countries and loads profile + security + stats on selection', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u === '/api/country/list')
        return jsonResponse([
          { name: 'Testland', iso2: 'TL', iso3: 'TST', m49: '999', region: 'Europe', sub_region: 'Test Europe' },
        ]);
      if (u === '/api/osint/countries') return jsonResponse({ count: 0, countries: [] });
      if (u.includes('/profile')) return jsonResponse(PROFILE);
      if (u.includes('/security')) return jsonResponse(EMPTY_SECURITY);
      if (u.includes('/worldbank'))
        return jsonResponse({
          iso3: 'TST',
          name: 'Testland',
          source: 'worldbank-api-v2',
          indicators: [
            {
              id: 'SP.POP.TOTL',
              label: 'Population',
              unit: 'people',
              series: [
                { year: 2022, value: 4_900_000 },
                { year: 2023, value: 5_000_000 },
              ],
            },
            {
              id: 'MS.MIL.XPND.GD.ZS',
              label: 'Military expenditure',
              unit: '% of GDP',
              series: [
                { year: 2022, value: 1.9 },
                { year: 2023, value: 2.1 },
              ],
            },
          ],
        });
      if (u.includes('/un')) return jsonResponse({ iso3: 'TST', name: 'Testland', m49: '999', source: 'unsd', series: [] });
      if (u === '/api/advisories') return jsonResponse({ items: [], sources: [], unavailable: false });
      if (u === '/api/displacement') return jsonResponse({ items: [], source: 'hapi.humdata.org', unavailable: true });
      if (u.includes('/api/country/instability/'))
        return jsonResponse({
          iso3: 'TST',
          score: 42.3,
          components: [
            { key: 'conflict_events', raw: 5, normalized: 60, weight: 0.4, inputs: { window_days: 30 } },
            { key: 'displacement', raw: 1000, normalized: 20, weight: 0.3, inputs: null },
          ],
          components_present: ['conflict_events', 'displacement'],
          ts_utc: '2026-07-20T12:00:00Z',
          history: [
            { ts_utc: '2026-07-18T12:00:00Z', score: 38.1 },
            { ts_utc: '2026-07-19T12:00:00Z', score: 40.0 },
            { ts_utc: '2026-07-20T12:00:00Z', score: 42.3 },
          ],
        });
      return jsonResponse({});
    });

    render(<CountryApp />);
    const row = await screen.findByRole('button', { name: /Testland/ });
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText('Maria Rossi')).toBeTruthy();
    });
    // Security card empty state present alongside leadership — one surface.
    expect(screen.getByText(/No matching events/)).toBeTruthy();
    // Military branches chips from the profile payload.
    expect(screen.getByText('Testland Army')).toBeTruthy();
    // Military WB indicator lives in the posture card; the % of GDP unit shows.
    expect(screen.getByText('% of GDP')).toBeTruthy();
    // Instability score renders from the composite endpoint.
    await waitFor(() => {
      expect(screen.getByText('42.3')).toBeTruthy();
    });
    expect(screen.getByText(/Components: conflict_events, displacement/)).toBeTruthy();
    // Brief endpoint must NOT have been called without a click.
    const briefCalls = mockedFetch.mock.calls.filter(([u]) => String(u).includes('/brief'));
    expect(briefCalls).toHaveLength(0);
  });
});
