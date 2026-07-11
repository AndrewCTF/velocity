// Shared response/request shapes for the local-LLM engine + model manager +
// selection-inference feature (design: local-llm-design.md, 2026-07-11).
// Mirrors the backend API contract exactly — the frontend codes to this
// contract, not to a live server, so field names here MUST match the backend
// 1:1. Keep in sync with apps/api if the contract changes.

export type EngineId = 'auto' | 'llamacpp' | 'vllm' | 'ollama';
export type PresetId = 'speed' | 'medium' | 'quality';

export interface EngineStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
}

export interface ActiveModels {
  main: string | null;
  selection: string | null;
}

export interface InstalledModel {
  key: string;
  repo_id: string;
  quant: string;
  filename: string;
  size_bytes: number;
  tier: string | null;
  roles: ('main' | 'selection')[];
  hot: boolean;
}

export interface CatalogQuant {
  q: string;
  size_gb: number;
  fits_now: boolean;
}

export interface CatalogRunnerUp {
  repo_id: string;
  label: string;
}

export interface CatalogEntry {
  tier: string;
  label: string;
  repo_id: string;
  params: string;
  active_params: string;
  ctx: string;
  license: string;
  recommended_quant: string;
  quants: CatalogQuant[];
  runner_up: CatalogRunnerUp | null;
}

export interface ModelsResponse {
  engines: {
    llamacpp: EngineStatus;
    vllm: EngineStatus;
    ollama: EngineStatus;
  };
  active: ActiveModels;
  hot: string[];
  installed: InstalledModel[];
  catalog: CatalogEntry[];
}

export interface HardwareGpu {
  name: string;
  vram_mb: number;
}

export interface HardwarePreset {
  tier: string;
  repo_id: string;
  quant: string;
  est_size_gb: number;
  fits: boolean;
  reason: string;
  refused_reason?: string;
}

export interface HardwareRecommendation {
  preset: PresetId;
  tier: string;
  repo_id: string;
  quant: string;
  reason: string;
}

export interface HardwareResponse {
  gpu: HardwareGpu | null;
  ram_mb: number;
  disk_free_mb: number;
  recommendation: HardwareRecommendation;
  presets: Record<PresetId, HardwarePreset>;
}

export type DownloadStatus = 'queued' | 'downloading' | 'verifying' | 'done' | 'error';

export interface DownloadJob {
  status: DownloadStatus;
  progress_pct: number;
  bytes_done: number;
  bytes_total: number;
  error: string | null;
  key: string | null;
}

export interface LocalAiConfig {
  // Pre-existing fields (Part 4, local-inference toggle).
  enabled: boolean;
  ollama_up: boolean;
  tool_capable: boolean;
  models: string[];
  model_fast: string;
  model_reason: string;
  // New fields (local-LLM engine manager, 2026-07-11).
  engine: EngineId;
  selection_model: string | null;
  selection_enabled: boolean;
}

export interface SelectionBriefResponse {
  ok: boolean;
  text: string;
  model: string;
  backend: string;
  latency_ms: number;
  cached: boolean;
}

// Custom download field is restricted to the unsloth org — enforced both here
// (client-side gate on the download button) and server-side (422 on mismatch).
export const UNSLOTH_REPO_RE = /^unsloth\/[A-Za-z0-9._-]{1,96}$/;

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
