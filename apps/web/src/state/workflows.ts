// Workflows store — user-authored DAG pipelines over live platform data
// (docs/dashboard-workflows-plan.md §2). One store per domain per
// frontend.md §1, same idiom as state/foundry.ts: thin cached lists +
// loaders/CRUD, all HTTP through apiFetch (backend prefix /api/workflows,
// keyless-local). Types mirror the backend exactly:
//   apps/api/app/routes/workflows.py  — request/response models
//   apps/api/app/workflows/blocks.py  — ConfigField.to_json / BlockSpec.to_json
//   apps/api/app/workflows/store.py   — workflow/run/schedule row shapes
//   apps/api/app/workflows/engine.py  — spec format {blocks:[{id,type,config}],
//     edges:[{from,to}]}; preview_workflow's {blocks: {id: {type, rows_in,
//     rows_out, sample, error}}} response.

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

// ── block catalog (GET /api/workflows/blocks) ───────────────────────────────

export type ConfigFieldType = 'string' | 'int' | 'float' | 'bool' | 'text' | 'select' | 'json';

export interface ConfigFieldSpec {
  key: string;
  type: ConfigFieldType;
  label: string;
  required: boolean;
  default?: unknown;
  options?: string[];
  placeholder?: string;
  help?: string;
}

export type BlockCategory = 'source' | 'op' | 'sink' | 'control';

export interface BlockCatalogEntry {
  type: string;
  category: BlockCategory;
  title: string;
  description: string;
  min_inputs: number;
  max_inputs: number;
  config_schema: ConfigFieldSpec[];
}

// ── workflow spec (engine.py ground truth: blocks[{id,type,config}], edges[{from,to}]) ──

