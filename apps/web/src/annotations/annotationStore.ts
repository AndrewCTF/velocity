// Free-hand annotations / graphics layer — points, lines, and circles with a
// label and a threat colour, drawn on the globe via the shared draw toolbox.
// Local-first store; best-effort ontology persistence (mirrors copStore).

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

export type AnnoKind = 'point' | 'line' | 'circle';
export type Threat = 'hostile' | 'friendly' | 'neutral' | 'unknown';

export const THREAT_COLOR: Record<Threat, string> = {
  hostile: '#ef4444',
  friendly: '#38bdf8',
  neutral: '#4ade80',
  unknown: '#facc15',
};

export interface Annotation {
  id: string;
  kind: AnnoKind;
  label: string;
  threat: Threat;
  coords?: [number, number][]; // [lon,lat]… — point uses one, line many
  center?: { lat: number; lon: number };
  radiusKm?: number;
}

let _seq = 0;
const uid = (): string => `an-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

interface AnnoState {
  annotations: Annotation[];
  add: (a: Omit<Annotation, 'id'>) => string;
  update: (id: string, patch: Partial<Omit<Annotation, 'id'>>) => void;
  remove: (id: string) => void;
  clear: () => void;
  replaceAll: (a: Annotation[]) => void;
}

export const useAnnotations = create<AnnoState>((set) => ({
  annotations: [],
  add: (a) => {
    const id = uid();
    set((s) => ({ annotations: [...s.annotations, { ...a, id }] }));
    return id;
  },
  update: (id, patch) =>
    set((s) => ({ annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  remove: (id) => set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) })),
  clear: () => set({ annotations: [] }),
  replaceAll: (a) => set({ annotations: a }),
}));

const OBJ_ID = 'annotations:workspace';

export async function saveAnnotations(): Promise<{ ok: boolean; status: number }> {
  const body = {
    id: OBJ_ID,
    props: { annotations: useAnnotations.getState().annotations, saved_at: new Date().toISOString() },
  };
  try {
    const r = await apiFetch('/api/ontology/object', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function loadAnnotations(): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/ontology/object/${encodeURIComponent(OBJ_ID)}`);
    if (!r.ok) return false;
    const o = (await r.json()) as { props?: { annotations?: Annotation[] } };
    if (!Array.isArray(o.props?.annotations)) return false;
    useAnnotations.getState().replaceAll(o.props.annotations);
    return true;
  } catch {
    return false;
  }
}
