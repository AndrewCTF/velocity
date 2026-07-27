// Free-hand annotations / tactical graphics.
//
// This was three kinds (point, line, circle), two options (a four-value threat
// colour and a label), no undo, no groups, no export, and no working
// persistence — `loadAnnotations` was exported and imported by nothing, so even
// a manual Save was never read back. The map toolbar could only ever produce an
// unlabelled yellow dot, because it passed `{ threat: 'unknown', label: '' }`
// literally, while the panel could produce three kinds; and the renderer tore
// the whole layer down on every keystroke.
//
// Kinds and styling are additive: `threat` stays first-class and still supplies
// the DEFAULT colour, `style` overrides it. Every previously stored annotation
// still parses.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { apiFetch } from '../transport/http.js';

export type AnnoKind =
  | 'point'
  | 'line'
  | 'circle'
  | 'polygon'
  | 'rect'
  | 'arrow'
  | 'corridor'
  | 'sector'
  | 'text'
  | 'symbol'
  | 'freehand';

export type Threat = 'hostile' | 'friendly' | 'neutral' | 'unknown';

export const THREAT_COLOR: Record<Threat, string> = {
  hostile: '#ef4444',
  friendly: '#38bdf8',
  neutral: '#4ade80',
  unknown: '#facc15',
};

export interface AnnoStyle {
  /** Any CSS colour. Absent → the threat colour. */
  color?: string;
  width: number;
  opacity: number;
  fillOpacity: number;
  dash: 'solid' | 'dash' | 'dot';
  fontSize: number;
  pointSize: number;
  outline: boolean;
}

export const DEFAULT_STYLE: AnnoStyle = {
  width: 3,
  opacity: 0.9,
  fillOpacity: 0.12,
  dash: 'solid',
  fontSize: 11,
  pointSize: 11,
  outline: true,
};

