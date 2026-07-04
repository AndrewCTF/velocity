// Situation store — the Gotham aggregate "case file" (PLA Military Exercise /
// South China Sea Situation). Backed by the situations API (ontology objects +
// contains links), local-first so the panels work read/write in-memory and only
// PERSISTENCE degrades when Supabase / sign-in is absent (the 503 contract).

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

export type Severity = 'critical' | 'high' | 'med' | 'low';
export type Status = 'active' | 'monitoring' | 'resolved' | 'archived';

export interface Situation {
  id: string;
  name: string;
  severity: Severity;
  status: Status;
  centroid?: { lat: number; lon: number } | null;
  radius_km: number;
  summary: string;
  report: string;
  updated_at?: string | null;
  created_at?: string | null;
}

let _seq = 0;
const localId = (): string => `situation:loc-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

interface SituationState {
  situations: Situation[];
  loading: boolean;
  error: string | null; // last persistence error (e.g. "sign in to save"), or null
  load: () => Promise<void>;
  create: (partial: Partial<Situation>) => Promise<string>;
  update: (id: string, patch: Partial<Situation>) => Promise<void>;
  linkChild: (id: string, dst: string, rel?: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

function defaults(partial: Partial<Situation>): Situation {
  return {
    id: partial.id ?? localId(),
    name: partial.name ?? 'Untitled situation',
    severity: partial.severity ?? 'med',
    status: partial.status ?? 'active',
    centroid: partial.centroid ?? null,
    radius_km: partial.radius_km ?? 50,
    summary: partial.summary ?? '',
    report: partial.report ?? '',
    updated_at: partial.updated_at ?? null,
    created_at: partial.created_at ?? null,
  };
}

// Persist a situation; returns the server row on success, null on degrade.
async function persist(sit: Situation): Promise<Situation | null> {
  try {
    const r = await apiFetch('/api/situations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sit),
    });
    if (!r.ok) return null;
    return (await r.json()) as Situation;
  } catch {
    return null;
  }
}

export const useSituations = create<SituationState>((set, get) => ({
  situations: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true });
    try {
      const r = await apiFetch('/api/situations');
      if (r.ok) {
        const list = (await r.json()) as Situation[];
        set({ situations: list, error: null });
      } else {
        set({ error: r.status === 401 ? 'sign in to load saved situations' : null });
      }
    } catch {
      /* offline — keep whatever is in memory */
    } finally {
      set({ loading: false });
    }
  },
  create: async (partial) => {
    const sit = defaults(partial);
    // Optimistic local insert so the UI is instant + works offline.
    set((s) => ({ situations: [sit, ...s.situations] }));
    const saved = await persist(sit);
    if (saved) {
      set((s) => ({
        situations: s.situations.map((x) => (x.id === sit.id ? saved : x)),
        error: null,
      }));
      return saved.id;
    }
    set({ error: 'not saved — sign in (kept locally)' });
    return sit.id;
  },
  update: async (id, patch) => {
    const cur = get().situations.find((x) => x.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    set((s) => ({ situations: s.situations.map((x) => (x.id === id ? next : x)) }));
    const saved = await persist(next);
    if (!saved) set({ error: 'changes not saved — sign in (kept locally)' });
    else set({ error: null });
  },
  linkChild: async (id, dst, rel = 'contains') => {
    try {
      const r = await apiFetch(`/api/situations/${encodeURIComponent(id)}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dst, rel }),
      });
      if (!r.ok) {
        set({ error: 'link not saved — sign in' });
        return false;
      }
      set({ error: null });
      return true;
    } catch {
      return false;
    }
  },
  remove: async (id) => {
    set((s) => ({ situations: s.situations.filter((x) => x.id !== id) }));
    try {
      await apiFetch(`/api/situations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* gone locally regardless */
    }
  },
}));
