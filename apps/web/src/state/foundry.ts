// Foundry store — BYO-data layer (docs/foundry-plan.md). One store per domain
// per frontend.md §1: thin cached lists + loaders/CRUD, all HTTP through
// apiFetch (backend prefix /api/foundry, keyless-local). No optimistic writes
// beyond a re-fetch after mutation — build/preview/sync responses are
// returned directly to the caller so the view can render them without a
// second round trip.

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

export interface SchemaField {
  name: string;
  type: string;
}

export interface Dataset {
  id: string;
  name: string;
  description: string;
  kind: 'raw' | 'derived';
  schema: SchemaField[];
  created_at: string;
  updated_at: string;
  latest_version: number;
  row_count: number;
}

export interface DatasetVersion {
  version: number;
  row_count: number;
  source: string;
  created_at: string;
}

export interface ColumnStat {
  name: string;
  type: string;
  nulls: number;
  distinct: number;
  min?: unknown;
  max?: unknown;
}

export interface RowsPage {
  schema: SchemaField[];
  rows: Array<Record<string, unknown>>;
  total: number;
  version: number;
}

export type StepType =
  | 'select'
  | 'rename'
  | 'filter'
  | 'derive'
  | 'join'
  | 'aggregate'
  | 'union'
  | 'sort'
  | 'limit'
  | 'dedup'
  | 'cast'
  | 'window'
  | 'pivot';

export interface TransformStep {
  type: StepType;
  [key: string]: unknown;
}

export interface Transform {
  id: string;
  name: string;
  description: string;
  inputs: string[];
  output_dataset_id: string;
  steps: TransformStep[];
  created_at: string;
  updated_at: string;
}

export interface Build {
  id: string;
  transform_id: string | null;
  scope: 'transform' | 'pipeline';
  status: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at: string | null;
  rows_out: number | null;
  error: string | null;
  log: string[];
  input_versions?: Record<string, number>;
  quarantined?: number;
}

export interface Summary {
  datasets: number;
  total_rows: number;
  transforms: number;
  builds_24h: number;
  failed_builds_24h: number;
  objects_synced: number;
  recent_builds: Build[];
  checks_failing?: number;
}

export interface LineageNode {
  id: string;
  type: 'dataset' | 'transform';
  name: string;
  row_count?: number;
  kind?: string;
  stale?: boolean;
}

export interface LineageEdge {
  src: string;
  dst: string;
}

export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export interface Binding {
  id: string;
  dataset_id: string;
  object_kind: string;
  key_column: string;
  prop_map: Record<string, string>;
  enabled: boolean;
  resolve: boolean;
  last_sync: string | null;
  last_result: SyncResult | null;
  created_at: string;
}

export interface SyncResult {
  minted: number;
  updated: number;
  skipped: number;
  errors: string[];
}

export interface AutoSyncResult {
  binding_id: string;
  status: string;
  result: SyncResult | null;
  error: string | null;
}

export interface Schedule {
  id: string;
  transform_id: string;
  interval_s: number;
  enabled: boolean;
  last_run: string | null;
  last_error: string | null;
  created_at: string;
}

export type CheckType =
  | 'row_count_min'
  | 'row_count_max'
  | 'not_null'
  | 'unique'
  | 'column_exists'
  | 'freshness'
  | 'schema_contract';
export type CheckSeverity = 'warn' | 'fail';

export interface Check {
  id: string;
  dataset_id: string;
  name: string;
  type: CheckType;
  params: Record<string, unknown>;
  severity: CheckSeverity;
  enabled: boolean;
  created_at: string;
}

export interface CheckResult {
  check_id: string;
  name: string;
  type: CheckType;
  severity: CheckSeverity;
  passed: boolean;
  detail?: string;
}

export interface DeadLetterEntry {
  build_id: string;
  step: number;
  step_type: string;
  error: string;
  row: Record<string, unknown>;
  created_at: string;
}

export interface ColumnLineage {
  dataset_id: string;
  produced_by: string | null;
  primary_input?: string;
  columns: Record<string, string[]>;
}