export interface Annotation {
  id: string;
  kind: AnnoKind;
  label: string;
  threat: Threat;
  /** Longer free text — the note an operator actually wants to leave. */
  note?: string;
  style?: Partial<AnnoStyle>;
  /** MIL-STD-2525 / APP-6 symbol identification code, for kind 'symbol'. */
  sidc?: string;
  /** Rendered symbol as a data URI, cached so the renderer stays synchronous. */
  symbolSvg?: string;
  coords?: [number, number][]; // [lon,lat]…
  center?: { lat: number; lon: number };
  radiusKm?: number;
  /** Corridor half-width, km. */
  widthKm?: number;
  /** Sector/arrow orientation, degrees true. */
  bearingDeg?: number;
  /** Sector opening angle, degrees. */
  sweepDeg?: number;
  group?: string;
  locked?: boolean;
  hidden?: boolean;
  z?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** Effective colour: explicit style wins, else the threat palette. */
export function annotationColor(a: Annotation): string {
  return a.style?.color ?? THREAT_COLOR[a.threat] ?? THREAT_COLOR.unknown;
}

/** Effective style: defaults with the annotation's overrides applied. */
export function annotationStyle(a: Annotation): AnnoStyle {
  return { ...DEFAULT_STYLE, ...(a.style ?? {}) };
}

// Resolve localStorage defensively. The test environment — and a locked-down
// browser profile — can expose a `localStorage` that is not a usable Storage,
// and persist would then throw on the FIRST mutation, taking every annotation
// action with it. A no-op store means no persistence, which is the honest
// degrade; the drawings still work for the session.
const memoryStore: Storage = (() => {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
})();

const safeLocalStorage: Storage = (() => {
  try {
    const ls = globalThis.localStorage as Storage | undefined;
    if (ls && typeof ls.setItem === 'function' && typeof ls.getItem === 'function') {
      // Prove it actually works before trusting it (private mode throws on write).
      ls.setItem('osint.probe', '1');
      ls.removeItem('osint.probe');
      return ls;
    }
  } catch {
    /* fall through to memory */
  }
  return memoryStore;
})();

let _seq = 0;
const uid = (): string => `an-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

const HISTORY_CAP = 50;

interface AnnoState {
  annotations: Annotation[];
  past: Annotation[][];
  future: Annotation[][];
  add: (a: Omit<Annotation, 'id'>) => string;
  update: (id: string, patch: Partial<Omit<Annotation, 'id'>>) => void;
  remove: (id: string) => void;
  clear: () => void;
  replaceAll: (a: Annotation[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

/** Every mutation routes through here so undo is not something to remember. */
function withHistory(
  s: AnnoState,
  next: Annotation[],
): Pick<AnnoState, 'annotations' | 'past' | 'future'> {
  const past = [...s.past, s.annotations].slice(-HISTORY_CAP);
  return { annotations: next, past, future: [] };
}

export const useAnnotations = create<AnnoState>()(
  persist(
    (set, get) => ({
      annotations: [],
      past: [],
      future: [],
      add: (a) => {
        const id = uid();
        const now = Date.now();
        set((s) =>
          withHistory(s, [...s.annotations, { createdAt: now, updatedAt: now, ...a, id }]),
        );
        return id;
      },
      update: (id, patch) =>
        set((s) =>
          withHistory(
            s,
            s.annotations.map((a) =>
              a.id === id && !a.locked ? { ...a, ...patch, updatedAt: Date.now() } : a,
            ),
          ),
        ),
      remove: (id) =>
        set((s) => withHistory(s, s.annotations.filter((a) => a.id !== id))),
      clear: () => set((s) => withHistory(s, [])),
      replaceAll: (a) => set((s) => withHistory(s, a)),
      undo: () =>
        set((s) => {
          const prev = s.past[s.past.length - 1];
          if (!prev) return s;
          return {
            annotations: prev,
            past: s.past.slice(0, -1),
            future: [s.annotations, ...s.future].slice(0, HISTORY_CAP),
          };
        }),
      redo: () =>
        set((s) => {
          const next = s.future[0];
          if (!next) return s;
          return {
            annotations: next,
            past: [...s.past, s.annotations].slice(-HISTORY_CAP),
            future: s.future.slice(1),
          };
        }),
      canUndo: () => get().past.length > 0,
      canRedo: () => get().future.length > 0,
    }),
    {
      name: 'osint.annotations',
      storage: createJSONStorage(() => safeLocalStorage),
      // History is a session concern; only the drawings survive a reload.
      partialize: (s) => ({ annotations: s.annotations }) as unknown as AnnoState,
      version: 1,
    },
  ),
);

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

/**
 * Pull the saved workspace and merge it over what is in local storage,
 * newest-`updatedAt` wins per id.
 *
 * This existed before and was called from nowhere, so the ontology round-trip
 * had never actually worked. Merging rather than replacing means a drawing made
 * on this machine before signing in is not thrown away by the first load.
 */
export async function loadAnnotations(): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/ontology/object/${encodeURIComponent(OBJ_ID)}`);
    if (!r.ok) return false;
    const o = (await r.json()) as { props?: { annotations?: Annotation[] } };
    const remote = o.props?.annotations;
    if (!Array.isArray(remote)) return false;
    const byId = new Map<string, Annotation>();
    for (const a of useAnnotations.getState().annotations) byId.set(a.id, a);
    for (const a of remote) {
      const local = byId.get(a.id);
      if (!local || (a.updatedAt ?? 0) >= (local.updatedAt ?? 0)) byId.set(a.id, a);
    }
    useAnnotations.getState().replaceAll([...byId.values()]);
    return true;
  } catch {
    return false;
  }
}

// ── import / export ──────────────────────────────────────────────────────────

/** GeoJSON FeatureCollection of every annotation, properties round-trip. */
export function annotationsToGeoJSON(): string {
  const feats = useAnnotations.getState().annotations.map((a) => {
    let geometry: Record<string, unknown> | null = null;
    if (a.coords && a.coords.length >= 3 && ['polygon', 'rect', 'corridor'].includes(a.kind)) {
      geometry = { type: 'Polygon', coordinates: [[...a.coords, a.coords[0]!]] };
    } else if (a.coords && a.coords.length >= 2) {
      geometry = { type: 'LineString', coordinates: a.coords };
    } else if (a.coords?.[0]) {
      geometry = { type: 'Point', coordinates: a.coords[0] };
    } else if (a.center) {
      geometry = { type: 'Point', coordinates: [a.center.lon, a.center.lat] };
    }
    return {
      type: 'Feature',
      id: a.id,
      geometry,
      properties: {
        kind: a.kind,
        label: a.label,
        note: a.note,
        threat: a.threat,
        style: a.style,
        sidc: a.sidc,
        radiusKm: a.radiusKm,
        widthKm: a.widthKm,
        bearingDeg: a.bearingDeg,
        sweepDeg: a.sweepDeg,
        group: a.group,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      },
    };
  });
  return JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 2);
}

