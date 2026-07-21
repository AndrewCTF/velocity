// Shared payload shapes for the Markets app (backend contract: module B2a,
// thin routes at /api/markets/{snapshot,predictions,stress}). Kept in one file
// so SnapshotCard/StressCard/PredictionsCard/MarketsApp agree on the shape
// without importing from each other.

export interface SnapshotItem {
  symbol: string;
  name: string;
  last: number | null;
  change_pct_24h: number | null;
  ts: string | null;
}

export interface SnapshotResponse {
  indices: SnapshotItem[];
  commodities: SnapshotItem[];
  fx: SnapshotItem[];
  crypto: SnapshotItem[];
  asof_utc: string | null;
  unavailable?: boolean;
}

export interface StressComponent {
  key: string;
  value: number | null;
  normalized: number;
  weight: number;
  inputs?: Record<string, unknown>;
}

export interface StressResponse {
  score: number;
  components: StressComponent[];
  asof_utc: string | null;
  degraded?: boolean;
}

export interface PredictionItem {
  question: string;
  prob: number;
  volume_24h: number | null;
  url: string;
}

export interface PredictionsResponse {
  items: PredictionItem[];
  unavailable?: boolean;
}

// Generic fetch state, mirroring country/shared.tsx's FetchState.
export type FetchState<T> = { loading: boolean; error: string | null; data: T | null };