export interface DatasetDocs {
  dataset: {
    id: string;
    name: string;
    description: string;
    kind: string;
    row_count: number;
    latest_version: number;
    created_at: string;
    updated_at: string;
  };
  schema: SchemaField[];
  versions: DatasetVersion[];
  checks: Check[];
  check_results: CheckResult[];
  lineage: {
    produced_by: string | null;
    upstream_datasets: string[];
    downstream: Array<{ transform: string; output_dataset_id: string }>;
    stale: boolean | null;
  };
  dead_letter_present: boolean;
}

// Discriminated result for mutations whose validation error the editor renders
// inline (cycle/step 422s) instead of into the shared global `error` string.
export type MutResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PreviewData {
  schema: SchemaField[];
  rows: Array<Record<string, unknown>>;
  quarantined: number;
  quarantine_sample: Array<Record<string, unknown>>;
}

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

interface FoundryState {
  summary: Summary | null;
  datasets: Dataset[];
  transforms: Transform[];
  builds: Build[];
  lineage: Lineage | null;
  bindings: Binding[];
  schedules: Schedule[];
  error: string | null;
  // Most recent auto_sync result from an upload/append/rollback (docs/foundry-plan.md
  // v2) — a dataset's enabled bindings resync on every new version; the view
  // renders this list next to the upload zone, non-blocking, until the next action.
  lastAutoSync: AutoSyncResult[] | null;

  clearAutoSync: () => void;
  loadSummary: () => Promise<void>;
  loadDatasets: () => Promise<void>;
  getDataset: (id: string) => Promise<Dataset | null>;
  createDataset: (name: string, description?: string) => Promise<Dataset | null>;
  deleteDataset: (id: string) => Promise<boolean>;
  uploadDataset: (
    file: File,
    name: string,
    description?: string,
    opts?: { types?: Record<string, string> },
  ) => Promise<Dataset | null>;
  uploadVersion: (
    id: string,
    file: File,
    mode?: 'snapshot' | 'append',
    opts?: { types?: Record<string, string>; cascade?: boolean },
  ) => Promise<(Dataset & { cascade_build?: Build }) | null>;
  rollbackDataset: (id: string, version: number) => Promise<Dataset | null>;
  getDatasetRows: (id: string, version?: number, limit?: number, offset?: number) => Promise<RowsPage | null>;
  getDatasetVersions: (id: string) => Promise<DatasetVersion[]>;
  getDatasetStats: (id: string, version?: number) => Promise<ColumnStat[]>;
  getDeadLetter: (id: string, limit?: number) => Promise<DeadLetterEntry[]>;
  getColumnLineage: (id: string) => Promise<ColumnLineage | null>;
  getDatasetDocs: (id: string) => Promise<DatasetDocs | null>;

  loadTransforms: () => Promise<void>;
  createTransform: (body: {
    name: string;
    description?: string;
    inputs: string[];
    output_name: string;
    steps: TransformStep[];
  }) => Promise<MutResult<Transform>>;
  updateTransform: (
    id: string,
    body: { name: string; description?: string; inputs: string[]; output_name: string; steps: TransformStep[] },
  ) => Promise<MutResult<Transform>>;
  deleteTransform: (id: string) => Promise<boolean>;
  // Preview an UNSAVED spec (editor form state) — POST /transforms/preview.
  previewSpec: (body: {
    inputs: string[];
    steps: TransformStep[];
    limit?: number;
  }) => Promise<MutResult<PreviewData>>;
  previewTransform: (id: string, limit?: number) => Promise<PreviewData | null>;
  buildTransform: (id: string) => Promise<Build | null>;
  buildPipeline: (onlyStale?: boolean) => Promise<Build | null>;

  loadBuilds: (limit?: number) => Promise<void>;
  loadLineage: () => Promise<void>;

  loadBindings: () => Promise<void>;
  // Ontology object kinds a binding may target (GET /kinds) — drives the picker
  // so the client never submits an object_kind that only 422s server-side.
  kinds: string[];
  loadKinds: () => Promise<void>;
  createBinding: (body: {
    dataset_id: string;
    object_kind: string;
    key_column: string;
    prop_map: Record<string, string>;
    enabled?: boolean;
    resolve?: boolean;
  }) => Promise<Binding | null>;
  updateBinding: (
    id: string,
    body: Partial<{
      dataset_id: string;
      object_kind: string;
      key_column: string;
      prop_map: Record<string, string>;
      enabled: boolean;
      resolve: boolean;
    }>,
  ) => Promise<Binding | null>;
  deleteBinding: (id: string) => Promise<boolean>;
  syncBinding: (id: string) => Promise<SyncResult | null>;

