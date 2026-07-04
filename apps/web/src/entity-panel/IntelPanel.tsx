import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useImagery, useSelection } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { useSituations, type Severity } from '../situations/situationStore.js';
import { intel } from '../intel/registry.js';
import type { DarkVesselCandidate } from '../intel/darkVessel.js';
import { flyToChokepoint, flyToPosition, slewToEntity } from '../globe/camera.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { apiFetch } from '../transport/http.js';
import {
  SectionLabel,
  Badge,
  KV,
  KVRow,
  Btn,
  Hero,
  Toggle,
  type BadgeTone,
} from '../shell/instruments.js';
import type { Alert } from '@osint/shared';

async function fetchJammingAlerts(): Promise<Alert[]> {
  try {
    // apiFetch (NOT raw fetch) — CLAUDE.md: every browser → backend call must
    // carry the X-API-Key header when one is configured.
    const res = await apiFetch('/api/jamming/alerts?limit=50');
    if (!res.ok) return [];
    const data = (await res.json()) as { alerts: Alert[] };
    return data.alerts ?? [];
  } catch {
    return [];
  }
}

interface BriefEvidence {
  domain: string;
  severity: string;
  summary: string;
  lon: number;
  lat: number;
}
interface EmitterEstimate {
  lon: number;
  lat: number;
  cep_km: number;
  n_cells: number;
}
interface BriefIncident {
  id: string;
  threat_level: string;
  score: number;
  domains: string[];
  signal_count: number;
  centroid: { lon: number; lat: number };
  span_km: number;
  narrative: string;
  evidence: BriefEvidence[];
  follow_up: string[];
  emitter_estimate?: EmitterEstimate | null;
}
interface BriefResp {
  top_threat_level: string;
  incident_count: number;
  scope: string;
  incidents: BriefIncident[];
}

// Cross-domain incident brief — global, or scoped to the active AOI's centre.
async function fetchBrief(center?: readonly number[]): Promise<BriefResp | null> {
  try {
    const q = center ? `?lat=${center[1]}&lon=${center[0]}&radius_nm=300` : '';
    const res = await apiFetch(`/api/intel/brief${q}`);
    if (!res.ok) return null;
    return (await res.json()) as BriefResp;
  } catch {
    return null;
  }
}

interface WatchChange {
  key: string;
  threat_level: string;
  domains: string[];
  narrative: string;
  centroid: { lon: number; lat: number };
  from_level?: string;
}
interface WatchResp {
  changes: {
    had_baseline: boolean;
    new: WatchChange[];
    escalated: WatchChange[];
    deescalated: WatchChange[];
    resolved: WatchChange[];
    steady: number;
    active: number;
  };
}

// Standing watch — the global background diff (new / escalated / resolved).
async function fetchWatch(): Promise<WatchResp | null> {
  try {
    const res = await apiFetch('/api/intel/watch');
    if (!res.ok) return null;
    return (await res.json()) as WatchResp;
  } catch {
    return null;
  }
}

interface Props {
  viewer: Cesium.Viewer | null;
}

// Alert severity → Badge tone (critical/high red, medium amber, low cobalt).
function sevTone(sev: string): BadgeTone {
  if (sev === 'critical' || sev === 'high') return 'alert';
  if (sev === 'medium') return 'warn';
  if (sev === 'low') return 'accent';
  return 'neutral';
}

// Incident / watch threat-level → Badge tone.
function threatTone(level: string): BadgeTone {
  if (level === 'high') return 'alert';
  if (level === 'elevated') return 'warn';
  if (level === 'low') return 'accent';
  return 'neutral';
}

