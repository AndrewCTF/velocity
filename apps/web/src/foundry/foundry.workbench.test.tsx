import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryApp } from './FoundryApp.js';
import { useFoundry } from '../state/foundry.js';
import { useFoundryNav, type DetailTab } from './nav.js';
import { useAppView } from '../state/appView.js';

// Same mocking idiom as foundry.test.tsx: apiFetch is the only boundary a
// browser→backend call may cross, so every view exercises against a mocked
// router instead of a live backend.
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
  } as unknown as Response;
}

const SUMMARY = {
  datasets: 1,
  total_rows: 100,
  transforms: 0,
  builds_24h: 0,
  failed_builds_24h: 0,
  objects_synced: 0,
  checks_failing: 0,
  monitors: 2,
  monitor_events_24h: 3,
  recent_builds: [],
};

const DATASETS = [
  {
    id: 'ds-1',
    name: 'ship positions',
    description: '',
    kind: 'raw',
    schema: [
      { name: 'mmsi', type: 'int' },
      { name: 'lat', type: 'float' },
      { name: 'lon', type: 'float' },
    ],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    latest_version: 1,
    row_count: 3,
  },
];
const DATASET_1 = DATASETS[0]!;

const GEO_OK = {
  ok: true,
  lat_col: 'lat',
  lon_col: 'lon',
  count: 3,
  features: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 51] }, properties: { mmsi: 1, name: 'a', _idx: 0 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 52] }, properties: { mmsi: 2, name: 'b', _idx: 1 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 53] }, properties: { mmsi: 3, name: 'c', _idx: 2 } },
    ],
  },
};

const SQL_OK = {
  ok: true,
  columns: ['mmsi', 'lat'],
  rows: [{ mmsi: 1, lat: 51 }, { mmsi: 2, lat: 52 }],
  row_count: 2,
  tables: { ship_positions: 'ds-1' },
};

const MONITORS = [
  {
    id: 'mon-1',
    dataset_id: 'ds-1',
    name: 'new version watch',
    trigger: 'new_version',
    condition_expr: '',
    action: 'alert',
    llm_tier: 'fast',
    llm_system: '',
    llm_prompt: '',
    severity: 'medium',
    enabled: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
];

const MONITOR_EVENTS = [
  { id: 1, monitor_id: 'mon-1', at: '2026-07-09T12:00:00Z', kind: 'fired', summary: 'new version written', detail: {} },
];

function routeFetch(): void {
  mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = url.toString();
    const method = init?.method ?? 'GET';
    if (u.includes('/summary')) return jsonResponse(SUMMARY);
    if (u.includes('/datasets') && u.includes('/geo')) return jsonResponse(GEO_OK);
    if (u.includes('/foundry/sql') && method === 'POST') return jsonResponse(SQL_OK);
    if (u.includes('/monitors') && u.includes('/events')) return jsonResponse(MONITOR_EVENTS);
    if (u.includes('/monitors') && method === 'POST') return jsonResponse({ ...MONITORS[0], id: 'mon-2' });
    if (u.includes('/monitors')) return jsonResponse(MONITORS);
    if (u.match(/\/datasets\/[^/]+$/)) return jsonResponse(DATASET_1);
    if (u.includes('/datasets')) return jsonResponse(DATASETS);
    if (u.includes('/transforms')) return jsonResponse([]);
    if (u.includes('/builds')) return jsonResponse([]);
    if (u.includes('/lineage')) return jsonResponse({ nodes: [], edges: [] });
    if (u.includes('/bindings')) return jsonResponse([]);
    if (u.includes('/schedules')) return jsonResponse([]);
    if (u.includes('/kinds')) return jsonResponse({ kinds: [] });
    return jsonResponse({});
  });
}