  loadSchedules: () => Promise<void>;
  createSchedule: (body: { transform_id: string; interval_s: number; enabled?: boolean }) => Promise<Schedule | null>;
  updateSchedule: (id: string, body: Partial<{ interval_s: number; enabled: boolean }>) => Promise<Schedule | null>;
  deleteSchedule: (id: string) => Promise<boolean>;

  checks: Check[];
  loadChecks: (datasetId: string) => Promise<void>;
  createCheck: (body: {
    dataset_id: string;
    name: string;
    type: CheckType;
    params: Record<string, unknown>;
    severity: CheckSeverity;
    enabled?: boolean;
  }) => Promise<Check | null>;
  updateCheck: (
    id: string,
    body: Partial<{ name: string; type: CheckType; params: Record<string, unknown>; severity: CheckSeverity; enabled: boolean }>,
  ) => Promise<Check | null>;
  deleteCheck: (id: string) => Promise<boolean>;
  getCheckResults: (datasetId: string, version?: number) => Promise<CheckResult[]>;
}

export const useFoundry = create<FoundryState>((set, get) => ({
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

  clearAutoSync: () => set({ lastAutoSync: null }),

  loadSummary: async () => {
    try {
      const r = await apiFetch('/api/foundry/summary');
      if (r.ok) set({ summary: await readJson<Summary>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'summary: request failed' });
    }
  },

  loadDatasets: async () => {
    try {
      const r = await apiFetch('/api/foundry/datasets');
      if (r.ok) set({ datasets: await readJson<Dataset[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'datasets: request failed' });
    }
  },

  getDataset: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}`);
      if (r.ok) return readJson<Dataset>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'dataset: request failed' });
      return null;
    }
  },

  createDataset: async (name, description) => {
    try {
      const r = await apiFetch('/api/foundry/datasets', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, description }),
      });
      if (r.ok) {
        const d = await readJson<Dataset>(r);
        set((s) => ({ datasets: [...s.datasets, d], error: null }));
        return d;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'create dataset: request failed' });
      return null;
    }
  },

  deleteDataset: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ datasets: s.datasets.filter((d) => d.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete dataset: request failed' });
      return false;
    }
  },

  uploadDataset: async (file, name, description, opts) => {
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', name);
      if (description) form.append('description', description);
      if (opts?.types && Object.keys(opts.types).length)
        form.append('types', JSON.stringify(opts.types));
      const r = await apiFetch('/api/foundry/datasets/upload', { method: 'POST', body: form });
      if (r.ok) {
        const d = await readJson<Dataset & { auto_sync?: AutoSyncResult[] }>(r);
        set({ lastAutoSync: d.auto_sync ?? null });
        await get().loadDatasets();
        return d;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'upload: request failed' });
      return null;
    }
  },

  uploadVersion: async (id, file, mode = 'snapshot', opts) => {
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);
      if (opts?.types && Object.keys(opts.types).length)
        form.append('types', JSON.stringify(opts.types));
      if (opts?.cascade) form.append('cascade', 'true');
      const r = await apiFetch(`/api/foundry/datasets/${id}/upload`, { method: 'POST', body: form });
      if (r.ok) {
        const d = await readJson<
          Dataset & { auto_sync?: AutoSyncResult[]; cascade_build?: Build }
        >(r);
        set({ lastAutoSync: d.auto_sync ?? null });
        await get().loadDatasets();
        return d;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'upload version: request failed' });
      return null;
    }
  },

  rollbackDataset: async (id, version) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}/rollback`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ version }),
      });
      if (r.ok) {
        const d = await readJson<Dataset & { auto_sync?: AutoSyncResult[] }>(r);
        set({ lastAutoSync: d.auto_sync ?? null });
        await get().loadDatasets();
        return d;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'rollback: request failed' });
      return null;
    }
  },

  getDatasetRows: async (id, version, limit = 50, offset = 0) => {
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (version != null) params.set('version', String(version));
      const r = await apiFetch(`/api/foundry/datasets/${id}/rows?${params.toString()}`);
      if (r.ok) return readJson<RowsPage>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'rows: request failed' });
      return null;
    }
  },

  getDatasetVersions: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}/versions`);
      if (r.ok) return readJson<DatasetVersion[]>(r);
      set({ error: await detailOf(r) });
      return [];
    } catch {
      set({ error: 'versions: request failed' });
      return [];
    }
  },

  getDatasetStats: async (id, version) => {
    try {
      const params = version != null ? `?version=${version}` : '';
      const r = await apiFetch(`/api/foundry/datasets/${id}/stats${params}`);
      if (r.ok) return readJson<ColumnStat[]>(r);
      set({ error: await detailOf(r) });
      return [];
    } catch {
      set({ error: 'stats: request failed' });
      return [];
    }
  },

  getDeadLetter: async (id, limit = 100) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}/dead-letter?limit=${limit}`);
      if (r.ok) return readJson<DeadLetterEntry[]>(r);
      set({ error: await detailOf(r) });
      return [];
    } catch {
      set({ error: 'dead-letter: request failed' });
      return [];
    }
  },

  getColumnLineage: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}/column-lineage`);
      if (r.ok) return readJson<ColumnLineage>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'column-lineage: request failed' });
      return null;
    }
  },

  getDatasetDocs: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/datasets/${id}/docs`);
      if (r.ok) return readJson<DatasetDocs>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'docs: request failed' });
      return null;
    }
  },

  loadTransforms: async () => {
    try {
      const r = await apiFetch('/api/foundry/transforms');
      if (r.ok) set({ transforms: await readJson<Transform[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'transforms: request failed' });
    }
  },

  createTransform: async (body) => {
    try {
      const r = await apiFetch('/api/foundry/transforms', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const t = await readJson<Transform>(r);
        await get().loadTransforms();
        return { ok: true, value: t };
      }
      // Validation detail (cycle/step 422) returned to the caller for inline
      // rendering — NOT pushed to the shared global `error`.
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'create transform: request failed' };
    }
  },

  updateTransform: async (id, body) => {
    try {
      const r = await apiFetch(`/api/foundry/transforms/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const t = await readJson<Transform>(r);
        await get().loadTransforms();
        return { ok: true, value: t };
      }
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'update transform: request failed' };
    }
  },

  deleteTransform: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/transforms/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ transforms: s.transforms.filter((t) => t.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete transform: request failed' });
      return false;
    }
  },

  previewSpec: async (body) => {
    try {
      const r = await apiFetch('/api/foundry/transforms/preview', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ limit: 20, ...body }),
      });
      if (r.ok) return { ok: true, value: await readJson<PreviewData>(r) };
      return { ok: false, error: await detailOf(r) };
    } catch {
      return { ok: false, error: 'preview: request failed' };
    }
  },

  previewTransform: async (id, limit = 20) => {
    try {
      const r = await apiFetch(`/api/foundry/transforms/${id}/preview`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ limit }),
      });
      if (r.ok) return readJson<PreviewData>(r);
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'preview: request failed' });
      return null;
    }
  },

  buildTransform: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/transforms/${id}/build`, { method: 'POST' });
      if (r.ok) {
        const b = await readJson<Build>(r);
        await get().loadBuilds();
        return b;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'build: request failed' });
      return null;
    }
  },

  buildPipeline: async (onlyStale = false) => {
    try {
      const r = await apiFetch('/api/foundry/pipeline/build', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ only_stale: onlyStale }),
      });
      if (r.ok) {
        const b = await readJson<Build>(r);
        await get().loadBuilds();
        return b;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'build all: request failed' });
      return null;
    }
  },

  loadBuilds: async (limit = 50) => {
    try {
      const r = await apiFetch(`/api/foundry/builds?limit=${limit}`);
      if (r.ok) set({ builds: await readJson<Build[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'builds: request failed' });
    }
  },

  loadLineage: async () => {
    try {
      const r = await apiFetch('/api/foundry/lineage');
      if (r.ok) set({ lineage: await readJson<Lineage>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'lineage: request failed' });
    }
  },

  loadBindings: async () => {
    try {
      const r = await apiFetch('/api/foundry/bindings');
      if (r.ok) set({ bindings: await readJson<Binding[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'bindings: request failed' });
    }
  },

  loadKinds: async () => {
    if (get().kinds.length) return; // static set — fetch once per session
    try {
      const r = await apiFetch('/api/foundry/kinds');
      if (r.ok) set({ kinds: (await readJson<{ kinds: string[] }>(r)).kinds, error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'kinds: request failed' });
    }
  },

  createBinding: async (body) => {
    try {
      const r = await apiFetch('/api/foundry/bindings', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const b = await readJson<Binding>(r);
        await get().loadBindings();
        return b;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'create binding: request failed' });
      return null;
    }
  },

  updateBinding: async (id, body) => {
    try {
      const r = await apiFetch(`/api/foundry/bindings/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const b = await readJson<Binding>(r);
        await get().loadBindings();
        return b;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'update binding: request failed' });
      return null;
    }
  },

  deleteBinding: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/bindings/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ bindings: s.bindings.filter((b) => b.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete binding: request failed' });
      return false;
    }
  },

  syncBinding: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/bindings/${id}/sync`, { method: 'POST' });
      if (r.ok) {
        const res = await readJson<SyncResult>(r);
        await get().loadBindings();
        return res;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'sync: request failed' });
      return null;
    }
  },

  loadSchedules: async () => {
    try {
      const r = await apiFetch('/api/foundry/schedules');
      if (r.ok) set({ schedules: await readJson<Schedule[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'schedules: request failed' });
    }
  },

  createSchedule: async (body) => {
    try {
      const r = await apiFetch('/api/foundry/schedules', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const s = await readJson<Schedule>(r);
        await get().loadSchedules();
        return s;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'create schedule: request failed' });
      return null;
    }
  },

  updateSchedule: async (id, body) => {
    try {
      const r = await apiFetch(`/api/foundry/schedules/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const s = await readJson<Schedule>(r);
        await get().loadSchedules();
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
      const r = await apiFetch(`/api/foundry/schedules/${id}`, { method: 'DELETE' });
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

  loadChecks: async (datasetId) => {
    try {
      const r = await apiFetch(`/api/foundry/checks?dataset_id=${datasetId}`);
      if (r.ok) set({ checks: await readJson<Check[]>(r), error: null });
      else set({ error: await detailOf(r) });
    } catch {
      set({ error: 'checks: request failed' });
    }
  },

  createCheck: async (body) => {
    try {
      const r = await apiFetch('/api/foundry/checks', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const c = await readJson<Check>(r);
        await get().loadChecks(body.dataset_id);
        return c;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'create check: request failed' });
      return null;
    }
  },

  updateCheck: async (id, body) => {
    try {
      const r = await apiFetch(`/api/foundry/checks/${id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const c = await readJson<Check>(r);
        const datasetId = get().checks.find((x) => x.id === id)?.dataset_id ?? c.dataset_id;
        await get().loadChecks(datasetId);
        return c;
      }
      set({ error: await detailOf(r) });
      return null;
    } catch {
      set({ error: 'update check: request failed' });
      return null;
    }
  },

  deleteCheck: async (id) => {
    try {
      const r = await apiFetch(`/api/foundry/checks/${id}`, { method: 'DELETE' });
      if (r.ok) {
        set((s) => ({ checks: s.checks.filter((c) => c.id !== id), error: null }));
        return true;
      }
      set({ error: await detailOf(r) });
      return false;
    } catch {
      set({ error: 'delete check: request failed' });
      return false;
    }
  },

  getCheckResults: async (datasetId, version) => {
    try {
      const params = version != null ? `?version=${version}` : '';
      const r = await apiFetch(`/api/foundry/datasets/${datasetId}/checks/results${params}`);
      if (r.ok) return readJson<CheckResult[]>(r);
      set({ error: await detailOf(r) });
      return [];
    } catch {
      set({ error: 'check results: request failed' });
      return [];
    }
  },
}));
