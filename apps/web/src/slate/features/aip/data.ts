// Live data for the AIP copy. Each value the copy page baked from its snapshot
// (gotham/aip/overlay/aa-data.json) is read here from the same :8000 route the
// builder snapshotted, and the builder's derivations are ported as pure
// functions below (tested in data.test.ts).
import { useEffect, useState } from "react";
import { apiFetch } from "../../../transport/http.js";

export interface Res<T> {
  path: string;
  status: number; // 0 = network error
  ok: boolean;
  data: T | null;
  ms: number;
  detail: string;
}

const cache = new Map<string, Promise<Res<unknown>>>();
/** Every request this app made, in order: the hand-off inspector's trace. */
export const reqLog: Res<unknown>[] = [];

async function load<T>(path: string): Promise<Res<T>> {
  const t0 = performance.now();
  let res: Res<T>;
  try {
    const r = await apiFetch(path);
    const body: unknown = await r.json().catch(() => null);
    const detail =
      !r.ok && body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : "";
    res = {
      path,
      status: r.status,
      ok: r.ok,
      data: r.ok ? (body as T) : null,
      ms: performance.now() - t0,
      detail,
    };
  } catch {
    res = {
      path,
      status: 0,
      ok: false,
      data: null,
      ms: performance.now() - t0,
      detail: "network error",
    };
  }
  reqLog.push(res as Res<unknown>);
  return res;
}

export function fetchJson<T>(path: string, fresh = false): Promise<Res<T>> {
  if (fresh || !cache.has(path)) cache.set(path, load<T>(path));
  return cache.get(path) as Promise<Res<T>>;
}

/** Drop the session cache (the app refetches every route each time it opens). */
export function resetCache(): void {
  cache.clear();
  reqLog.length = 0;
}

/** null while loading. `nonce` > 0 forces a fresh request (a re-run). */
export function useJson<T>(path: string | null, nonce = 0): Res<T> | null {
  const [res, setRes] = useState<Res<T> | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setRes(null);
    void fetchJson<T>(path, nonce > 0).then((r) => {
      if (live) setRes(r);
    });
    return () => {
      live = false;
    };
  }, [path, nonce]);
  return res;
}

/** The copy's honest empty-state sentence for a failed route. */
export const unavailable = (what: string, r: Res<unknown> | null): string =>
  r === null
    ? `${what} loading`
    : r.status === 0
      ? `${what} unavailable (network error)`
      : `${what} unavailable (HTTP ${r.status})`;

// ── route shapes (only the fields the copy reads) ─────────────────────────────
export interface Feature<P> {
  id?: string;
  geometry: { type: string; coordinates: number[] } | null;
  properties: P;
}
export interface FC<P> {
  features: Feature<P>[];
}
export interface Choke {
  name: string;
  vessels: number;
  stationary: number;
  congestion: "high" | "elevated" | "normal";
}
export interface SarP {
  aisMatch?: boolean;
  darkCandidate?: boolean;
  lengthM: number;
  widthM: number;
  headingDeg: number;
  classification: {
    candidates: { cls: string }[];
    confidence: "low" | "medium" | "high";
  };
}
export interface SarFC extends FC<SarP> {
  summary: { date: string };
}
export interface Sar extends SarP {
  id: string;
  xy: [number, number];
}
export interface SancP {
  mmsi: number;
  name: string;
  sog?: number | null;
  shipType?: number | string | null;
  parked?: boolean;
  flag?: string | null;
  vessel_flag?: string | null;
  t: number;
  source?: string;
  sanction_list?: string;
  sanction_programs?: string[];
  sanction_matched_on?: string;
  sanction_confidence?: string;
}
export interface Sanc extends SancP {
  xy: [number, number];
  sogN: number;
  status: VStatus;
  cls: string;
  np: number;
}
export interface WarnP {
  msgNumber?: number;
  msgYear?: number;
  navArea?: string;
  text?: string;
}
export interface Dataset {
  id: string;
  name: string;
  kind: string;
  schema: { name: string; type: string }[];
  updated_at: string;
  latest_version: number;
  row_count: number;
}
export interface LinNode {
  id: string;
  type: "dataset" | "transform";
  name: string;
  kind?: string;
  row_count?: number;
}
export interface Lineage {
  nodes: LinNode[];
  edges: { src: string; dst: string }[];
}
export interface Binding {
  id: string;
  dataset_id: string;
  object_kind: string;
}
export interface Transform {
  id: string;
  name: string;
  inputs: string[];
  output_dataset_id: string;
  steps: { type: string; expr?: string; column?: string }[];
}
export interface Build {
  id: string;
  transform_id: string | null;
  scope: string;
  status: string;
  started_at: string;
  rows_out: number;
  log?: string[];
}
export interface Check {
  name: string;
  type: string;
  dataset_id: string;
  params: { column?: string; max_age_s?: number };
}
export interface Rows {
  schema: { name: string; type: string }[];
  rows: Record<string, unknown>[];
}
export interface Guardrails {
  clearance?: number;
  action_tools?: string[];
}

