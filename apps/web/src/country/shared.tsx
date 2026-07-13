// Shared types + primitives for the Country intelligence app. Everything the
// per-card components need in one place: backend payload shapes, the cached
// fetch hook (module-level Map so tab-switching back to a country is instant,
// AbortController so switching away cancels in-flight loads), and the small
// presentational atoms (Card, Skeleton, Sparkline, IndicatorCard, chips).
// All backend calls go through apiFetch (transport invariant).

import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// ── Payload shapes ──────────────────────────────────────────────────────────

export interface CountryRow {
  name: string;
  iso2: string;
  iso3: string;
  m49: string;
  region: string;
  sub_region: string;
}

export interface SeriesPoint {
  year: number;
  value: number | null;
}

export interface Indicator {
  id: string;
  label: string;
  unit: string;
  series: SeriesPoint[];
  unavailable?: boolean;
}

export interface WorldBankResponse {
  iso3: string;
  name: string;
  source: string;
  indicators: Indicator[];
}

export interface UnResponse {
  iso3: string;
  name: string;
  m49: string;
  source: string;
  series: Indicator[];
}

// /api/country/{iso3}/profile — Wikidata leadership + service branches.
// `role` is a human label from Wikidata ("Head of state", "Head of
// government", or the English position label for ministers) — NOT snake_case;
// humanizeRole() below handles both defensively.
export interface LeadershipEntry {
  role: string;
  person: string;
  position?: string | null;
  start?: string | null;
  image?: string | null;
}

export interface ProfileResponse {
  iso3: string;
  name?: string | null;
  source: string;
  leadership: LeadershipEntry[];
  military_branches: string[];
  unavailable?: boolean;
  note?: string;
}

// /api/country/{iso3}/security — fused GDELT/UCDP/installations picture.
export interface SecurityEvent {
  label?: string | null;
  date?: string | null;
  actors?: (string | null)[];
  deaths?: number | null;
  lat?: number | null;
  lon?: number | null;
  source?: string;
}

export interface SecurityResponse {
  iso3: string;
  name?: string | null;
  window_hours: number;
  counts: { conflict: number; ucdp: number; installations: number };
  events: SecurityEvent[];
  sources: Record<string, { unavailable?: boolean; note?: string | null }>;
  notes: string[];
}

// /api/country/{iso3}/brief — LLM markdown brief; ok:false is a graceful
// degrade (no backend/model), never a 500.
export type BriefResponse =
  | { ok: true; markdown: string; backend?: string; model?: string }
  | { ok: false; reason?: string };

// ── Formatting helpers ──────────────────────────────────────────────────────

// Regional-indicator flag emoji from iso2 (same guard as CountriesPanel).
export function flagEmoji(iso2: string | undefined | null): string {
  if (!iso2 || iso2.length !== 2) return '\u{1F310}';
  const upper = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return '\u{1F310}';
  return String.fromCodePoint(...[...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)));
}

// Compact number: 1.2T / 340M / 12.3 — trims trailing ".0".
export function formatCompact(v: number): string {
  v = Number(v);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const fmt = (n: number, suffix: string): string => {
    const s = n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
    return `${s}${suffix}`;
  };
  if (abs >= 1e12) return fmt(v / 1e12, 'T');
  if (abs >= 1e9) return fmt(v / 1e9, 'B');
  if (abs >= 1e6) return fmt(v / 1e6, 'M');
  if (abs >= 1e4) return fmt(v / 1e3, 'k');
  if (abs >= 100 || Number.isInteger(v)) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v.toFixed(abs >= 1 ? 1 : 2).replace(/\.0+$/, '');
}

// Role labels arrive humanized from Wikidata ("Head of state") but handle the
// snake_case form ("head_of_state") defensively, plus first-letter casing.
export function humanizeRole(role: string): string {
  const cleaned = role.replace(/_/g, ' ').trim();
  if (!cleaned) return role;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ── Cached fetch hook ───────────────────────────────────────────────────────

export type FetchState<T> = { loading: boolean; error: string | null; data: T | null };

// One module-level response cache keyed by URL (URLs embed the iso3, so this
// IS the per-country cache). Switching back to a country renders instantly;
// AbortController cancels the in-flight request when the selection changes.
// Degraded payloads (any `"unavailable": true` inside — e.g. a World Bank
// rate-limit stall) expire after a minute so a revisit refetches instead of
// pinning "no data" until a full page reload; the backend shortens its own
// cache the same way.
type CacheEntry = { data: unknown; expires: number };
const responseCache = new Map<string, CacheEntry>();
const DEGRADED_TTL_MS = 60_000;

function cacheGet<T>(url: string): T | undefined {
  const hit = responseCache.get(url);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    responseCache.delete(url);
    return undefined;
  }
  return hit.data as T;
}

