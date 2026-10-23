// One GET through apiFetch, reduced to data or an honest reason string that
// keeps the HTTP code. Shared by the Vertex and Workshop apps.
import { useEffect, useState } from "react";
import { apiFetch } from "../transport/http.js";

export interface JsonState<T> {
  data: T | null;
  err: string | null;
}

export function useJson<T>(path: string | null): JsonState<T> {
  const [state, setState] = useState<JsonState<T>>({ data: null, err: null });
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ data: null, err: null });
    void (async () => {
      try {
        const r = await apiFetch(path);
        if (!r.ok) {
          if (live) setState({ data: null, err: `HTTP ${r.status}` });
          return;
        }
        const body = (await r.json()) as T;
        if (live) setState({ data: body, err: null });
      } catch {
        if (live) setState({ data: null, err: "backend unreachable" });
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

export interface StatusFeed {
  name: string;
  status: string;
  detail?: string;
  count?: number;
  age_s?: number;
}
export interface PlatformStatus {
  aircraft_count?: number;
  vessel_count?: number;
  parked_count?: number;
  feeds?: StatusFeed[];
}
export interface CatalogSource {
  id?: string;
  category: string;
  name: string;
  auth?: string;
  format?: string;
  resolution?: string;
}
export interface SourceCatalog {
  total: number;
  categories: string[];
  sources: CatalogSource[];
}
export interface Bucket {
  t: number;
  aircraft: number;
  vessel: number;
  total: number;
}
export interface SeriesResponse {
  bucket_sec: number;
  buckets: Bucket[];
  degraded?: boolean;
  error?: string;
}

/** Reason a history series cannot be drawn, or null when it can. */
export function seriesProblem(s: JsonState<SeriesResponse>): string | null {
  if (s.err) return `History unavailable (${s.err}).`;
  if (!s.data) return null;
  if (s.data.degraded || s.data.error)
    return `History is off in this profile (HTTP 200, degraded${s.data.error ? `: ${s.data.error}` : ""}).`;
  if (!Array.isArray(s.data.buckets) || s.data.buckets.length === 0)
    return "Nothing recorded in this window (HTTP 200, 0 buckets).";
  return null;
}

export function fmtTime(t: number): string {
  return new Date(t * 1000).toISOString().slice(11, 16) + "Z";
}