// ── builder derivations, ported ──────────────────────────────────────────────
export const inHormuz = (xy: number[]): boolean =>
  xy[0]! >= 53.5 && xy[0]! <= 58.8 && xy[1]! >= 24.2 && xy[1]! <= 27.8;

/** watch_items.py's region (Red Sea, Gulf of Aden, Gulf, Arabian Sea). */
export const inWatchRegion = (xy: number[]): boolean =>
  xy[0]! >= 32 && xy[0]! <= 62 && xy[1]! >= 10 && xy[1]! <= 31;

export type VStatus = "Parked" | "Stationary" | "Slow" | "Underway";
export function vstatus(s: { parked?: boolean; sog?: number | null }): VStatus {
  if (s.parked) return "Parked";
  const sg = s.sog || 0;
  return sg < 0.5 ? "Stationary" : sg < 3 ? "Slow" : "Underway";
}

export function shipCls(t: unknown): string {
  const s = String(t);
  return s.startsWith("8")
    ? "Tanker"
    : s.startsWith("7")
      ? "Cargo"
      : s.startsWith("3")
        ? "Fishing"
        : "Other";
}

export type Prio = "High" | "Medium" | "Low";
export const prio = (np: number): Prio =>
  np >= 3 ? "High" : np === 2 ? "Medium" : "Low";

export function sancRows(fc: FC<SancP> | null): Sanc[] {
  return (fc?.features ?? [])
    .filter((f) => f.geometry)
    .map((f) => {
      const p = f.properties;
      return {
        ...p,
        xy: f.geometry!.coordinates.slice(0, 2) as [number, number],
        sogN: p.sog || 0,
        status: vstatus(p),
        cls: shipCls(p.shipType),
        np: (p.sanction_programs ?? []).length,
      };
    });
}

export function sarRows(fc: SarFC | null): Sar[] {
  return (fc?.features ?? [])
    .filter((f) => f.geometry)
    .map((f) => ({
      ...f.properties,
      id: String(f.id ?? ""),
      xy: f.geometry!.coordinates.slice(0, 2) as [number, number],
    }));
}

export const sarTitle = (s: Sar): string =>
  "SAR " + s.id.split(":").slice(2).join(":");
export const topCls = (s: Sar): string =>
  (s.classification.candidates[0]?.cls ?? "n/a").split(" / ")[0]!;
export const conf = (s: Sar): "low" | "medium" | "high" =>
  s.classification.confidence;

/** Hull-length scenario: how many hulls a minimum length keeps. */
export function keepAtLeast(
  sar: Sar[],
  minM: number,
): { n: number; pct: number } {
  const n = sar.filter((x) => x.lengthM >= minM).length;
  return { n, pct: sar.length ? Math.round((100 * n) / sar.length) : 0 };
}

export function counter<T>(xs: T[]): [T, number][] {
  const m = new Map<T, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ── formatting (the builder's strftime patterns, UTC) ────────────────────────
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const p2 = (n: number): string => String(n).padStart(2, "0");
/** "%b %-d, %Y" */
export const mon = (d: Date): string =>
  `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
/** "%b %-d, %Y, %H:%M UTC" */
export const stamp = (d: Date): string =>
  `${mon(d)}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
/** "%d %b %Y" */
export const dmy = (d: Date): string =>
  `${p2(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** "%b %-d, %Y, %-I:%M %p" (or "%b %-d, %Y") */
export function tsFmt(iso: string, withTime = true): string {
  const d = new Date(iso);
  if (!withTime) return mon(d);
  const h = d.getUTCHours();
  return `${mon(d)}, ${h % 12 || 12}:${p2(d.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
/** "simulation-%d-%b-%Y-%H-%M-%S" */
export const runName = (d: Date): string =>
  `simulation-${p2(d.getUTCDate())}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}-${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}`;
export const comma = (n: number): string => n.toLocaleString("en-US");

// ── the light basemap: scene px = [lon, mercator-lat, 1] . c ────────────────
// Coefficients from gotham/_refs/base/scene-hormuz.geo.json (fit on 18 WPI
// ports); the image is the copy's aa-light-hormuz.png, 1882x1242.
const GEO_CX = [579.0603917238906, 1.1519823034302774, -31720.716824870044];
const GEO_CY = [2.261125465928714, -575.6161275462374, 16226.050406843233];
const mercy = (lat: number): number =>
  (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2)) * 180) / Math.PI;
export function scenePx(lon: number, lat: number): [number, number] {
  const v = [lon, mercy(lat), 1];
  return [
    v[0]! * GEO_CX[0]! + v[1]! * GEO_CX[1]! + v[2]! * GEO_CX[2]!,
    v[0]! * GEO_CY[0]! + v[1]! * GEO_CY[1]! + v[2]! * GEO_CY[2]!,
  ];
}
export const KM_PER_SCENE_PX =
  (111.32 * Math.cos((25.78 * Math.PI) / 180)) / GEO_CX[0]!;

/** Wrap a prompt into bubble lines the width the copy's bubbles hold. */
export function wrap(q: string, max = 74): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of q.trim().split(/\s+/)) {
    if (line && (line + " " + w).length > max) {
      out.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}
