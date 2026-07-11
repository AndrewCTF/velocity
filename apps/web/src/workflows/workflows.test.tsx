import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsApp } from './WorkflowsApp.js';
import { useWorkflows } from '../state/workflows.js';
import { useWorkflowsNav } from './nav.js';
import { useAppView } from '../state/appView.js';

// Mock apiFetch at the transport boundary (per repo eslint guard, everything
// goes through it) so each view can be exercised without a live backend —
// same idiom as foundry/foundry.test.tsx.
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

const BLOCKS = [
  {
    type: 'source.aircraft',
    category: 'source',
    title: 'Aircraft (live)',
    description: 'Live global ADS-B snapshot.',
    min_inputs: 0,
    max_inputs: 0,
    config_schema: [
      { key: 'bbox', type: 'string', label: 'Bounding box (optional)', required: false, placeholder: 'min_lon,min_lat,max_lon,max_lat' },
    ],
  },
  {
    type: 'op.steps',
    category: 'op',
    title: 'Steps (Foundry DSL)',
    description: 'filter/derive/join/aggregate/sort/limit/dedup/select/rename/cast.',
    min_inputs: 1,
    max_inputs: 2,
    config_schema: [{ key: 'steps', type: 'json', label: 'Steps (JSON list)', required: true, help: 'e.g. [{"type":"filter"}]' }],
  },
  {
    type: 'sink.alert',
    category: 'sink',
    title: 'Alert',
    description: 'Publish an Alert to the live bus, capped 20/run.',
    min_inputs: 1,
    max_inputs: 1,
    config_schema: [
      { key: 'mode', type: 'select', label: 'Mode', required: false, default: 'summary', options: ['summary', 'per_row'] },
      { key: 'severity', type: 'select', label: 'Severity', required: false, default: 'info', options: ['info', 'low', 'medium', 'high', 'critical'] },
      { key: 'message_template', type: 'string', label: 'Message template', required: false, help: 'summary: {count}.' },
    ],
  },
];

