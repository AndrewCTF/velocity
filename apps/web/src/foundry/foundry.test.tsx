import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryApp } from './FoundryApp.js';
import { useFoundry } from '../state/foundry.js';

// Mock apiFetch at the transport boundary (per repo eslint guard, everything
// goes through it) so each view can be exercised without a live backend.
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
  datasets: 2,
  total_rows: 1234,
  transforms: 1,
  builds_24h: 3,
  failed_builds_24h: 1,
  objects_synced: 42,
  recent_builds: [
    {
      id: 'build-1',
      transform_id: 'tf-1',
      scope: 'transform',
      status: 'succeeded',
      started_at: '2026-07-08T00:00:00Z',
      finished_at: '2026-07-08T00:00:05Z',
      rows_out: 10,
      error: null,
      log: [],
    },
  ],
};

const DATASETS = [
  {
    id: 'ds-1',
    name: 'ships',
    description: '',
    kind: 'raw',
    schema: [{ name: 'mmsi', type: 'int' }],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    latest_version: 1,
    row_count: 100,
  },
];

const TRANSFORMS = [
  {
    id: 'tf-1',
    name: 'filter-ships',
    description: '',
    inputs: ['ds-1'],
    output_dataset_id: 'ds-2',
    steps: [{ type: 'filter', expr: 'mmsi > 0' }],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
];

const BUILDS = [
  {
    id: 'build-1',
    transform_id: 'tf-1',
    scope: 'transform',
    status: 'succeeded',
    started_at: '2026-07-08T00:00:00Z',
    finished_at: '2026-07-08T00:00:05Z',
    rows_out: 10,
    error: null,
    log: ['step 1 ok'],
  },
];

const LINEAGE = {
  nodes: [
    { id: 'ds-1', type: 'dataset', name: 'ships', row_count: 100, kind: 'raw' },
    { id: 'tf-1', type: 'transform', name: 'filter-ships' },
    { id: 'ds-2', type: 'dataset', name: 'ships_out', row_count: 40, kind: 'derived' },
  ],
  edges: [
    { src: 'ds-1', dst: 'tf-1' },
    { src: 'tf-1', dst: 'ds-2' },
  ],
};

const BINDINGS = [
  {
    id: 'bind-1',
    dataset_id: 'ds-1',
    object_kind: 'vessel',
    key_column: 'mmsi',
    prop_map: { mmsi: 'id' },
    enabled: true,
    last_sync: null,
    last_result: null,
    created_at: '2026-07-01T00:00:00Z',
  },
];

const SCHEDULES = [
  { id: 'sch-1', transform_id: 'tf-1', interval_s: 3600, enabled: true, last_run: null, created_at: '2026-07-01T00:00:00Z' },
];

const CHECKS = [
  {
    id: 'chk-1',
    dataset_id: 'ds-1',
    name: 'min-rows',
    type: 'row_count_min',
    params: { min: 1 },
    severity: 'warn',
    enabled: true,
    created_at: '2026-07-01T00:00:00Z',
  },
];

const CHECK_RESULTS = [{ check_id: 'chk-1', name: 'min-rows', type: 'row_count_min', severity: 'warn', passed: true }];

const DATASET_1 = DATASETS[0]!;

function routeFetch(): void {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.includes('/summary')) return jsonResponse(SUMMARY);
    if (u.includes('/datasets/upload')) return jsonResponse(DATASET_1);
    if (u.includes('/datasets') && u.includes('/rollback')) return jsonResponse(DATASET_1);
    if (u.includes('/datasets') && u.includes('/checks/results')) return jsonResponse(CHECK_RESULTS);
    if (u.includes('/foundry/checks')) return jsonResponse(CHECKS);
    if (u.includes('/datasets') && u.includes('/rows')) return jsonResponse({ schema: DATASET_1.schema, rows: [{ mmsi: 1 }], total: 1, version: 1 });
    if (u.includes('/datasets') && u.includes('/versions')) return jsonResponse([{ version: 1, row_count: 100, source: 'upload', created_at: '2026-07-01T00:00:00Z' }]);
    if (u.includes('/datasets') && u.includes('/stats')) return jsonResponse([{ name: 'mmsi', type: 'int', nulls: 0, distinct: 100, min: 1, max: 999 }]);
    if (u.match(/\/datasets\/[^/]+$/)) return jsonResponse(DATASET_1);
    if (u.includes('/datasets')) return jsonResponse(DATASETS);
    if (u.includes('/transforms')) return jsonResponse(TRANSFORMS);
    if (u.includes('/builds')) return jsonResponse(BUILDS);
    if (u.includes('/lineage')) return jsonResponse(LINEAGE);
    if (u.includes('/bindings')) return jsonResponse(BINDINGS);
    if (u.includes('/schedules')) return jsonResponse(SCHEDULES);
    return jsonResponse({});
  });
}

