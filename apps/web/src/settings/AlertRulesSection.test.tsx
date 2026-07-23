// Guard test for the alert-rule creation form (user-feedback P6): the backend
// (app/routes/alert_rules.py) was real and tested but had zero UI. This locks
// in that (1) submitting the form POSTs to /api/alerts/rules via apiFetch —
// never a raw fetch — with the AlertRuleIn shape the route expects, and
// (2) a non-2xx response surfaces the server's error sentence rather than
// failing silently.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertRulesSection } from './AlertRulesSection.js';

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

describe('AlertRulesSection', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    // GET /api/alerts/rules on mount (empty list).
    mockedFetch.mockResolvedValue(jsonResponse([]));
  });

  it('POSTs a well-formed AlertRuleIn body via apiFetch on submit', async () => {
    render(<AlertRulesSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/alerts/rules'));

    fireEvent.change(screen.getByPlaceholderText(/Label/), {
      target: { value: 'Hormuz watch' },
    });
    fireEvent.change(screen.getByPlaceholderText('lat'), { target: { value: '26.5' } });
    fireEvent.change(screen.getByPlaceholderText('lon'), { target: { value: '56.3' } });
    fireEvent.click(screen.getByText('jamming'));

    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'rule-1', label: 'Hormuz watch' }, 201),
    );
    fireEvent.click(screen.getByText('Create alert rule'));

    await screen.findByText(/Rule created/);

    const createCall = mockedFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeTruthy();
    const [url, init] = createCall as [string, RequestInit];
    expect(url).toBe('/api/alerts/rules');
    const body = JSON.parse(init.body as string) as {
      label: string;
      lat: number;
      lon: number;
      kinds: string[];
      channel: string;
    };
    expect(body.label).toBe('Hormuz watch');
    expect(body.lat).toBe(26.5);
    expect(body.lon).toBe(56.3);
    expect(body.kinds).toEqual(['jamming']);
    expect(body.channel).toBe('inapp');
  });

  it('surfaces the server error sentence instead of failing silently', async () => {
    render(<AlertRulesSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/alerts/rules'));

    fireEvent.change(screen.getByPlaceholderText(/Label/), {
      target: { value: 'Bad rule' },
    });
    fireEvent.change(screen.getByPlaceholderText('lat'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('lon'), { target: { value: '1' } });

    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ detail: "unknown kinds: ['bogus']" }, 400),
    );
    fireEvent.click(screen.getByText('Create alert rule'));

    expect(await screen.findByText(/unknown kinds/)).toBeTruthy();
  });

  // sam-2: Number('') === 0, which IS finite, so a blank lat/lon used to
  // coerce straight to a real (0, 0) geofence instead of "no AOI". An
  // identity-only submission must omit lat/lon/radius_nm from the POST body
  // entirely, not send zeros.
  it('omits the AOI entirely when an identity field is set and lat/lon are left blank', async () => {
    render(<AlertRulesSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/alerts/rules'));

    fireEvent.change(screen.getByPlaceholderText(/Label/), {
      target: { value: 'THUN EOS watch' },
    });
    fireEvent.change(screen.getByPlaceholderText('mmsi (optional)'), {
      target: { value: '244013009' },
    });
    // lat/lon/radius left at their defaults (lat/lon blank).

    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ id: 'rule-2', label: 'THUN EOS watch' }, 201),
    );
    fireEvent.click(screen.getByText('Create alert rule'));

    await screen.findByText(/Rule created/);

    const createCall = mockedFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    const [, init] = createCall as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.mmsi).toBe('244013009');
    expect('lat' in body).toBe(false);
    expect('lon' in body).toBe(false);
    expect('radius_nm' in body).toBe(false);
  });

  it('shows an inline error for a partially filled AOI instead of silently coercing it', async () => {
    render(<AlertRulesSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/alerts/rules'));

    fireEvent.change(screen.getByPlaceholderText(/Label/), {
      target: { value: 'Half AOI' },
    });
    fireEvent.change(screen.getByPlaceholderText('lat'), { target: { value: '26.5' } });
    // lon left blank.
    fireEvent.click(screen.getByText('Create alert rule'));

    expect(await screen.findByText(/Lat and lon must both be set/)).toBeTruthy();
    const createCall = mockedFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
  });

  // sam-2 (rule list): an identity-only rule (no AOI) used to render the
  // Field(50, ...) default as if it were a real '50 nm' geofence — a fake
  // number for a rule watch.py's has_identity gate never actually enforces.
  it('renders an identity-only rule with the global badge, not a fake nm radius', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(
      jsonResponse([
        {
          id: 'rule-3',
          label: 'Track RCH1',
          lat: null,
          lon: null,
          radius_nm: null,
          kinds: [],
          min_severity: 1,
          channel: 'inapp',
          enabled: true,
          icao24: 'abc123',
        },
      ]),
    );

    render(<AlertRulesSection />);

    expect(await screen.findByText(/identity pin · global/)).toBeTruthy();
    expect(screen.queryByText(/^50 nm/)).toBeNull();
  });
});
