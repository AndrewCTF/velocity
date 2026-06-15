import { useEffect, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useImagery } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { intel } from '../intel/registry.js';
import type { DarkVesselCandidate } from '../intel/darkVessel.js';
import { flyToChokepoint, flyToPosition } from '../globe/camera.js';
import { useReducedMotion } from '../shell/useReducedMotion.js';
import { apiFetch } from '../transport/http.js';
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

const SEV_LABEL: Record<string, string> = {
  critical: 'text-alert',
  high: 'text-alert',
  medium: 'text-warn',
  low: 'text-accent',
  info: 'text-txt-2',
};

// Threat-level → colour for the incident brief badges.
const TL: Record<string, string> = {
  high: 'text-alert',
  elevated: 'text-warn',
  low: 'text-accent',
};

// Intel rail tab — operator-facing situational summary:
//  - live dark-vessel candidate count (intel/registry.ts darkVessels)
//  - top recent correlations (alerts in the live buffer, not yet acked)
//  - current AOI summary, with quick fly-to and clear actions
export function IntelPanel({ viewer }: Props): JSX.Element {
  const alerts = useAlerts((s) => s.alerts);
  const activeAoi = useAoi((s) => s.active);
  const setAoi = useAoi((s) => s.setActive);
  const imageryMode = useImagery((s) => s.mode);
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

  const satOn = imageryMode === '3d-sat';
  return (
    <div className="p-3 space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="micro">Intel</h2>
        <span
          className={`mono text-[10px] tracking-[0.5px] uppercase px-1.5 py-0.5 border rounded-sm ${
            satOn ? 'border-accent-line text-accent bg-accent-dim' : 'border-line text-txt-3'
          }`}
          data-testid="intel-imagery-indicator"
          title="3D satellite imagery + buildings toggle"
        >
          3D sat: {satOn ? 'on' : 'off'}
        </span>
      </div>

      <section>
        <div className="flex items-baseline justify-between">
          <h3 className="micro">Incident brief{brief ? ` · ${brief.scope}` : ''}</h3>
          {brief && (
            <span className={`micro uppercase ${TL[brief.top_threat_level] ?? 'text-txt-3'}`}>
              {brief.top_threat_level}
            </span>
          )}
        </div>
        <p className="micro normal-case tracking-normal text-txt-3 leading-snug mt-1">
          Cross-domain convergences — jamming + dark vessels + military + events fused into cited incidents.
        </p>
        {!brief || brief.incident_count === 0 ? (
          <p className="micro normal-case tracking-normal text-txt-3 mt-1">
            No cross-domain incidents{brief ? '' : ' (loading…)'}.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {brief.incidents.slice(0, 6).map((inc) => (
              <li key={inc.id} className="border border-line rounded-sm p-2 bg-bg-2/50">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`micro uppercase ${TL[inc.threat_level] ?? ''}`}>
                    {inc.threat_level}
                  </span>
                  <span className="mono micro tabular-nums text-txt-3 truncate" title={inc.domains.join(' + ')}>
                    {inc.domains.join(' + ')}
                  </span>
                </div>
                <p className="text-[11px] text-txt-1 leading-tight mt-1">{inc.narrative}</p>
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() =>
                      viewer &&
                      flyToPosition(viewer, inc.centroid.lon, inc.centroid.lat, 300_000, reduced ? 0 : 1.0)
                    }
                    className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
                  >
                    slew to
                  </button>
                  <span className="mono micro tabular-nums text-txt-3">
                    {inc.signal_count} signal{inc.signal_count === 1 ? '' : 's'} · {inc.span_km}km
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ch && (
        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="micro">Changes</h3>
            <span className="mono micro tabular-nums text-txt-3">
              +{ch.new.length} ↑{ch.escalated.length} −{ch.resolved.length} · {ch.active} active
            </span>
          </div>
          {changeItems.length === 0 ? (
            <p className="micro normal-case tracking-normal text-txt-3 mt-1">
              {ch.had_baseline ? 'No new or escalated incidents since last tick.' : 'Establishing baseline…'}
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {changeItems.slice(0, 5).map((c) => (
                <li key={c.key} className="border border-line rounded-sm p-2 bg-bg-2/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`micro uppercase ${TL[c.threat_level] ?? ''}`}>
                      {c.from_level ? `${c.from_level}→${c.threat_level}` : `NEW · ${c.threat_level}`}
                    </span>
                    <span className="mono micro tabular-nums text-txt-3 truncate">
                      {c.domains.join(' + ')}
                    </span>
                  </div>
                  <p className="text-[11px] text-txt-1 leading-tight mt-1">{c.narrative}</p>
                  <button
                    type="button"
                    onClick={() =>
                      viewer &&
                      flyToPosition(viewer, c.centroid.lon, c.centroid.lat, 300_000, reduced ? 0 : 1.0)
                    }
                    className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1 mt-1"
                  >
                    slew to
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h3 className="micro">Dark vessels</h3>
        <div className="mt-1 border border-line rounded-sm bg-bg-2/50 p-2">
          <div className="flex items-baseline gap-2">
            <span className="mono text-[20px] text-txt-0 tabular-nums">{candidates.length}</span>
            <span className="micro normal-case tracking-normal text-txt-3">
              candidate{candidates.length === 1 ? '' : 's'} (AIS-gap, global)
            </span>
          </div>
          <p className="micro normal-case tracking-normal text-txt-3 leading-snug mt-1">
            Vessels whose last AIS fix is fresh-stale (gap ≥1h, &lt;90m). Pair with SAR cross-reference for true darkness.
          </p>
          {candidates.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {candidates.slice(0, 4).map((c) => (
                <li key={c.mmsi} className="flex items-center gap-2 text-[11px]">
                  <span className="mono text-txt-1 truncate" title={c.name ?? c.mmsi}>
                    {c.name ?? c.mmsi}
                  </span>
                  <span className="mono micro tabular-nums text-txt-3 ml-auto">
                    gap {(c.gapMs / 60000).toFixed(0)}m
                  </span>
                  <button
                    type="button"
                    onClick={() => viewer && flyToPosition(viewer, c.lastLon, c.lastLat, 250_000, reduced ? 0 : 0.8)}
                    className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
                  >
                    slew
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h3 className="micro">Top correlations</h3>
        {topCorrelations.length === 0 ? (
          <p className="micro normal-case tracking-normal text-txt-3 mt-1">No live correlations.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {topCorrelations.map((a) => (
              <li key={a.id} className="border border-line rounded-sm p-2 bg-bg-2/50">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`micro ${SEV_LABEL[a.severity] ?? ''}`}>{a.severity}</span>
                  <span className="mono micro tabular-nums text-txt-3">{a.ruleId}</span>
                </div>
                <p className="text-[11px] text-txt-1 leading-tight mt-1 line-clamp-2">{a.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (viewer && a.geom?.type === 'Point') {
                        const [lon, lat] = a.geom.coordinates as [number, number];
                        flyToPosition(viewer, lon, lat, 250_000, reduced ? 0 : 1.0);
                      }
                    }}
                    className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
                  >
                    slew to
                  </button>
                  <span className="mono micro tabular-nums text-txt-3">
                    conf {(a.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="micro">GPS jamming clusters</h3>
        {jammingAlerts.length === 0 ? (
          <p className="micro normal-case tracking-normal text-txt-3 mt-1">No jamming clusters detected.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {jammingAlerts.slice(0, 8).map((a) => (
              <li key={a.id} className="border border-line rounded-sm p-2 bg-bg-2/50">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="micro text-warn">JAM</span>
                  <span className="mono micro tabular-nums text-txt-3">
                    conf {(a.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <p className="text-[11px] text-txt-1 leading-tight mt-1 line-clamp-2">{a.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (viewer && a.geom?.type === 'Point') {
                        const [lon, lat] = a.geom.coordinates as [number, number];
                        flyToPosition(viewer, lon, lat, 250_000, reduced ? 0 : 1.0);
                      }
                    }}
                    className="mono text-[10px] px-1.5 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1"
                  >
                    slew to
                  </button>
                  <span className="mono micro tabular-nums text-txt-3">
                    {new Date(a.t).toISOString().slice(11, 19)}Z
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="micro">Current AOI</h3>
        {activeAoi ? (
          <div className="mt-1 border border-accent-line/60 bg-accent-dim rounded-sm p-2">
            <div className="mono text-[12px] text-txt-0 truncate" title={activeAoi.name}>{activeAoi.name}</div>
            <div className="micro mt-0.5 normal-case tracking-normal text-txt-3">{activeAoi.region}</div>
            <p className="text-[11px] text-txt-2 leading-snug mt-1">{activeAoi.significance}</p>
            <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              <span className="text-txt-3 micro normal-case tracking-normal">category</span>
              <span className="mono text-right">{activeAoi.category}</span>
              <span className="text-txt-3 micro normal-case tracking-normal">center</span>
              <span className="mono text-right tabular-nums">
                {activeAoi.center[1].toFixed(2)}, {activeAoi.center[0].toFixed(2)}
              </span>
              {activeAoi.daily_transits != null && (
                <>
                  <span className="text-txt-3 micro normal-case tracking-normal">transits/d</span>
                  <span className="mono text-right tabular-nums">{activeAoi.daily_transits}</span>
                </>
              )}
              {activeAoi.oil_flow_mbpd != null && (
                <>
                  <span className="text-txt-3 micro normal-case tracking-normal">oil mbpd</span>
                  <span className="mono text-right tabular-nums">{activeAoi.oil_flow_mbpd}</span>
                </>
              )}
            </div>
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => viewer && flyToChokepoint(viewer, activeAoi, reduced ? 0 : 1.4)}
                className="mono text-[10px] px-2 py-1 border border-line rounded-sm hover:border-accent-line text-txt-1"
              >
                slew to
              </button>
              <button
                type="button"
                onClick={() => setAoi(null)}
                className="mono text-[10px] px-2 py-1 border border-line rounded-sm hover:border-alert/40 hover:text-alert text-txt-2"
              >
                clear
              </button>
            </div>
          </div>
        ) : (
          <p className="micro normal-case tracking-normal text-txt-3 mt-1">
            No AOI active. Pick one from the Chokepoints tab.
          </p>
        )}
      </section>
    </div>
  );
}