async function openDatasetTab(tab: string): Promise<void> {
  render(<FoundryApp viewer={null} />);
  fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
  await waitFor(() => expect(screen.getByText('ship positions')).toBeInTheDocument());
  fireEvent.click(screen.getByText('ship positions'));
  await waitFor(() => expect(screen.getAllByText(/mmsi/).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByText(tab));
}

describe('Foundry workbench tabs', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    routeFetch();
    useAppView.setState({ app: 'foundry' });
    useFoundryNav.setState({ view: 'home', selectedId: null, detailTab: null });
    window.history.replaceState(null, '', '/');
    useFoundry.setState({
      summary: null,
      datasets: [],
      transforms: [],
      builds: [],
      lineage: null,
      bindings: [],
      kinds: [],
      schedules: [],
      checks: [],
      monitors: [],
      error: null,
      lastAutoSync: null,
    });
  });

  it('DetailTab nav round-trips map/sql/monitors through the URL', () => {
    const setDetailTab = useFoundryNav.getState().setDetailTab;
    for (const t of ['map', 'sql', 'monitors'] as DetailTab[]) {
      setDetailTab(t);
      expect(useFoundryNav.getState().detailTab).toBe(t);
      expect(window.location.search).toContain(`ftab=${t}`);
    }
  });

  it('Map tab renders one circle per feature from GET .../geo', async () => {
    await openDatasetTab('Map');
    await waitFor(() => expect(screen.getByTestId('map-tab')).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByTestId('geo-point')).toHaveLength(3));
    expect(screen.getByText(/3 points/)).toBeInTheDocument();
  });

  it('Map tab shows the EmptyState reason when the backend finds no geo columns', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes('/datasets') && u.includes('/geo')) return jsonResponse({ ok: false, reason: 'no lat/lon columns detected' });
      if (u.includes('/summary')) return jsonResponse(SUMMARY);
      if (u.match(/\/datasets\/[^/]+$/)) return jsonResponse(DATASET_1);
      if (u.includes('/datasets')) return jsonResponse(DATASETS);
      return jsonResponse({});
    });
    await openDatasetTab('Map');
    await waitFor(() => expect(screen.getByText('no lat/lon columns detected')).toBeInTheDocument());
  });

  it('SQL tab runs a query and renders the result table + row count', async () => {
    await openDatasetTab('SQL');
    const textarea = await screen.findByTestId('sql-query-input');
    expect((textarea as HTMLTextAreaElement).value).toBe('SELECT * FROM ship_positions LIMIT 50');
    fireEvent.click(screen.getByText('▶ Run'));
    await waitFor(() => expect(screen.getByText('51')).toBeInTheDocument());
    expect(screen.getByText(/2 rows/)).toBeInTheDocument();
    const sqlCall = mockedFetch.mock.calls.find((c) => c[0].toString().includes('/foundry/sql'));
    expect(sqlCall).toBeTruthy();
    const body = JSON.parse((sqlCall![1] as RequestInit).body as string) as { dataset_ids: string[]; query: string };
    expect(body.dataset_ids).toEqual(['ds-1']);
  });

  it('SQL tab shows an error banner on ok:false', async () => {
    mockedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      const method = init?.method ?? 'GET';
      if (u.includes('/foundry/sql') && method === 'POST') return jsonResponse({ ok: false, error: 'only SELECT statements are allowed' });
      if (u.includes('/summary')) return jsonResponse(SUMMARY);
      if (u.match(/\/datasets\/[^/]+$/)) return jsonResponse(DATASET_1);
      if (u.includes('/datasets')) return jsonResponse(DATASETS);
      return jsonResponse({});
    });
    await openDatasetTab('SQL');
    fireEvent.click(await screen.findByText('▶ Run'));
    await waitFor(() => expect(screen.getByTestId('sql-error')).toHaveTextContent('only SELECT statements are allowed'));
  });

  it('Monitors tab lists existing monitors and their events', async () => {
    await openDatasetTab('Monitors');
    await waitFor(() => expect(screen.getByText('new version watch')).toBeInTheDocument());
    fireEvent.click(screen.getByText('new version watch'));
    await waitFor(() => expect(screen.getByText('new version written')).toBeInTheDocument());
  });

  it('Monitors tab create form requires a name before submit', async () => {
    await openDatasetTab('Monitors');
    await waitFor(() => expect(screen.getByText('new version watch')).toBeInTheDocument());
    const createBtn = screen.getByText('+ Monitor');
    expect(createBtn.closest('button')).toBeDisabled();
    const dialog = screen.getByTestId('monitors-tab');
    const nameInput = within(dialog).getByPlaceholderText('row spike');
    fireEvent.change(nameInput, { target: { value: 'spike watch' } });
    expect(createBtn.closest('button')).not.toBeDisabled();
    fireEvent.click(createBtn);
    const createCall = mockedFetch.mock.calls.find(
      (c) => c[0].toString().endsWith('/api/foundry/monitors') && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    await waitFor(() => expect(createCall).toBeTruthy());
    const body = JSON.parse((createCall![1] as RequestInit).body as string) as { name: string; dataset_id: string };
    expect(body.name).toBe('spike watch');
    expect(body.dataset_id).toBe('ds-1');
  });
});
