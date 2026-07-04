// Pattern-of-life card (Track D1) — upgrades the old dossier-only lookup to the
// analytic POL endpoint GET /api/intel/pol/{id} (DBSCAN dwell/waypoints over the
// entity's history.db track + a z-scored activity baseline + an anomaly score).
//
// Renders three honest surfaces, each only when the backend supplies it:
//   1. an anomaly SCORE (how far this track sits from the entity's/area's baseline),
//   2. the BASELINE metrics (now vs mean, ±σ, normal/high/low) — the "is this normal?"
//      read, mirroring intel/baseline.assess,
//   3. the DWELL WAYPOINTS (clustered places the entity loitered) with a Slew button.
// Plus the legacy track summary (profile / duration / distance / fixes / ADS-B gaps)
// and the GNSS-degraded flag, kept because a POL crawl over query_tracks carries them.
//
// Contract tolerance (the route is built by a sibling agent this run): the renderer
// reads a SUPERSET shape and shows whatever is present, so it composes with the
// backend without lockstep. Honest empty/degraded states throughout: a disabled /
// empty history window, or "no track in the ~Nh window", surfaces the backend's own
// note — we never fabricate a baseline or imply data we don't have.
//
// Reuses: apiFetch, the shared instruments (Widget / KV / Badge / ScoreBar / Caveat /
// MicroLabel / Btn), and camera.flyToPosition (only when a viewer is passed).

import { useEffect, useState } from 'react';
import * as Cesium from 'cesium';

import { apiFetch } from '../transport/http.js';
import { flyToPosition } from '../globe/camera.js';
import {
  Widget,
  KV,
  KVRow,
  Badge,
  ScoreBar,
  Caveat,
  MicroLabel,
  Btn,
} from '../shell/instruments.js';

// ── tolerant POL contract ─────────────────────────────────────────────────────
// One z-scored baseline metric, the shape intel/baseline.assess emits per key.
interface BaselineMetric {
  now?: number;
  mean?: number | string;
  std?: number;
  z?: number;
  state?: string; // 'normal' | 'high' | 'low' | 'insufficient'
  samples?: number;
  baseline?: string; // 'insufficient' when too few samples
}

// One dwell cluster (DBSCAN over the track): a place the entity loitered. Field
// names vary by backend; we read several aliases for each so the card is robust.
interface Dwell {
  lat?: number;
  lon?: number;
  label?: string | null;
  name?: string | null;
  place?: string | null;
  dwell_minutes?: number;
  dwell_min?: number;
  minutes?: number;
  visits?: number;
  count?: number;
  radius_m?: number;
  radius_km?: number;
}

interface PolTrack {
  fixes?: number;
  points?: number;
  track_minutes?: number;
  duration_min?: number;
  distance_km?: number;
  profile?: string | null;
  gap_count?: number;
}

interface PolResponse {
  id?: string;
  kind?: string | null;
  available?: boolean;
  found?: boolean;
  retention_hours?: number;
  assessment?: string | null;
  summary?: string | null;
  note?: string | null;
  gnss_degraded?: boolean;
  // anomaly score: a 0-1 fraction OR a 0-100 percentage (we normalise either).
  anomaly_score?: number;
  score?: number;
  anomaly_label?: string | null;
  // baseline: either the assess() envelope ({metrics:{...}, anomalies:[...]}) or a
  // flat metric map; plus an optional flat list of human anomaly strings.
  baseline?: { metrics?: Record<string, BaselineMetric>; anomalies?: string[] } | Record<string, BaselineMetric>;
  anomalies?: string[];
  waypoints?: Dwell[];
  dwells?: Dwell[];
  track?: PolTrack;
}

// Normalise an anomaly score (fraction or percentage) into a 0-100 number. ≤1 is
// treated as a fraction; >1 as an already-scaled percentage; clamped to [0,100].
function scorePct(raw: number | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const pct = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, pct));
}

// Score tone/label thresholds (percentage). Conservative so a benign track reads
// "nominal", not red — the alert-red ScoreBar fill already signals magnitude.
function scoreTone(pct: number): { label: string; tone: 'ok' | 'warn' | 'alert' } {
  if (pct >= 70) return { label: 'anomalous', tone: 'alert' };
  if (pct >= 40) return { label: 'elevated', tone: 'warn' };
  return { label: 'nominal', tone: 'ok' };
}

// Pull the per-key baseline metrics whether the backend nested them under
// `metrics` (the assess() envelope) or returned a flat map at `baseline`. Reads
// the raw value as `unknown` so the union narrowing stays simple/sound.
function baselineMetrics(b: PolResponse['baseline']): Record<string, BaselineMetric> {
  if (!b || typeof b !== 'object') return {};
  const envelope = b as { metrics?: Record<string, BaselineMetric> };
  if (envelope.metrics && typeof envelope.metrics === 'object') return envelope.metrics;
  // Flat map — keep only object-valued entries (skip an 'anomalies' array if the
  // backend returned the assess() envelope shape without a `metrics` wrapper).
  const out: Record<string, BaselineMetric> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (k === 'anomalies') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = v as BaselineMetric;
  }
  return out;
}

