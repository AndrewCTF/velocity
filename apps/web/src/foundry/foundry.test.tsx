import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FoundryApp } from './FoundryApp.js';
import { useFoundry } from '../state/foundry.js';
import { useFoundryNav } from './nav.js';
import { useAppView } from '../state/appView.js';

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
  checks_failing: 0,
  recent_builds: [
    {
      id: 'build-1',
      transform_id: 'tf-1',
      scope: 'transform',
      status: 'succeeded',
      started_at: '2026-07-08T00:00:00Z',
      finished_at: '2026-07-08T00:00:05Z',
      rows_out: 10,
      quarantined: 0,
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
    quarantined: 0,
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
    resolve: false,
    last_sync: null,
    last_result: null,
    created_at: '2026-07-01T00:00:00Z',
  },
];

const KINDS = ['vessel', 'aircraft', 'person', 'facility'];
const SCHEDULES = [{ id: 'sch-1', transform_id: 'tf-1', interval_s: 3600, enabled: true, last_run: null, last_error: null, created_at: '2026-07-01T00:00:00Z' }];
const CHECKS = [{ id: 'chk-1', dataset_id: 'ds-1', name: 'min-rows', type: 'row_count_min', params: { min: 1 }, severity: 'warn', enabled: true, created_at: '2026-07-01T00:00:00Z' }];
const CHECK_RESULTS = [{ check_id: 'chk-1', name: 'min-rows', type: 'row_count_min', severity: 'warn', passed: true }];
const DATASET_1 = DATASETS[0]!;

const DATASET_DOCS = {
  dataset: { id: 'ds-1', name: 'ships', description: 'demo', kind: 'raw', row_count: 100, latest_version: 1, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  schema: [{ name: 'mmsi', type: 'int' }],
  versions: [{ version: 1, row_count: 100, source: 'upload', created_at: '2026-07-01T00:00:00Z' }],
  checks: CHECKS,
  check_results: CHECK_RESULTS,
  lineage: { produced_by: null, upstream_datasets: [], downstream: [{ transform: 'tf-1', output_dataset_id: 'ds-2' }], stale: false },
  dead_letter_present: false,
};

function routeFetch(): void {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.includes('/summary')) return jsonResponse(SUMMARY);
    if (u.includes('/datasets/upload')) return jsonResponse({ ...DATASET_1, auto_sync: [] });
    if (u.includes('/datasets') && u.includes('/rollback')) return jsonResponse({ ...DATASET_1, auto_sync: [] });
    if (u.includes('/datasets') && u.includes('/docs')) return jsonResponse(DATASET_DOCS);
    if (u.includes('/datasets') && u.includes('/checks/results')) return jsonResponse(CHECK_RESULTS);
    if (u.includes('/foundry/checks')) return jsonResponse(CHECKS);
    if (u.includes('/datasets') && u.includes('/rows')) return jsonResponse({ schema: DATASET_1.schema, rows: [{ mmsi: 1 }], total: 1, version: 1 });
    if (u.includes('/datasets') && u.includes('/versions')) return jsonResponse([{ version: 1, row_count: 100, source: 'upload', created_at: '2026-07-01T00:00:00Z' }]);
    if (u.includes('/datasets') && u.includes('/stats')) return jsonResponse([{ name: 'mmsi', type: 'int', nulls: 0, distinct: 100, min: 1, max: 999 }]);
    if (u.includes('/transforms') && u.includes('/preview')) return jsonResponse({ schema: [{ name: 'mmsi', type: 'int' }], rows: [{ mmsi: 1 }], quarantined: 0, quarantine_sample: [] });
    if (u.match(/\/datasets\/[^/]+$/)) return jsonResponse(DATASET_1);
    if (u.includes('/datasets')) return jsonResponse(DATASETS);
    if (u.includes('/transforms')) return jsonResponse(TRANSFORMS);
    if (u.includes('/builds')) return jsonResponse(BUILDS);
    if (u.includes('/lineage')) return jsonResponse(LINEAGE);
    if (u.includes('/bindings')) return jsonResponse(BINDINGS);
    if (u.includes('/schedules')) return jsonResponse(SCHEDULES);
    if (u.includes('/kinds')) return jsonResponse({ kinds: KINDS });
    return jsonResponse({});
  });
}

