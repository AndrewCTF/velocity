// Deterministic render test for the Investigate flyout's result block. Mirrors
// the mocking convention in CountriesPanel.test.tsx / OsintEntityPanel.test.tsx:
// apiFetch is mocked at the transport boundary, no real network involved.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestigatePanel } from './InvestigatePanel.js';

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

async function runInvestigate(target: string, companyMode: boolean) {
  render(<InvestigatePanel />);
  if (companyMode) {
    fireEvent.click(screen.getByText('Company'));
  }
  fireEvent.change(screen.getByPlaceholderText(/example.com/), { target: { value: target } });
  fireEvent.click(screen.getByText('Run'));
}

describe('InvestigatePanel — company screening result', () => {
  it('renders the full screening summary, including zero counts, not just subdomains/threat_pulses', async () => {
    mockedFetch.mockImplementation(async () =>
      jsonResponse({
        root: 'ext:organization:tesla',
        kind: 'org',
        objects: 4,
        links: 3,
        summary: {
          cik: '1318605',
          sanctions_matches: 0,
          opencorporates_matches: 0,
          officers: 0,
          aleph_matches: 0,
          wikidata_matches: 0,
        },
      }),
    );

    await runInvestigate('Tesla', true);

    expect(await screen.findByText('ext:organization:tesla')).toBeInTheDocument();
    expect(screen.getByText('SEC CIK: 1318605')).toBeInTheDocument();
    // Zero counts render as real zeros, not hidden.
    expect(screen.getByText('Sanctions matches: 0')).toBeInTheDocument();
    expect(screen.getByText('OpenCorporates matches: 0')).toBeInTheDocument();
    expect(screen.getByText('Aleph matches: 0')).toBeInTheDocument();
    expect(screen.getByText('Wikidata matches: 0')).toBeInTheDocument();
    expect(screen.getByText('Officers found: 0')).toBeInTheDocument();
  });

  it('renders non-zero sanction matches in the alert color and a positive officer/match count', async () => {
    mockedFetch.mockImplementation(async () =>
      jsonResponse({
        root: 'ext:organization:acme-corp',
        kind: 'org',
        objects: 6,
        links: 5,
        summary: {
          cik: '',
          sanctions_matches: 2,
          opencorporates_matches: 1,
          officers: 3,
          aleph_matches: 0,
          wikidata_matches: 1,
        },
      }),
    );

    await runInvestigate('Acme Corp', true);

    expect(await screen.findByText('Sanctions matches: 2')).toBeInTheDocument();
    expect(screen.getByText('Sanctions matches: 2')).toHaveStyle({ color: 'var(--alert)' });
    expect(screen.getByText('Officers found: 3')).toBeInTheDocument();
    expect(screen.getByText('OpenCorporates matches: 1')).toBeInTheDocument();
    // No CIK found -> empty string -> not rendered.
    expect(screen.queryByText(/SEC CIK:/)).not.toBeInTheDocument();
  });

  it('a plain domain/IP result (no summary counts) still renders subdomains as before', async () => {
    mockedFetch.mockImplementation(async () =>
      jsonResponse({
        root: 'domain:example.com',
        kind: 'domain',
        objects: 5,
        links: 4,
        summary: { subdomains: 3, threat_pulses: 0 },
      }),
    );

    await runInvestigate('example.com', false);

    expect(await screen.findByText('domain:example.com')).toBeInTheDocument();
    expect(screen.getByText('subdomains found: 3')).toBeInTheDocument();
    expect(screen.queryByText(/threat pulses/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sanctions matches/)).not.toBeInTheDocument();
  });
});


// ── OSINT Techniques 11th ed. wave: pivot links and the two new modes ────────

describe('InvestigatePanel — pivots and modes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    mockedFetch.mockReset();
  });

  const PIVOTS = {
    target: '6184620000',
    kind: 'phone',
    count: 2,
    groups: [
      {
        category: 'Reverse lookup',
        links: [
          { id: 'thatsthem', name: "That's Them", url: 'https://thatsthem.com/phone/618-462-0000' },
          {
            id: 'syncme',
            name: 'Sync.me',
            url: 'https://sync.me/search/?number=16184620000',
            note: 'caller id',
          },
        ],
      },
    ],
  };

  async function typeTarget(value: string) {
    fireEvent.change(screen.getByPlaceholderText(/example.com/), { target: { value } });
    await vi.advanceTimersByTimeAsync(400);
  }

  it('renders the pivot links returned for the typed target', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse(PIVOTS));
    render(<InvestigatePanel />);
    await typeTarget('618-462-0000');

    await waitFor(() => expect(screen.getByText('Sync.me')).toBeInTheDocument());
    expect(screen.getByText("That's Them")).toHaveAttribute(
      'href',
      'https://thatsthem.com/phone/618-462-0000',
    );
    // A pivot opens a third-party site, so it must not inherit this window.
    expect(screen.getByText("That's Them")).toHaveAttribute('rel', 'noreferrer noopener');
    expect(screen.getByText(/Pivots · phone · 2 lookups/)).toBeInTheDocument();
  });

  it('asks the backend for the mode the operator selected', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse({ ...PIVOTS, kind: 'person', count: 0, groups: [] }));
    render(<InvestigatePanel />);
    fireEvent.click(screen.getByText('Person'));
    await typeTarget('Michael Bazzell');

    await waitFor(() =>
      expect(mockedFetch).toHaveBeenCalledWith(
        expect.stringContaining('kind=person'),
        expect.anything(),
      ),
    );
  });

  it('disables Run in phone mode, because nothing can be fetched for a number', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse(PIVOTS));
    render(<InvestigatePanel />);
    fireEvent.click(screen.getByText('Phone'));
    await typeTarget('618-462-0000');

    expect(screen.getByText('Run')).toBeDisabled();
    expect(screen.getByText(/pivot links only/)).toBeInTheDocument();
  });

  it('leaves Run enabled in person mode, which does have a fan-out', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse(PIVOTS));
    render(<InvestigatePanel />);
    fireEvent.click(screen.getByText('Person'));
    await typeTarget('Michael Bazzell');

    expect(screen.getByText('Run')).not.toBeDisabled();
  });

  it('the three modes are mutually exclusive and each toggles off', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse(PIVOTS));
    render(<InvestigatePanel />);

    fireEvent.click(screen.getByText('Company'));
    expect(screen.getByText('Company')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('Person'));
    expect(screen.getByText('Company')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Person')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('Person'));
    expect(screen.getByText('Person')).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders a checked-clean stealer result as a finding, not as nothing', async () => {
    mockedFetch.mockImplementation(async () =>
      jsonResponse({
        root: 'email:jane@example.com',
        kind: 'email',
        objects: 1,
        links: 0,
        summary: { stealer_checked: true, stealer_machines: 0 },
      }),
    );
    render(<InvestigatePanel />);
    fireEvent.change(screen.getByPlaceholderText(/example.com/), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByText('Run'));

    expect(await screen.findByText('Infostealer logs: 0 machines')).toBeInTheDocument();
  });
});
