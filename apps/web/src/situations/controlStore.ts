// Territorial-control layer — factions, controlled/contested AREAS (polygons) and
// FRONT LINES (polylines). Operator-drawn or imported from GeoJSON; there is no
// clean keyless global front-line feed, so this is real data the operator supplies,
// never an invented front. Local-first store with best-effort ontology persistence
// (mirrors annotationStore / copStore: one workspace object via /api/ontology/object).

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

export interface Faction {
  id: string;
  name: string;
  color: string; // css hex
}

export type ZoneStatus = 'controlled' | 'contested';
export type LineStatus = 'confirmed' | 'contested';

export interface ControlZone {
  id: string;
  factionId: string;
  status: ZoneStatus;
  label?: string | undefined;
  conditions?: string | undefined; // current conditions free-text (shelling, encircled, …)
  ring: [number, number][]; // [lon,lat] closed-ish ring
  asOf?: string | undefined;
}

export interface FrontLine {
  id: string;
  label?: string | undefined;
  status: LineStatus; // confirmed = solid, contested = dotted
  coords: [number, number][]; // [lon,lat]…
}

export const DEFAULT_FACTIONS: Faction[] = [
  { id: 'blue', name: 'Blue', color: '#38bdf8' },
  { id: 'red', name: 'Red', color: '#ef4444' },
  { id: 'green', name: 'Green', color: '#4ade80' },
];

let _seq = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

interface ControlState {
  factions: Faction[];
  zones: ControlZone[];
  lines: FrontLine[];
  addFaction: (name: string, color: string) => string;
  updateFaction: (id: string, patch: Partial<Omit<Faction, 'id'>>) => void;
  addZone: (z: Omit<ControlZone, 'id'>) => string;
  updateZone: (id: string, patch: Partial<Omit<ControlZone, 'id'>>) => void;
  removeZone: (id: string) => void;
  addLine: (l: Omit<FrontLine, 'id'>) => string;
  updateLine: (id: string, patch: Partial<Omit<FrontLine, 'id'>>) => void;
  removeLine: (id: string) => void;
  clear: () => void;
  replaceAll: (s: {
    factions?: Faction[] | undefined;
    zones?: ControlZone[] | undefined;
    lines?: FrontLine[] | undefined;
  }) => void;
}

export const useControl = create<ControlState>((set) => ({
  factions: DEFAULT_FACTIONS,
  zones: [],
  lines: [],
  addFaction: (name, color) => {
    const id = uid('fac');
    set((s) => ({ factions: [...s.factions, { id, name, color }] }));
    return id;
  },
  updateFaction: (id, patch) =>
    set((s) => ({ factions: s.factions.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
  addZone: (z) => {
    const id = uid('zone');
    set((s) => ({ zones: [...s.zones, { ...z, id }] }));
    return id;
  },
  updateZone: (id, patch) =>
    set((s) => ({ zones: s.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) })),
  removeZone: (id) => set((s) => ({ zones: s.zones.filter((z) => z.id !== id) })),
  addLine: (l) => {
    const id = uid('line');
    set((s) => ({ lines: [...s.lines, { ...l, id }] }));
    return id;
  },
  updateLine: (id, patch) =>
    set((s) => ({ lines: s.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) })),
  removeLine: (id) => set((s) => ({ lines: s.lines.filter((l) => l.id !== id) })),
  clear: () => set({ zones: [], lines: [] }),
  replaceAll: ({ factions, zones, lines }) =>
    set((s) => ({
      factions: factions ?? s.factions,
      zones: zones ?? s.zones,
      lines: lines ?? s.lines,
    })),
}));

export function factionColor(factions: Faction[], id: string): string {
  return factions.find((f) => f.id === id)?.color ?? '#9ca3af';
}

// ── GeoJSON import ───────────────────────────────────────────────────────────
// Lenient: Polygon/MultiPolygon → zones, LineString/MultiLineString → front lines.
// Faction is resolved from properties.faction|side|control|name against existing
// faction ids/names; unknown factions are created on the fly so an imported file
// paints immediately. Status read from properties.status ('contested' → contested).

interface GjGeometry {
  type: string;
  coordinates: unknown;
}
interface GjFeature {
  type: 'Feature';
  geometry: GjGeometry | null;
  properties?: Record<string, unknown> | null;
}

function asRing(coords: unknown): [number, number][] | null {
  // Polygon coords = [ring][point][lon,lat]; take the outer ring.
  if (!Array.isArray(coords) || !Array.isArray(coords[0])) return null;
  const outer = coords[0] as unknown[];
  const ring: [number, number][] = [];
  for (const p of outer) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
      ring.push([p[0], p[1]]);
    }
  }
  return ring.length >= 3 ? ring : null;
}