// Intel rail tab — operator-facing situational summary:
//  - cross-domain incident brief (fused, cited convergences)
//  - standing-watch diff (new / escalated since last tick)
//  - live dark-vessel candidate count (intel/registry.ts darkVessels)
//  - top recent correlations (alerts in the live buffer, not yet acked)
//  - GPS jamming clusters + current AOI summary, with fly-to actions
export function IntelPanel({ viewer }: Props): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const activeAoi = useAoi((s) => s.active);
  const setAoi = useAoi((s) => s.setActive);
  const imageryMode = useImagery((s) => s.mode);
  const setImageryMode = useImagery((s) => s.setMode);
  const reduced = useReducedMotion();
  const [candidates, setCandidates] = useState<readonly DarkVesselCandidate[]>(() =>
    intel.darkVessels.candidates([]),
  );
  const [jammingAlerts, setJammingAlerts] = useState<Alert[]>([]);
  const [brief, setBrief] = useState<BriefResp | null>(null);
  const [watch, setWatch] = useState<WatchResp | null>(null);

  // Poll the dark-vessel tracker once a second. Cheap — it's an in-process Map.
  useEffect(() => {
    const tick = () => {
      const out = intel.darkVessels.candidates([]);
      setCandidates(out);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Poll /api/jamming/alerts every 30 s. GPS jamming cluster events are kept
  // out of the main alert bus — they appear here only, not in the alerts
  // ticker or drawer.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetchJammingAlerts().then((items) => {
        if (!cancelled) setJammingAlerts(items);
      }).catch(() => {/* swallow — fetchJammingAlerts never rejects */});
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Poll the cross-domain incident brief every 30 s, scoped to the active AOI
  // when one is set (else global). This is the fused, cited picture — the same
  // /api/intel/brief the MCP intel_brief() tool serves.
  useEffect(() => {
    let cancelled = false;
    const center = activeAoi?.center;
    const tick = () => {
      fetchBrief(center)
        .then((b) => {
          if (!cancelled) setBrief(b);
        })
        .catch(() => {
          /* swallow — fetchBrief never rejects */
        });
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeAoi]);

  // Poll the global standing-watch diff every 30 s (what changed since the
  // background loop's last tick). Push alerts for HIGH transitions arrive
  // separately on the alert bus → command-bar ticker + Alerts drawer.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetchWatch()
        .then((w) => {
          if (!cancelled) setWatch(w);
        })
        .catch(() => {
          /* swallow — fetchWatch never rejects */
        });
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const topCorrelations: Alert[] = alerts.slice(0, 5);
  const ch = watch?.changes;
  const changeItems: WatchChange[] = ch ? [...ch.new, ...ch.escalated] : [];

  // Incidents arrive ranked by score; the top one carries the headline threat.
  // Promote it to a Hero only when its level maps to a Hero-supported tone.
  const incidents = brief?.incidents ?? [];
  const heroIncident = incidents[0];
  const heroTone: 'alert' | 'warn' | null =
    heroIncident?.threat_level === 'high'
      ? 'alert'
      : heroIncident?.threat_level === 'elevated'
        ? 'warn'
        : null;
  const restIncidents = heroTone ? incidents.slice(1, 6) : incidents.slice(0, 6);

  // Promote an incident to a Situation case file: create the aggregate centred on
  // the incident's AOI, link the incident as a child, and open it.
  const promoteToSituation = async (inc: BriefIncident): Promise<void> => {
    const sevMap: Record<string, Severity> = {
      critical: 'critical',
      high: 'high',
      elevated: 'med',
      medium: 'med',
      low: 'low',
    };
    const sid = await useSituations.getState().create({
      name: (inc.narrative || 'Incident').slice(0, 48),
      severity: sevMap[inc.threat_level] ?? 'med',
      centroid: { lat: inc.centroid.lat, lon: inc.centroid.lon },
      summary: inc.narrative,
    });
    const incId = inc.id.startsWith('incident:') ? inc.id : `incident:${inc.id}`;
    await useSituations.getState().linkChild(sid, incId, 'contains');
    useSelection.getState().select(sid);
  };

  const satOn = imageryMode === '3d-sat';
  return (
    <div className="p-3 space-y-4">
      <div className="flex items-center justify-between">
        <SectionLabel title="Intel" className="flex-1" />
        <div className="flex items-center gap-2 ml-3 shrink-0" data-testid="intel-imagery-indicator">
          <span className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3">3D sat</span>
          <Toggle
            on={satOn}
            onChange={(next) => setImageryMode(next ? '3d-sat' : '2d-dark')}
            label="3D satellite imagery + buildings"
          />
        </div>
      </div>

      <section className="space-y-2">
        <SectionLabel
          title={brief ? `Incident brief · ${brief.scope}` : 'Incident brief'}
          count={brief ? brief.incident_count : ''}
        />
        <p className="mono text-[10px] leading-snug text-txt-3">
          Cross-domain convergences — jamming + dark vessels + military + events fused into cited incidents.
        </p>

        {!brief || brief.incident_count === 0 ? (
          <p className="mono text-[10px] text-txt-3">
            No cross-domain incidents{brief ? '' : ' (loading…)'}.
          </p>
        ) : (
          <div className="space-y-2">
            {heroIncident && heroTone && (
              <Hero tone={heroTone} title={`${heroIncident.threat_level} · ${heroIncident.domains.join(' + ')}`}>
                <p className="text-[11px] text-txt-1 leading-snug">{heroIncident.narrative}</p>
                {heroIncident.emitter_estimate && (
                  <p className="mono text-[10px] text-warn mt-1.5 tabular-nums">
                    emitter ≈ {heroIncident.emitter_estimate.lat.toFixed(2)},
                    {heroIncident.emitter_estimate.lon.toFixed(2)} ±{heroIncident.emitter_estimate.cep_km}km
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2.5">
                  <span className="mono text-[10px] tabular-nums text-txt-3">
                    {heroIncident.signal_count} signal{heroIncident.signal_count === 1 ? '' : 's'} ·{' '}
                    {heroIncident.span_km}km
                  </span>
                  <Btn
                    tone="accent"
                    size="sm"
                    onClick={() =>
                      viewer &&
                      flyToPosition(
                        viewer,
                        heroIncident.centroid.lon,
                        heroIncident.centroid.lat,
                        300_000,
                        reduced ? 0 : 1.0,
                      )
                    }
                  >
                    slew to
                  </Btn>
                </div>
              </Hero>
            )}

            {restIncidents.map((inc) => (
              <div key={inc.id} className="border border-line rounded-sm p-2.5 bg-bg-2/60">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={threatTone(inc.threat_level)}>{inc.threat_level}</Badge>
                  <span
                    className="mono text-[10px] tabular-nums text-txt-3 truncate"
                    title={inc.domains.join(' + ')}
                  >
                    {inc.domains.join(' + ')}
                  </span>
                </div>
                <p className="text-[11px] text-txt-1 leading-snug mt-1.5">{inc.narrative}</p>
                {inc.emitter_estimate && (
                  <p className="mono text-[10px] text-warn mt-1 tabular-nums">
                    emitter ≈ {inc.emitter_estimate.lat.toFixed(2)},{inc.emitter_estimate.lon.toFixed(2)} ±
                    {inc.emitter_estimate.cep_km}km
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="mono text-[10px] tabular-nums text-txt-3">
                    {inc.signal_count} signal{inc.signal_count === 1 ? '' : 's'} · {inc.span_km}km
                  </span>
                  <div className="flex gap-1.5">
                    <Btn
                      size="sm"
                      tone="accent"
                      title="Create a Situation case file from this incident"
                      onClick={() => void promoteToSituation(inc)}
                    >
                      → Situation
                    </Btn>
                    <Btn
                      size="sm"
                      onClick={() =>
                        viewer &&
                        flyToPosition(viewer, inc.centroid.lon, inc.centroid.lat, 300_000, reduced ? 0 : 1.0)
                      }
                    >
                      slew to
                    </Btn>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {ch && (
        <section className="space-y-2">
          <SectionLabel
            title="Changes"
            count={`+${ch.new.length} ↑${ch.escalated.length} −${ch.resolved.length} · ${ch.active} active`}
          />
          {changeItems.length === 0 ? (
            <p className="mono text-[10px] text-txt-3">
              {ch.had_baseline ? 'No new or escalated incidents since last tick.' : 'Establishing baseline…'}
            </p>
          ) : (
            <div className="space-y-2">
              {changeItems.slice(0, 5).map((c) => (
                <div key={c.key} className="border border-line rounded-sm p-2.5 bg-bg-2/60">
                  <div className="flex items-center justify-between gap-2">
                    <Badge tone={threatTone(c.threat_level)}>
                      {c.from_level ? `${c.from_level}→${c.threat_level}` : `NEW · ${c.threat_level}`}
                    </Badge>
                    <span className="mono text-[10px] tabular-nums text-txt-3 truncate" title={c.domains.join(' + ')}>
                      {c.domains.join(' + ')}
                    </span>
                  </div>
                  <p className="text-[11px] text-txt-1 leading-snug mt-1.5">{c.narrative}</p>
                  <div className="flex justify-end mt-2">
                    <Btn
                      size="sm"
                      onClick={() =>
                        viewer &&
                        flyToPosition(viewer, c.centroid.lon, c.centroid.lat, 300_000, reduced ? 0 : 1.0)
                      }
                    >
                      slew to
                    </Btn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="space-y-2">
        <SectionLabel title="Dark vessels" count={candidates.length} />
        <div className="border border-line rounded-sm bg-bg-2/60 p-2.5">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[20px] text-txt-0 tabular-nums leading-none">{candidates.length}</span>
            <span className="mono text-[10px] text-txt-3">
              candidate{candidates.length === 1 ? '' : 's'} (AIS-gap, global)
            </span>
          </div>
          <p className="mono text-[10px] text-txt-3 leading-snug mt-1.5">
            Vessels whose last AIS fix is fresh-stale (gap ≥1h, &lt;90m). Pair with SAR cross-reference for true
            darkness.
          </p>
          {candidates.length > 0 && (
            <div className="mt-2.5 space-y-1">
              {candidates.slice(0, 4).map((c) => (
                <div key={c.mmsi} className="flex items-center gap-2 text-[11px]">
                  <Badge tone="mag">dark</Badge>
                  <span className="mono text-txt-1 truncate" title={c.name ?? c.mmsi}>
                    {c.name ?? c.mmsi}
                  </span>
                  <span className="mono text-[10px] tabular-nums text-txt-3 ml-auto">
                    gap {(c.gapMs / 60000).toFixed(0)}m
                  </span>
                  <Btn
                    size="sm"
                    onClick={() =>
                      viewer &&
                      slewToEntity(viewer, `vessel:${c.mmsi}`, c.lastLon, c.lastLat, 250_000, reduced ? 0 : 0.8)
                    }
                  >
                    slew
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <SectionLabel title="Top correlations" count={topCorrelations.length} />
        {topCorrelations.length === 0 ? (
          <p className="mono text-[10px] text-txt-3">No live correlations.</p>
        ) : (
          <div className="space-y-2">
            {topCorrelations.map((a) => (
              <div key={a.id} className="border border-line rounded-sm p-2.5 bg-bg-2/60">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={sevTone(a.severity)}>{a.severity}</Badge>
                  <span className="mono text-[10px] tabular-nums text-txt-3 truncate" title={a.ruleId}>
                    {a.ruleId}
                  </span>
                </div>
                <p className="text-[11px] text-txt-1 leading-snug mt-1.5 line-clamp-2">{a.message}</p>
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="mono text-[10px] tabular-nums text-txt-3">
                    conf {(a.confidence * 100).toFixed(0)}%
                  </span>
                  <Btn
                    size="sm"
                    onClick={() => {
                      if (viewer && a.geom?.type === 'Point') {
                        const [lon, lat] = a.geom.coordinates as [number, number];
                        slewToEntity(viewer, a.contributingObservations?.[0], lon, lat, 250_000, reduced ? 0 : 1.0);
                      }
                    }}
                  >
                    slew to
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel title="GPS jamming clusters" count={jammingAlerts.length} />
        {jammingAlerts.length === 0 ? (
          <p className="mono text-[10px] text-txt-3">No jamming clusters detected.</p>
        ) : (
          <div className="space-y-2">
            {jammingAlerts.slice(0, 8).map((a) => (
              <div key={a.id} className="border border-line rounded-sm p-2.5 bg-bg-2/60">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="warn">jam</Badge>
                  <span className="mono text-[10px] tabular-nums text-txt-3">
                    conf {(a.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-[11px] text-txt-1 leading-snug mt-1.5 line-clamp-2">{a.message}</p>
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="mono text-[10px] tabular-nums text-txt-3">
                    {new Date(a.t).toISOString().slice(11, 19)}Z
                  </span>
                  <Btn
                    size="sm"
                    onClick={() => {
                      if (viewer && a.geom?.type === 'Point') {
                        const [lon, lat] = a.geom.coordinates as [number, number];
                        slewToEntity(viewer, a.contributingObservations?.[0], lon, lat, 250_000, reduced ? 0 : 1.0);
                      }
                    }}
                  >
                    slew to
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionLabel title="Current AOI" />
        {activeAoi ? (
          <div className="border border-accent-line/60 bg-accent-dim rounded-sm p-2.5">
            <div className="mono text-[12px] text-txt-0 truncate" title={activeAoi.name}>
              {activeAoi.name}
            </div>
            <div className="mono text-[10px] tracking-[0.4px] uppercase text-txt-3 mt-0.5">
              {activeAoi.region}
            </div>
            <p className="text-[11px] text-txt-2 leading-snug mt-1.5">{activeAoi.significance}</p>
            <KV className="mt-2.5">
              <KVRow k="category" v={activeAoi.category} />
              <KVRow
                k="center"
                v={`${activeAoi.center[1].toFixed(2)}, ${activeAoi.center[0].toFixed(2)}`}
              />
              {activeAoi.daily_transits != null && (
                <KVRow k="transits/d" v={activeAoi.daily_transits} />
              )}
              {activeAoi.oil_flow_mbpd != null && <KVRow k="oil mbpd" v={activeAoi.oil_flow_mbpd} />}
            </KV>
            <div className="flex gap-2 mt-3">
              <Btn
                tone="accent"
                size="sm"
                onClick={() => viewer && flyToChokepoint(viewer, activeAoi, reduced ? 0 : 1.4)}
              >
                slew to
              </Btn>
              <Btn size="sm" onClick={() => setAoi(null)}>
                clear
              </Btn>
            </div>
          </div>
        ) : (
          <p className="mono text-[10px] text-txt-3">No AOI active. Pick one from the Chokepoints tab.</p>
        )}
      </section>
    </div>
  );
}