/** Read back an export (or any GeoJSON) as annotations. Returns the count added. */
export function annotationsFromGeoJSON(text: string): number {
  let fc: { features?: unknown[] };
  try {
    fc = JSON.parse(text) as { features?: unknown[] };
  } catch {
    return 0;
  }
  const add = useAnnotations.getState().add;
  let n = 0;
  for (const raw of fc.features ?? []) {
    const f = raw as {
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const p = f.properties ?? {};
    const g = f.geometry;
    if (!g?.type) continue;
    const kind = (typeof p['kind'] === 'string' ? p['kind'] : null) as AnnoKind | null;
    let coords: [number, number][] | undefined;
    let center: { lat: number; lon: number } | undefined;
    if (g.type === 'Point') {
      const c = g.coordinates as [number, number];
      coords = [c];
      center = { lon: c[0], lat: c[1] };
    } else if (g.type === 'LineString') {
      coords = g.coordinates as [number, number][];
    } else if (g.type === 'Polygon') {
      coords = (g.coordinates as [number, number][][])[0]?.slice(0, -1);
    }
    // exactOptionalPropertyTypes: build the object by ASSIGNING only the keys
    // that are actually present, rather than assigning `undefined`.
    const draft: Omit<Annotation, 'id'> = {
      kind:
        kind ??
        (g.type === 'Polygon' ? 'polygon' : g.type === 'LineString' ? 'line' : 'point'),
      label: typeof p['label'] === 'string' ? p['label'] : '',
      threat: (typeof p['threat'] === 'string' ? p['threat'] : 'unknown') as Threat,
    };
    if (typeof p['note'] === 'string') draft.note = p['note'];
    if (p['style']) draft.style = p['style'] as Partial<AnnoStyle>;
    if (typeof p['sidc'] === 'string') draft.sidc = p['sidc'];
    if (coords) draft.coords = coords;
    if (typeof p['radiusKm'] === 'number') {
      draft.radiusKm = p['radiusKm'];
      if (center) draft.center = center;
    }
    if (typeof p['bearingDeg'] === 'number') draft.bearingDeg = p['bearingDeg'];
    if (typeof p['sweepDeg'] === 'number') draft.sweepDeg = p['sweepDeg'];
    if (typeof p['group'] === 'string') draft.group = p['group'];
    add(draft);
    n++;
  }
  return n;
}

if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __annotations: typeof useAnnotations }).__annotations = useAnnotations;
}

// ── the shared draft ─────────────────────────────────────────────────────────
//
// Three surfaces create annotations — the panel, the map toolbar's annotate
// tool, and the right-click context menu — and they used to disagree: the panel
// offered three kinds and a colour, the toolbar hardcoded
// `{ threat: 'unknown', label: '' }` and could only drop a point, the context
// menu hardcoded `'Marker'`. So the tool's own tooltip promised "labelled
// markers" and produced unlabelled yellow dots.
//
// One draft, read by all three. Whatever is selected in the panel is what the
// toolbar drops.

interface DraftState {
  kind: AnnoKind;
  threat: Threat;
  label: string;
  style: Partial<AnnoStyle>;
  sidc: string;
  set: (patch: Partial<Omit<DraftState, 'set' | 'setStyle'>>) => void;
  setStyle: (patch: Partial<AnnoStyle>) => void;
}

export const useAnnoDraft = create<DraftState>((set) => ({
  kind: 'point',
  threat: 'unknown',
  label: '',
  style: {},
  sidc: '',
  set: (patch) => set(patch),
  setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
}));

/** The annotation a placement surface should create right now, minus geometry. */
export function draftBase(): Pick<Annotation, 'kind' | 'threat' | 'label' | 'style' | 'sidc'> {
  const d = useAnnoDraft.getState();
  const out: Pick<Annotation, 'kind' | 'threat' | 'label' | 'style' | 'sidc'> = {
    kind: d.kind,
    threat: d.threat,
    label: d.label,
  };
  if (Object.keys(d.style).length > 0) out.style = { ...d.style };
  if (d.sidc) out.sidc = d.sidc;
  return out;
}