function asLine(coords: unknown): [number, number][] | null {
  if (!Array.isArray(coords)) return null;
  const line: [number, number][] = [];
  for (const p of coords) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
      line.push([p[0], p[1]]);
    }
  }
  return line.length >= 2 ? line : null;
}

/** Parse a GeoJSON string into control zones + front lines and merge them into the
 *  store (creating factions as needed). Returns counts + any per-feature errors. */
export function importGeoJSON(text: string): { zones: number; lines: number; errors: string[] } {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { zones: 0, lines: 0, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  const root = parsed as { type?: string; features?: GjFeature[] };
  const features: GjFeature[] =
    root.type === 'FeatureCollection' && Array.isArray(root.features)
      ? root.features
      : root.type === 'Feature'
        ? [root as unknown as GjFeature]
        : [];
  if (features.length === 0) return { zones: 0, lines: 0, errors: ['no GeoJSON features found'] };

  const st = useControl.getState();
  const factions = [...st.factions];
  const resolveFaction = (props: Record<string, unknown> | null | undefined): string => {
    const raw = String(
      props?.faction ?? props?.side ?? props?.control ?? props?.controlledBy ?? props?.name ?? '',
    ).trim();
    if (!raw) return factions[0]?.id ?? 'blue';
    const hit = factions.find(
      (f) => f.id.toLowerCase() === raw.toLowerCase() || f.name.toLowerCase() === raw.toLowerCase(),
    );
    if (hit) return hit.id;
    // Create a new faction for an unseen name, cycling a palette.
    const palette = ['#38bdf8', '#ef4444', '#4ade80', '#facc15', '#c084fc', '#f59e0b'];
    const color = palette[factions.length % palette.length]!;
    const id = uid('fac');
    factions.push({ id, name: raw, color });
    return id;
  };

  const zones: ControlZone[] = [];
  const lines: FrontLine[] = [];
  features.forEach((f, i) => {
    const g = f.geometry;
    if (!g) return;
    const props = f.properties ?? {};
    const status = String(props.status ?? '').toLowerCase();
    const label = props.label != null ? String(props.label) : props.name != null ? String(props.name) : undefined;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polys = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as unknown[]);
      for (const poly of polys) {
        const ring = asRing(poly);
        if (!ring) {
          errors.push(`feature ${i}: polygon has no valid ring`);
          continue;
        }
        zones.push({
          id: uid('zone'),
          factionId: resolveFaction(props),
          status: status === 'contested' ? 'contested' : 'controlled',
          label,
          conditions: props.conditions != null ? String(props.conditions) : undefined,
          ring,
        });
      }
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const segs = g.type === 'LineString' ? [g.coordinates] : (g.coordinates as unknown[]);
      for (const seg of segs) {
        const line = asLine(seg);
        if (!line) {
          errors.push(`feature ${i}: line has < 2 points`);
          continue;
        }
        lines.push({
          id: uid('line'),
          label,
          status: status === 'confirmed' ? 'confirmed' : status === 'contested' ? 'contested' : 'confirmed',
          coords: line,
        });
      }
    }
  });

  useControl.getState().replaceAll({
    factions,
    zones: [...st.zones, ...zones],
    lines: [...st.lines, ...lines],
  });
  return { zones: zones.length, lines: lines.length, errors };
}

// ── persistence (mirrors annotationStore) ────────────────────────────────────
const OBJ_ID = 'control:workspace';

export async function saveControl(): Promise<{ ok: boolean; status: number }> {
  const s = useControl.getState();
  const body = {
    id: OBJ_ID,
    props: { factions: s.factions, zones: s.zones, lines: s.lines, saved_at: new Date().toISOString() },
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

export async function loadControl(): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/ontology/object/${encodeURIComponent(OBJ_ID)}`);
    if (!r.ok) return false;
    const o = (await r.json()) as {
      props?: { factions?: Faction[]; zones?: ControlZone[]; lines?: FrontLine[] };
    };
    if (!o.props) return false;
    useControl.getState().replaceAll({
      factions: Array.isArray(o.props.factions) && o.props.factions.length ? o.props.factions : undefined,
      zones: Array.isArray(o.props.zones) ? o.props.zones : undefined,
      lines: Array.isArray(o.props.lines) ? o.props.lines : undefined,
    });
    return true;
  } catch {
    return false;
  }
}
