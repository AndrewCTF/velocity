// Guard for the "Audit becomes UI" slice: AuditPanel polls the immutable
// action log (GET /api/audit?limit=N) via apiFetch — never a raw fetch — every
// 30 s, renders the latest rows, shows the /api/audit/verify chain chip,
// refetches when the limit changes, and Copy JSON hands the current rows to
// the clipboard.
//
// Mocking convention mirrors InboxPanel.test.tsx: apiFetch is mocked at the
// transport boundary and routed by URL.

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AuditPanel } from './AuditPanel.js';

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
  } as unknown as Response;
}

// One chained local-audit row (carries a classification) and one plain
// action-log row (no classification field at all) — the two local stores the
// backend union.
const ROWS = [
  {
    user_id: 'operator@osint.local',
    action: 'ingest.accept',
    resource_type: 'dataset',
    target_id: 'dataset:quakes',
    classification: 0,
    ts: '2026-09-17T02:03:04Z',
    store: 'audit_log',
  },
  {
    user_id: 'analyst@osint.local',
    action: 'case.update',
    target_id: 'case:17',
    ts: '2026-09-17T01:59:00Z',
    store: 'action_log',
  },
];

const VERIFY_OK = { ok: true, rows: 128, first_bad_id: null };

function mockRoutes(overrides: { rows?: unknown[]; verify?: unknown; verifyStatus?: number } = {}) {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    // The verify prefix must be tested before the plain /api/audit prefix.
    if (u.startsWith('/api/audit/verify')) {
      return jsonResponse(overrides.verify ?? VERIFY_OK, overrides.verifyStatus ?? 200);
    }
    if (u.startsWith('/api/audit')) return jsonResponse(overrides.rows ?? ROWS);
    return jsonResponse([], 404);
  });
}

describe('AuditPanel', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    delete (window.navigator as { clipboard?: unknown }).clipboard;
  });

  it('polls /api/audit, renders the rows and the verified chain chip', async () => {
    mockRoutes();
    render(<AuditPanel />);

    expect(await screen.findByText('chain verified · 128 rows')).toBeInTheDocument();
    expect(screen.getByText('2026-09-17 02:03:04')).toBeInTheDocument();
    expect(screen.getByText('operator@osint.local')).toBeInTheDocument();
    expect(screen.getByText('ingest.accept')).toBeInTheDocument();
    expect(screen.getByText('dataset:quakes')).toBeInTheDocument();
    // Classification 0 renders through the shared US ladder, not a raw int.
    expect(screen.getByText('UNCLASSIFIED')).toBeInTheDocument();
    // The second row has no classification field, so its cell is the lone
    // "no value reported" dash, not a fabricated 0.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);

    expect(mockedFetch).toHaveBeenCalledWith('/api/audit?limit=50', expect.anything());
    expect(mockedFetch).toHaveBeenCalledWith('/api/audit/verify');
  });

  it('renders a failure sentence with the HTTP code when the chain check 5xxs', async () => {
    mockRoutes({ verify: { detail: 'audit store unavailable' }, verifyStatus: 503 });
    render(<AuditPanel />);

    expect(await screen.findByText('chain check failed (HTTP 503)')).toBeInTheDocument();
  });

  it('names the first bad row when the chain itself is broken', async () => {
    mockRoutes({ verify: { ok: false, rows: 41, first_bad_id: 42 } });
    render(<AuditPanel />);

    expect(await screen.findByText('chain broken · row 42 no longer matches')).toBeInTheDocument();
  });

  it('refetches with the new limit when the limit selector changes', async () => {
    mockRoutes();
    render(<AuditPanel />);
    await screen.findByText('chain verified · 128 rows');

    fireEvent.change(screen.getByLabelText('row limit'), { target: { value: '500' } });

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/api/audit?limit=500', expect.anything());
    });
  });

  it('Copy JSON copies the current rows to the clipboard', async () => {
    mockRoutes();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<AuditPanel />);
    await screen.findByText('chain verified · 128 rows');

    fireEvent.click(screen.getByText('Copy JSON'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(ROWS, null, 2));
  });

  it('shows an empty state when the store has no rows yet', async () => {
    mockRoutes({ rows: [] });
    render(<AuditPanel />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/api/audit?limit=50', expect.anything()));
    await waitFor(() => expect(screen.getByText('no rows yet')).toBeInTheDocument());
    expect(screen.queryByText('UNCLASSIFIED')).not.toBeInTheDocument();
  });
});