describe('FoundryApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    routeFetch();
    useFoundry.setState({
      summary: null,
      datasets: [],
      transforms: [],
      builds: [],
      lineage: null,
      bindings: [],
      schedules: [],
      checks: [],
      error: null,
    });
  });

  it('renders Home with stat cards from GET /api/foundry/summary', async () => {
    render(<FoundryApp viewer={null} />);
    await waitFor(() => expect(screen.getByText('1,234')).toBeInTheDocument());
    expect(screen.getAllByText('Datasets').length).toBeGreaterThan(0);
    expect(screen.getByText('Objects synced')).toBeInTheDocument();
  });

  it('renders Datasets list and a dataset detail on click', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    await waitFor(() => expect(screen.getAllByText(/mmsi/).length).toBeGreaterThan(0));
  });

  it('renders dataset checks with a pass badge from GET .../checks/results', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    await waitFor(() => expect(screen.getByText('min-rows')).toBeInTheDocument());
    expect(screen.getByText('pass')).toBeInTheDocument();
  });

  it('renders Pipeline lineage DAG nodes from GET /api/foundry/lineage', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-pipeline'));
    await waitFor(() => expect(screen.getByTestId('lineage-dag')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('lineage-node-ds-1')).toBeInTheDocument());
    expect(screen.getByTestId('lineage-node-tf-1')).toBeInTheDocument();
  });

  it('shows a stale badge on a stale lineage node and offers Build stale', async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      const u = url.toString();
      if (u.includes('/lineage')) {
        return jsonResponse({
          nodes: LINEAGE.nodes.map((n) => (n.id === 'ds-2' ? { ...n, stale: true } : n)),
          edges: LINEAGE.edges,
        });
      }
      if (u.includes('/summary')) return jsonResponse(SUMMARY);
      if (u.includes('/transforms')) return jsonResponse(TRANSFORMS);
      if (u.includes('/datasets')) return jsonResponse(DATASETS);
      return jsonResponse({});
    });
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-pipeline'));
    await waitFor(() => expect(screen.getByTestId('lineage-node-ds-2-stale')).toBeInTheDocument());
    expect(screen.getByText('Build stale')).toBeInTheDocument();
  });

  it('renders Builds history table with status pill', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-builds'));
    await waitFor(() => expect(screen.getByText('succeeded')).toBeInTheDocument());
    expect(screen.getAllByText('filter-ships').length).toBeGreaterThan(0); // schedule row references transform by name
  });

  it('renders Ontology bindings and a sync result', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-ontology'));
    await waitFor(() => expect(screen.getByText('vessel')).toBeInTheDocument());
    mockedFetch.mockImplementationOnce(async () =>
      jsonResponse({ minted: 3, updated: 1, skipped: 0, errors: [] }),
    );
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByTestId('sync-result')).toBeInTheDocument());
    expect(screen.getByText('minted 3')).toBeInTheDocument();
  });
});