describe('FoundryApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    routeFetch();
    // Views load via useFoundryPoll, gated on app === 'foundry'.
    useAppView.setState({ app: 'foundry' });
    // Reset the nav store + URL so fv/fid/ftab never leak between cases.
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
      error: null,
      lastAutoSync: null,
    });
  });

  it('renders Home with stat cards from GET /api/foundry/summary', async () => {
    render(<FoundryApp viewer={null} />);
    await waitFor(() => expect(screen.getByText('1,234')).toBeInTheDocument());
    expect(screen.getAllByText('Datasets').length).toBeGreaterThan(0);
    expect(screen.getByText('Objects synced')).toBeInTheDocument();
  });

  it('renders Datasets master-detail and the detail on click', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    // detail pane shows the schema column on the Schema tab
    await waitFor(() => expect(screen.getAllByText(/mmsi/).length).toBeGreaterThan(0));
  });

  it('renders dataset checks under the Checks tab with a pass badge', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    fireEvent.click(screen.getByText('Checks'));
    await waitFor(() => expect(screen.getByText('min-rows')).toBeInTheDocument());
    expect(screen.getByText('pass')).toBeInTheDocument();
  });

  it('renders the Docs tab from GET .../docs with downstream lineage', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    fireEvent.click(screen.getByText('Docs'));
    await waitFor(() => expect(screen.getByTestId('docs-tab')).toBeInTheDocument());
    expect(screen.getByText('demo')).toBeInTheDocument();
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
        return jsonResponse({ nodes: LINEAGE.nodes.map((n) => (n.id === 'ds-2' ? { ...n, stale: true } : n)), edges: LINEAGE.edges });
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

  it('renders Builds history with the transform NAME (not its id)', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-builds'));
    await waitFor(() => expect(screen.getByText('succeeded')).toBeInTheDocument());
    expect(screen.getAllByText('filter-ships').length).toBeGreaterThan(0);
    expect(screen.queryByText('tf-1')).toBeNull(); // no raw id in the table
  });

  it('humanizes schedule intervals (3600s → 1h)', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-builds'));
    await waitFor(() => expect(screen.getByText('1h')).toBeInTheDocument());
  });

  it('renders Ontology bindings and a sync result', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-ontology'));
    await waitFor(() => expect(screen.getByText('vessel')).toBeInTheDocument());
    mockedFetch.mockImplementationOnce(async () => jsonResponse({ minted: 3, updated: 1, skipped: 0, errors: [] }));
    fireEvent.click(screen.getByText('Sync'));
    await waitFor(() => expect(screen.getByTestId('sync-result')).toBeInTheDocument());
    expect(screen.getByText('minted 3')).toBeInTheDocument();
  });

  it('offers the object-kind picker populated from GET /kinds', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-ontology'));
    await waitFor(() => expect(screen.getByText('vessel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ New binding'));
    const dialog = await screen.findByRole('dialog');
    const kindSelect = within(dialog).getByLabelText('Object kind');
    expect(kindSelect).toBeInTheDocument();
    // the kinds list loaded from /kinds populates the select options
    expect(within(kindSelect).getByText('aircraft')).toBeInTheDocument();
  });

  it('deep-links: selecting a dataset writes fv/fid to the URL', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    await waitFor(() => expect(window.location.search).toContain('fv=datasets'));
    expect(window.location.search).toContain('fid=ds-1');
  });

  it('delete-dataset confirm: cancel does not call DELETE', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    fireEvent.click(screen.getByText('Delete'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockedFetch.mock.calls.some((c) => c[0].toString().includes('/datasets/ds-1') && (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('UploadModal sends pinned types + cascade on a version upload', async () => {
    render(<FoundryApp viewer={null} />);
    fireEvent.click(screen.getByTestId('foundry-nav-datasets'));
    await waitFor(() => expect(screen.getByText('ships')).toBeInTheDocument());
    fireEvent.click(screen.getByText('ships'));
    fireEvent.click(screen.getByText('⇪ Upload version'));
    const dialog = await screen.findByRole('dialog');
    const file = new File(['mmsi,name\n1,a\n'], 'v2.csv', { type: 'text/csv' });
    const input = dialog.querySelector('input[type=file]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(within(dialog).getByText('mmsi')).toBeInTheDocument());
    // pin the mmsi column to int (the select sits beside the mmsi label span)
    const mmsiRow = within(dialog).getByText('mmsi').closest('div')!;
    const typeSelect = within(mmsiRow).getByDisplayValue('auto') as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: 'int' } });
    // enable cascade
    const cascadeCheck = within(dialog).getByLabelText('rebuild downstream') as HTMLInputElement;
    fireEvent.click(cascadeCheck);
    fireEvent.click(within(dialog).getByText('Upload version'));
    const uploadCall = mockedFetch.mock.calls.find((c) => c[0].toString().includes('/datasets/ds-1/upload'));
    expect(uploadCall).toBeTruthy();
    const form = (uploadCall![1] as RequestInit).body as FormData;
    expect(form.get('cascade')).toBe('true');
    const types = JSON.parse(form.get('types') as string) as Record<string, string>;
    expect(types.mmsi).toBe('int');
  });
});