function cacheSet(url: string, data: unknown): void {
  let degraded: boolean;
  try {
    degraded = JSON.stringify(data).includes('"unavailable":true');
  } catch {
    degraded = true;
  }
  responseCache.set(url, {
    data,
    expires: degraded ? Date.now() + DEGRADED_TTL_MS : Number.POSITIVE_INFINITY,
  });
}

export function useCachedFetch<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>(() => {
    const hit = url ? cacheGet<T>(url) : undefined;
    return { loading: false, error: null, data: hit ?? null };
  });
  useEffect(() => {
    if (!url) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    const hit = cacheGet<T>(url);
    if (hit !== undefined) {
      setState({ loading: false, error: null, data: hit });
      return;
    }
    const ctrl = new AbortController();
    setState({ loading: true, error: null, data: null });
    apiFetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        cacheSet(url, data);
        if (!ctrl.signal.aborted) setState({ loading: false, error: null, data });
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ loading: false, error: e instanceof Error ? e.message : String(e), data: null });
      });
    return () => ctrl.abort();
  }, [url]);
  return state;
}

// ── Presentational atoms ────────────────────────────────────────────────────

// Instrument card chrome: hairline border, labeled header, dense body.
export function Card({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string | undefined;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="border border-line-2 bg-bg-1 rounded-md min-w-0">
      <header className="flex items-baseline gap-2 px-3 pt-2 pb-1.5 border-b border-line">
        <span className="font-label uppercase tracking-[0.9px] text-[11px] text-txt-0">{title}</span>
        {meta && <span className="mono text-[9.5px] text-txt-4 ml-auto shrink-0">{meta}</span>}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

// Skeleton shimmer block — loading placeholder, never a spinner.
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`animate-pulse bg-bg-3 rounded-sm ${className}`} aria-hidden />;
}

export function Sparkline({ series }: { series: SeriesPoint[] }): JSX.Element | null {
  const pts = series.filter((p): p is { year: number; value: number } => p.value != null);
  if (pts.length < 2) return null;
  const w = 96;
  const h = 24;
  const xs = pts.map((p) => p.year);
  const ys = pts.map((p) => p.value);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const sx = (x: number): number => (x1 === x0 ? w / 2 : ((x - x0) / (x1 - x0)) * (w - 2) + 1);
  const sy = (y: number): number => (y1 === y0 ? h / 2 : h - 1 - ((y - y0) / (y1 - y0)) * (h - 2));
  const path = pts.map((p) => `${sx(p.year).toFixed(1)},${sy(p.value).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" aria-hidden>
      <polyline points={path} fill="none" stroke="var(--accent)" strokeWidth="1.25" />
    </svg>
  );
}

export function IndicatorCard({ ind }: { ind: Indicator }): JSX.Element {
  const latest = [...ind.series].reverse().find((p) => p.value != null);
  const noData = ind.unavailable || !latest;
  return (
    <div className="border border-line-2 bg-bg-1 rounded-sm p-2.5 flex flex-col gap-1 min-w-0">
      <div className="text-[10px] uppercase tracking-[0.5px] text-txt-3 truncate" title={`${ind.label}${ind.unit ? ` (${ind.unit})` : ''}`}>
        {ind.label}
      </div>
      {noData ? (
        <div className="mono text-[11px] text-txt-4">no data</div>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="mono text-[16px] text-txt-0">{formatCompact(latest.value as number)}</span>
            {ind.unit && <span className="text-[10px] text-txt-3 truncate">{ind.unit}</span>}
            <span className="mono text-[9.5px] text-txt-4 ml-auto shrink-0">{latest.year}</span>
          </div>
          <Sparkline series={ind.series} />
        </>
      )}
    </div>
  );
}

// Small mono footnote line — data-honesty caveats under a card body.
export function CaveatList({ notes }: { notes: string[] }): JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5">
      {notes.map((n) => (
        <li key={n} className="text-[10px] text-txt-4 leading-snug">
          {n}
        </li>
      ))}
    </ul>
  );
}
