import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

export interface WatchOfficerEvidence {
  domain: string;
  severity: string;
  summary: string;
  lon: number;
  lat: number;
  ref?: string;
  kind?: 'measured' | 'inferred';
  basis?: string;
}

export interface WatchOfficerBrief {
  id: string;
  key: string;
  created: number;
  threat_level: 'high' | 'elevated' | 'low' | string;
  domains: string[];
  centroid: { lon?: number; lat?: number };
  title: string;
  narrative?: string;
  evidence: WatchOfficerEvidence[];
  follow_up: string[];
  playbook: Record<string, unknown>;
  status: string;
}

export interface WatchOfficerPlaybook {
  id: string;
  trigger: string;
  action: string;
}

export interface WatchOfficerStatus {
  running: boolean;
  cycle_s: number;
  sweeps: number;
  open: number;
  by_level: Record<string, number>;
  total_filed: number;
  last_sweep_at: number | null;
  last_filed_at: number | null;
  playbooks: WatchOfficerPlaybook[];
}

const POLL_MS = 30_000;

/** Poll the watch-officer live telemetry — proves the autonomous loop is alive
 *  and shows what it will DO (playbooks). Null until the first response. */
export function useWatchOfficerStatus(): WatchOfficerStatus | null {
  const [status, setStatus] = useState<WatchOfficerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/watch-officer/status');
        if (!r.ok) return;
        const j = (await r.json()) as WatchOfficerStatus;
        if (alive) setStatus(j);
      } catch {
        /* transient */
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return status;
}

/** Poll the watch-officer draft briefs + expose dismiss/ack. Optimistically
 *  drops a brief locally on triage so the UI feels instant; the next poll
 *  reconciles with the backend. */
export function useWatchOfficerBriefs(): {
  briefs: WatchOfficerBrief[];
  dismiss: (id: string) => void;
  ack: (id: string) => void;
} {
  const [briefs, setBriefs] = useState<WatchOfficerBrief[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/watch-officer/briefs');
        if (!r.ok) return;
        const j = (await r.json()) as { briefs?: WatchOfficerBrief[] };
        if (alive) setBriefs(j.briefs ?? []);
      } catch {
        /* transient — next tick retries */
      }
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const triage = useCallback((id: string, verb: 'dismiss' | 'ack'): void => {
    setBriefs((bs) => bs.filter((b) => b.id !== id));
    void apiFetch(`/api/watch-officer/briefs/${encodeURIComponent(id)}/${verb}`, { method: 'POST' });
  }, []);

  const dismiss = useCallback((id: string) => triage(id, 'dismiss'), [triage]);
  const ack = useCallback((id: string) => triage(id, 'ack'), [triage]);

  return { briefs, dismiss, ack };
}

export interface BriefElaboration {
  ok: boolean;
  id: string;
  text: string;
  model?: string;
  backend?: string;
  cached?: boolean;
}

/** Fetch a deeper AI write-up of one brief (grounded in its evidence). Returns
 *  null on any failure — the caller shows the brief without elaboration. 409
 *  means selection inference is off; surfaced as a typed sentinel so the UI can
 *  prompt the operator to enable it rather than silently doing nothing. */
export async function elaborateBrief(id: string): Promise<BriefElaboration | 'disabled' | null> {
  try {
    const r = await apiFetch(`/api/watch-officer/briefs/${encodeURIComponent(id)}/elaborate`, {
      method: 'POST',
    });
    if (r.status === 409) return 'disabled';
    if (!r.ok) return null;
    return (await r.json()) as BriefElaboration;
  } catch {
    return null;
  }
}
