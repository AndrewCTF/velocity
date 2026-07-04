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

const POLL_MS = 30_000;

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