// The human-readable anomaly strings (e.g. "vessels high (+2.3σ)"), from either
// the assess() envelope's `baseline.anomalies` or a top-level `anomalies` list.
function baselineAnomalies(data: PolResponse): string[] {
  const b = data.baseline;
  const fromEnvelope =
    b && typeof b === 'object' && Array.isArray((b as { anomalies?: unknown }).anomalies)
      ? ((b as { anomalies?: string[] }).anomalies as string[])
      : undefined;
  const list = fromEnvelope ?? data.anomalies ?? [];
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
}

function dwellMinutes(d: Dwell): number | null {
  const v = d.dwell_minutes ?? d.dwell_min ?? d.minutes;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function dwellVisits(d: Dwell): number | null {
  const v = d.visits ?? d.count;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function dwellLabel(d: Dwell, i: number): string {
  return d.label || d.name || d.place || `Dwell ${i + 1}`;
}

function fmtMinutes(min: number): string {
  if (min >= 60) return `${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
  return `${Math.round(min)}m`;
}

function stateBadgeTone(state: string | undefined): 'alert' | 'warn' | 'neutral' {
  if (state === 'high') return 'alert';
  if (state === 'low') return 'warn';
  return 'neutral';
}

export function PatternOfLifeCard({
  id,
  kind,
  viewer,
}: {
  id: string;
  kind: string;
  viewer?: Cesium.Viewer | null;
}): JSX.Element | null {
  const [data, setData] = useState<PolResponse | null>(null);
  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');

  // Only aircraft/vessels have a position history POL can analyse; skip the rest
  // (cameras / quakes / sim agents) so the panel stays tight.
  const trackable = kind === 'aircraft' || kind === 'vessel';

  useEffect(() => {
    setData(null);
    setPhase('idle');
    if (!id || !trackable) return;
    const ab = new AbortController();
    setPhase('loading');
    // The POL route is id-keyed on the canonical entity id (aircraft:<icao24> /
    // vessel:<mmsi>) — the same id history.py / incidents.py use. The panel's
    // selection id already IS that canonical id, so pass it through verbatim.
    apiFetch(`/api/intel/pol/${encodeURIComponent(id)}`, { signal: ab.signal })
      .then((r) => (r.ok ? (r.json() as Promise<PolResponse>) : null))
      .then((j) => {
        if (!j) {
          setPhase('error');
          return;
        }
        setData(j);
        setPhase('idle');
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setPhase('error');
      });
    return () => ab.abort();
  }, [id, trackable]);

  if (!trackable) return null;

  if (phase === 'loading' && !data) {
    return (
      <Widget title="Pattern of life">
        <MicroLabel className="block">analysing track…</MicroLabel>
      </Widget>
    );
  }

  // Route missing / errored — quiet, honest, no crash. (The sibling route may not
  // be wired yet; degrade gracefully rather than blank the whole panel.)
  if (phase === 'error' && !data) return null;
  if (!data) return null;

  const note = data.note ?? null;
  const retention = data.retention_hours;

  // Nothing to analyse: history disabled, not trackable, or no track in window.
  // Surface the backend's own reason (it distinguishes "history off" from "no
  // track in the ~Nh window") — never imply we computed a baseline we didn't.
  const nothing = data.available === false || data.found === false;

  const t = data.track ?? {};
  const fixes = t.fixes ?? t.points;
  const durMin = t.track_minutes ?? t.duration_min;

  const metrics = baselineMetrics(data.baseline);
  const metricKeys = Object.keys(metrics);
  const baselineAnoms = baselineAnomalies(data);

  const waypoints = data.waypoints ?? data.dwells ?? [];
  const pct = scorePct(data.anomaly_score ?? data.score);
  const assessment = data.assessment ?? data.summary ?? null;

  // Track-summary KV rows (legacy fields; render only what's present).
  const trackRows: JSX.Element[] = [];
  if (t.profile) trackRows.push(<KVRow key="prof" k="Profile" v={t.profile} />);
  if (durMin != null) trackRows.push(<KVRow key="dur" k="Track" v={`${Math.round(durMin)} min`} />);
  if (t.distance_km != null)
    trackRows.push(<KVRow key="dist" k="Distance" v={`${Math.round(t.distance_km).toLocaleString()} km`} />);
  if (fixes != null) trackRows.push(<KVRow key="fix" k="Fixes" v={fixes} />);
  if (t.gap_count != null && t.gap_count > 0)
    trackRows.push(<KVRow key="gap" k="ADS-B gaps" v={t.gap_count} warn />);

  // If the backend has literally nothing actionable, show only the honest note.
  const hasContent =
    !nothing &&
    (pct != null ||
      metricKeys.length > 0 ||
      baselineAnoms.length > 0 ||
      waypoints.length > 0 ||
      trackRows.length > 0 ||
      assessment != null ||
      data.gnss_degraded === true);

  if (nothing || !hasContent) {
    return (
      <Widget title="Pattern of life">
        <div className="flex flex-wrap items-center gap-1.5">
          {retention != null && <Caveat level={`HISTORY ~${retention}H`} />}
        </div>
        <MicroLabel className="block mt-1.5 text-txt-3">
          {note ?? 'no pattern-of-life baseline for this entity in the retained window'}
        </MicroLabel>
      </Widget>
    );
  }

  return (
    <Widget title="Pattern of life">
      {/* scope caveat */}
      {retention != null && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <Caveat level={`HISTORY ~${retention}H`} />
        </div>
      )}

      {assessment && <p className="text-[11px] text-txt-1 leading-snug mb-2">{assessment}</p>}

      {/* 1 — anomaly score */}
      {pct != null && (
        <div className="mb-2.5">
          <div className="flex items-center justify-between gap-2">
            <MicroLabel>Anomaly</MicroLabel>
            <div className="flex items-center gap-2">
              <ScoreBar pct={pct} />
              <span className="mono text-[10px] text-txt-1 tabular-nums">{Math.round(pct)}</span>
              <Badge tone={scoreTone(pct).tone === 'ok' ? 'ok' : scoreTone(pct).tone === 'warn' ? 'warn' : 'alert'}>
                {data.anomaly_label || scoreTone(pct).label}
              </Badge>
            </div>
          </div>
        </div>
      )}

      {/* 2 — baseline metrics (now vs mean ±σ) */}
      {metricKeys.length > 0 && (
        <div className="mb-2.5">
          <MicroLabel className="block mb-1">Baseline</MicroLabel>
          <KV>
            {metricKeys.map((k) => {
              const m = metrics[k]!;
              const insufficient = m.baseline === 'insufficient' || m.state === 'insufficient' || m.z == null;
              const v = insufficient ? (
                <span className="text-txt-3">
                  {m.now != null ? `${m.now} · ` : ''}
                  baselining{m.samples != null ? ` (${m.samples})` : ''}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span>{m.now != null ? m.now : '—'}</span>
                  <span className="text-txt-3">
                    μ{typeof m.mean === 'number' ? m.mean : m.mean ?? '—'}
                    {m.z != null ? ` · ${m.z >= 0 ? '+' : ''}${m.z}σ` : ''}
                  </span>
                  {m.state && m.state !== 'normal' && (
                    <Badge tone={stateBadgeTone(m.state)}>{m.state}</Badge>
                  )}
                </span>
              );
              return <KVRow key={k} k={k.replace(/_/g, ' ')} v={v} warn={m.state === 'high'} />;
            })}
          </KV>
        </div>
      )}

      {/* human anomaly strings (e.g. "vessels high (+2.3σ)") */}
      {baselineAnoms.length > 0 && (
        <ul className="mb-2.5 space-y-1">
          {baselineAnoms.slice(0, 6).map((a, i) => (
            <li key={i} className="mono text-[10px] text-[#fcd9a0] leading-snug">
              ▲ {a}
            </li>
          ))}
        </ul>
      )}

      {/* 3 — dwell waypoints (DBSCAN clusters) */}
      {waypoints.length > 0 && (
        <div className="mb-2">
          <SectionMicro title="Dwell waypoints" count={waypoints.length} />
          <ul className="mt-1 space-y-1.5">
            {waypoints.slice(0, 8).map((d, i) => {
              const min = dwellMinutes(d);
              const visits = dwellVisits(d);
              const canSlew = viewer != null && typeof d.lat === 'number' && typeof d.lon === 'number';
              return (
                <li key={i} className="border border-line rounded-sm p-1.5 bg-bg-2/60">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10.5px] text-txt-1 truncate">{dwellLabel(d, i)}</span>
                    {canSlew && (
                      <Btn
                        size="sm"
                        onClick={() => flyToPosition(viewer!, d.lon as number, d.lat as number, 120_000, 1.0)}
                        title="Slew to this dwell"
                      >
                        → Slew
                      </Btn>
                    )}
                  </div>
                  {(min != null || visits != null) && (
                    <div className="flex items-center gap-3 mt-1 mono text-[10px] text-txt-3 tabular-nums">
                      {min != null && <span>dwell {fmtMinutes(min)}</span>}
                      {visits != null && <span>{visits} visit{visits === 1 ? '' : 's'}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* legacy track summary */}
      {trackRows.length > 0 && <KV className="mt-1">{trackRows}</KV>}

      {data.gnss_degraded && (
        <div className="mt-2">
          <Badge tone="warn">GNSS degraded</Badge>
        </div>
      )}

      {note && <p className="mono text-[10px] text-txt-3 leading-snug mt-2">{note}</p>}
    </Widget>
  );
}

// A tiny sub-section label inside the card (the shared SectionLabel is a touch
// heavy here; this matches the card's micro rhythm). Local to keep the file
// self-contained (ownership: I only own EntityPanel + these two card files).
function SectionMicro({ title, count }: { title: string; count?: number }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <MicroLabel>{title}</MicroLabel>
      {count !== undefined && <span className="mono text-[10px] text-txt-3 tabular-nums">{count}</span>}
    </div>
  );
}