export interface WorkflowBlock {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowSpec {
  blocks: WorkflowBlock[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  spec: WorkflowSpec;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ── runs ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type RunTrigger = 'manual' | 'schedule';

export interface Run {
  id: string;
  workflow_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  trigger: RunTrigger;
  log: string[];
  error: string | null;
  // Terminal blocks' row samples, keyed by block id (≤200 rows/block).
  output: Record<string, Array<Record<string, unknown>>>;
}

// ── schedules ────────────────────────────────────────────────────────────────

export interface Schedule {
  id: string;
  workflow_id: string;
  interval_s: number;
  enabled: boolean;
  last_run: string | null;
  created_at: string;
  last_error: string | null;
}

// ── preview (POST /api/workflows/preview — unsaved spec) ────────────────────

export interface PreviewBlockResult {
  type: string;
  rows_in: number;
  rows_out: number;
  sample: Array<Record<string, unknown>>;
  error: string | null;
}

export interface PreviewResult {
  blocks: Record<string, PreviewBlockResult>;
}

// Discriminated result for mutations whose validation error (name conflict
// 409, DAG-validation 422) the editor renders inline instead of into the
// shared global `error` string — same contract as state/foundry.ts::MutResult.
export type MutResult<T> = { ok: true; value: T } | { ok: false; error: string };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function readJson<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

async function detailOf(r: Response): Promise<string> {
  try {
    const body = (await r.json()) as { detail?: string };
    return body.detail ?? `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

interface WorkflowsState {
  workflows: Workflow[];
  blocks: BlockCatalogEntry[];
  runs: Run[];
  schedules: Schedule[];
  error: string | null;

  loadWorkflows: () => Promise<void>;
  getWorkflow: (id: string) => Promise<Workflow | null>;
  createWorkflow: (
    name: string,
    description: string,
    spec: WorkflowSpec,
    enabled?: boolean,
  ) => Promise<MutResult<Workflow>>;
  updateWorkflow: (
    id: string,
    name: string,
    description: string,
    spec: WorkflowSpec,
    enabled: boolean,
  ) => Promise<MutResult<Workflow>>;
  deleteWorkflow: (id: string) => Promise<boolean>;

  loadBlocks: () => Promise<void>;

  // POST /api/workflows/preview — an UNSAVED spec, the editor's live form state.
  previewWorkflow: (spec: WorkflowSpec) => Promise<MutResult<PreviewResult>>;
  // POST /api/workflows/{id}/run — execute now (await, returns the finished run).
  runWorkflow: (id: string) => Promise<Run | null>;

  loadRuns: (workflowId: string, limit?: number) => Promise<void>;
  getRun: (runId: string) => Promise<Run | null>;

  loadSchedules: (workflowId?: string) => Promise<void>;
  createSchedule: (workflowId: string, intervalS: number, enabled?: boolean) => Promise<Schedule | null>;
  updateSchedule: (
    id: string,
    workflowId: string,
    intervalS: number,
    enabled: boolean,
  ) => Promise<Schedule | null>;
  deleteSchedule: (id: string) => Promise<boolean>;

  getMemory: (workflowId: string) => Promise<Record<string, unknown> | null>;
  putMemory: (workflowId: string, memory: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
}

export const useWorkflows = create<WorkflowsState>((set, get) => ({
  workflows: [],
  blocks: [],
  runs: [],
  schedules: [],
  error: null,

  loadWorkflows: async () => {
    try {
      const r = await apiFetch('/api/workflows');
      if (r.ok) set({ workflows: await readJson<Workflow[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'workflows: request failed' });
    }
  },

  getWorkflow: async (id) => {
    try {
      const r = await apiFetch(`/api/workflows/${id}`);
      if (r.ok) return readJson<Workflow>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'workflow: request failed' });
      return null;
    }
  },

  createWorkflow: async (name, description, spec, enabled = true) => {
    try {
      const r = await apiFetch('/api/workflows', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, description, spec, enabled }),
      });
      if (r.ok) {
        const w = await readJson<Workflow>(r);
        await get().loadWorkflows();
        return { ok: true, value: w };
      }
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'create workflow: request failed' };
    }
  },

  updateWorkflow: async (id, name, description, spec, enabled) => {
    try {
      const r = await apiFetch(`/api/workflows/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, description, spec, enabled }),
      });
      if (r.ok) {
        const w = await readJson<Workflow>(r);
        await get().loadWorkflows();
        return { ok: true, value: w };
      }
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'update workflow: request failed' };
    }
  },

  deleteWorkflow: async (id) => {
    try {
      const r = await apiFetch(`/api/workflows/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete workflow: request failed' });
      return false;
    }
  },

  loadBlocks: async () => {
    if (get().blocks.length) return; // static catalog — fetch once per session
    try {
      const r = await apiFetch('/api/workflows/blocks');
      if (r.ok) set({ blocks: await readJson<BlockCatalogEntry[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'blocks: request failed' });
    }
  },

  previewWorkflow: async (spec) => {
    try {
      const r = await apiFetch('/api/workflows/preview', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ blocks: spec.blocks, edges: spec.edges }),
      });
      if (r.ok) return { ok: true, value: await readJson<PreviewResult>(r) };
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'preview: request failed' };
    }
  },

  runWorkflow: async (id) => {
    try {
      const r = await apiFetch(`/api/workflows/${id}/run`, { method: 'POST' });
      if (r.ok) return readJson<Run>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'run: request failed' });
      return null;
    }
  },

  loadRuns: async (workflowId, limit = 50) => {
    try {
      const r = await apiFetch(`/api/workflows/${workflowId}/runs?limit=${limit}`);
      if (r.ok) set({ runs: await readJson<Run[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'runs: request failed' });
    }
  },

  getRun: async (runId) => {
    try {
      const r = await apiFetch(`/api/workflows/runs/${runId}`);
      if (r.ok) return readJson<Run>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'run: request failed' });
      return null;
    }
  },

  loadSchedules: async (workflowId) => {
    try {
      const params = workflowId ? `?workflow_id=${workflowId}` : '';
      const r = await apiFetch(`/api/workflows/schedules${params}`);
      if (r.ok) set({ schedules: await readJson<Schedule[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'schedules: request failed' });
    }
  },

  createSchedule: async (workflowId, intervalS, enabled = true) => {
    try {
      const r = await apiFetch('/api/workflows/schedules', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ workflow_id: workflowId, interval_s: intervalS, enabled }),
      });
      if (r.ok) {
        const s = await readJson<Schedule>(r);
        await get().loadSchedules(workflowId);
        return s;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'create schedule: request failed' });
      return null;
    }
  },

  updateSchedule: async (id, workflowId, intervalS, enabled) => {
    try {
      // ScheduleIn requires workflow_id on every write, including update.
      const r = await apiFetch(`/api/workflows/schedules/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ workflow_id: workflowId, interval_s: intervalS, enabled }),
      });
      if (r.ok) {
        const s = await readJson<Schedule>(r);
        await get().loadSchedules(workflowId);
        return s;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'update schedule: request failed' });
      return null;
    }
  },

  deleteSchedule: async (id) => {
    try {
      const r = await apiFetch(`/api/workflows/schedules/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ schedules: s.schedules.filter((sc) => sc.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete schedule: request failed' });
      return false;
    }
  },

  getMemory: async (workflowId) => {
    try {
      const r = await apiFetch(`/api/workflows/${workflowId}/memory`);
      if (r.ok) return (await readJson<{ memory: Record<string, unknown> }>(r)).memory;
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'memory: request failed' });
      return null;
    }
  },

  putMemory: async (workflowId, memory) => {
    try {
      const r = await apiFetch(`/api/workflows/${workflowId}/memory`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ memory }),
      });
      if (r.ok) return (await readJson<{ memory: Record<string, unknown> }>(r)).memory;
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'memory: request failed' });
      return null;
    }
  },
}));