const WORKFLOWS = [
  {
    id: 'wf-1',
    name: 'aircraft-alert',
    description: 'demo workflow',
    spec: { blocks: [{ id: 'src1', type: 'source.aircraft', config: {} }], edges: [] },
    enabled: true,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
];

const RUNS = [
  {
    id: 'run-1',
    workflow_id: 'wf-1',
    status: 'succeeded',
    started_at: '2026-07-08T00:00:00Z',
    finished_at: '2026-07-08T00:00:05Z',
    trigger: 'manual',
    log: ['run run-1 started for workflow \'aircraft-alert\'', '[src1] source.aircraft 0→3 5ms'],
    error: null,
    output: { src1: [{ icao24: 'abc123', callsign: 'UAL1' }] },
  },
];

function routeFetch(): void {
  mockedFetch.mockImplementation(async (url: string) => {
    const u = url.toString();
    if (u.includes('/api/workflows/blocks')) return jsonResponse(BLOCKS);
    if (u.includes('/api/workflows/preview')) return jsonResponse({ blocks: {} });
    if (/\/api\/workflows\/runs\/[^/]+$/.exec(u)) return jsonResponse(RUNS[0]);
    if (/\/api\/workflows\/[^/]+\/runs/.exec(u)) return jsonResponse(RUNS);
    if (u.includes('/api/workflows/schedules')) return jsonResponse([]);
    if (/\/api\/workflows\/[^/]+\/memory/.exec(u)) return jsonResponse({ memory: {} });
    if (/\/api\/workflows\/[^/]+$/.exec(u)) return jsonResponse(WORKFLOWS[0]);
    if (u.includes('/api/workflows')) return jsonResponse(WORKFLOWS);
    return jsonResponse({});
  });
}

describe('WorkflowsApp', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    routeFetch();
    // Views load via useWorkflowsPoll, gated on app === 'workflows'.
    useAppView.setState({ app: 'workflows' });
    useWorkflowsNav.setState({ view: 'workflows', selectedId: null });
    window.history.replaceState(null, '', '/');
    useWorkflows.setState({ workflows: [], blocks: [], runs: [], schedules: [], error: null });
  });

  it('renders the workflow list from GET /api/workflows', async () => {
    render(<WorkflowsApp />);
    await waitFor(() => expect(screen.getByTestId('workflow-row-wf-1')).toBeInTheDocument());
    expect(screen.getByText('aircraft-alert')).toBeInTheDocument();
  });

  it('renders the palette grouped by category from the mocked block catalog', async () => {
    render(<WorkflowsApp />);
    await waitFor(() => expect(screen.getByTestId('workflow-row-wf-1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ New'));
    // The canvas toolbar AND the empty-state action both render "+ Add
    // block" while the DAG has zero nodes — either one opens the same modal.
    fireEvent.click(screen.getAllByText('+ Add block')[0] as Element);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Sources')).toBeInTheDocument();
    expect(within(dialog).getByText('Ops')).toBeInTheDocument();
    expect(within(dialog).getByText('Sinks')).toBeInTheDocument();
    expect(within(dialog).getByText('Aircraft (live)')).toBeInTheDocument();
    expect(within(dialog).getByText('Steps (Foundry DSL)')).toBeInTheDocument();
    expect(within(dialog).getByTestId('palette-block-sink.alert')).toBeInTheDocument();
  });

  it('adding two blocks then connecting them draws an edge in the spec', async () => {
    render(<WorkflowsApp />);
    await waitFor(() => expect(screen.getByTestId('workflow-row-wf-1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ New'));

    fireEvent.click(screen.getAllByText('+ Add block')[0] as Element);
    fireEvent.click(await screen.findByTestId('palette-block-source.aircraft'));

    fireEvent.click(screen.getByText('+ Add block'));
    fireEvent.click(await screen.findByTestId('palette-block-sink.alert'));

    const dag = screen.getByTestId('workflow-dag');
    await waitFor(() => expect(dag.querySelectorAll('[data-node]').length).toBe(2));
    expect(dag.querySelectorAll('path[data-testid^="edge-"]').length).toBe(0);

    fireEvent.click(screen.getByText('connect'));
    const nodes = dag.querySelectorAll('[data-node]');
    fireEvent.click(nodes[0] as Element);
    fireEvent.click(nodes[1] as Element);

    await waitFor(() => expect(dag.querySelectorAll('path[data-testid^="edge-"]').length).toBe(1));
  });

  it('config panel renders schema-driven fields for the selected block', async () => {
    render(<WorkflowsApp />);
    await waitFor(() => expect(screen.getByTestId('workflow-row-wf-1')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ New'));
    fireEvent.click(screen.getAllByText('+ Add block')[0] as Element);
    fireEvent.click(await screen.findByTestId('palette-block-sink.alert'));

    const panel = await screen.findByTestId('config-panel');
    expect(within(panel).getByText('Alert')).toBeInTheDocument();
    expect(within(panel).getByText('Mode')).toBeInTheDocument();
    expect(within(panel).getByText('Severity')).toBeInTheDocument();
    expect(within(panel).getByText('Message template')).toBeInTheDocument();
  });

  it('Runs view renders a mocked run log and its output sample', async () => {
    render(<WorkflowsApp />);
    fireEvent.click(screen.getByTestId('workflows-nav-runs'));
    await waitFor(() => expect(screen.getByTestId('run-row-run-1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('run-row-run-1'));
    await waitFor(() => expect(screen.getByText(/source\.aircraft 0→3/)).toBeInTheDocument());
    expect(screen.getByText('abc123')).toBeInTheDocument();
  });

  it('Blocks view renders one card per catalog entry', async () => {
    render(<WorkflowsApp />);
    fireEvent.click(screen.getByTestId('workflows-nav-blocks'));
    await waitFor(() => expect(screen.getByTestId('block-card-source.aircraft')).toBeInTheDocument());
    expect(screen.getByTestId('block-card-op.steps')).toBeInTheDocument();
    expect(screen.getByTestId('block-card-sink.alert')).toBeInTheDocument();
  });
});

describe('useWorkflowsNav', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    useWorkflowsNav.setState({ view: 'workflows', selectedId: null });
  });

  it('defaults to the workflows view with no selection', () => {
    expect(useWorkflowsNav.getState().view).toBe('workflows');
    expect(useWorkflowsNav.getState().selectedId).toBeNull();
  });

  it('setView persists wv= and clears the selection', () => {
    useWorkflowsNav.getState().select('wf-1');
    useWorkflowsNav.getState().setView('runs');
    expect(useWorkflowsNav.getState().view).toBe('runs');
    expect(useWorkflowsNav.getState().selectedId).toBeNull();
    expect(window.location.search).toContain('wv=runs');
  });

  it('select persists wid= without touching wv', () => {
    useWorkflowsNav.getState().select('wf-9');
    expect(window.location.search).toContain('wid=wf-9');
  });

  it('navigate jumps view and selection together', () => {
    useWorkflowsNav.getState().navigate('blocks', 'b-1');
    expect(useWorkflowsNav.getState().view).toBe('blocks');
    expect(useWorkflowsNav.getState().selectedId).toBe('b-1');
    expect(window.location.search).toContain('wv=blocks');
    expect(window.location.search).toContain('wid=b-1');
  });

  it('coexists with an unrelated ?app= param', () => {
    window.history.replaceState(null, '', '/?app=workflows');
    useWorkflowsNav.getState().setView('runs');
    expect(window.location.search).toContain('app=workflows');
    expect(window.location.search).toContain('wv=runs');
  });

  it('the default view omits wv= from the URL', () => {
    useWorkflowsNav.getState().setView('runs');
    useWorkflowsNav.getState().setView('workflows');
    expect(window.location.search).not.toContain('wv=');
  });
});
