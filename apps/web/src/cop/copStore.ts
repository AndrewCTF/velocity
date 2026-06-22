// Editable Common Operational Picture store. Seeded from the notional laydown,
// then mutated by the COP editor (place units, draw FLOT/phase lines, range
// rings). MilSymbolAdapter subscribes and re-renders on every change, so edits
// appear live on the globe. Persistence is local-first (this store) with a
// best-effort push to the ontology when the user is logged in.

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';
import { NOTIONAL_COP, type CopUnit, type CopLine, type CopRing } from './notionalCop.js';

export type Affiliation = 'F' | 'H' | 'N' | 'U';
export type UnitType =
  | 'infantry'
  | 'armor'
  | 'artillery'
  | 'ada'
  | 'recon'
  | 'engineer'
  | 'hq'
  | 'support';
export type Echelon =
  | 'none'
  | 'team'
  | 'squad'
  | 'section'
  | 'platoon'
  | 'company'
  | 'battalion'
  | 'regiment'
  | 'brigade'
  | 'division';

// MIL-STD-2525C function-id fragments (positions 5–10) per unit type, matching
// the hand-authored SIDCs in notionalCop.ts.
const TYPE_CODE: Record<UnitType, string> = {
  infantry: 'UCIZ--',
  armor: 'UCAZ--',
  artillery: 'UCFZ--',
  ada: 'UCDZ--',
  recon: 'UCRVA-',
  engineer: 'UCEZ--',
  hq: 'UH----',
  support: 'USS---',
};
// Echelon character (the slot after the function id; renders as ticks above the
// frame in milsymbol).
const ECH_CHAR: Record<Echelon, string> = {
  none: '-',
  team: 'A',
  squad: 'B',
  section: 'C',
  platoon: 'D',
  company: 'E',
  battalion: 'F',
  regiment: 'G',
  brigade: 'H',
  division: 'I',
};

export const TYPE_LABEL: Record<UnitType, string> = {
  infantry: 'Infantry',
  armor: 'Armor',
  artillery: 'Artillery',
  ada: 'Air Defense',
  recon: 'Recon/Cav',
  engineer: 'Engineer',
  hq: 'HQ',
  support: 'Support',
};
export const AFFIL_LABEL: Record<Affiliation, string> = {
  F: 'Friendly',
  H: 'Hostile',
  N: 'Neutral',
  U: 'Unknown',
};

/** Compose a 2525C SIDC: warfighting / affiliation / ground / present / type / echelon. */
export function composeSidc(aff: Affiliation, type: UnitType, ech: Echelon): string {
  return `S${aff}GP${TYPE_CODE[type]}${ECH_CHAR[ech]}---`;
}

let _seq = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

interface CopSnapshot {
  units: CopUnit[];
  lines: CopLine[];
  rings: CopRing[];
}

function seed(): CopSnapshot {
  return {
    units: NOTIONAL_COP.units.map((u) => ({ ...u })),
    lines: NOTIONAL_COP.lines.map((l) => ({ ...l, coords: l.coords.map((c) => [...c] as [number, number]) })),
    rings: NOTIONAL_COP.rings.map((r) => ({ ...r })),
  };
}

interface CopState extends CopSnapshot {
  addUnit: (u: Omit<CopUnit, 'id'>) => string;
  moveUnit: (id: string, lat: number, lon: number) => void;
  removeUnit: (id: string) => void;
  addLine: (l: Omit<CopLine, 'id'>) => string;
  removeLine: (id: string) => void;
  addRing: (r: Omit<CopRing, 'id'>) => string;
  removeRing: (id: string) => void;
  reset: () => void; // reseed from the notional laydown
  clearAll: () => void; // empty COP
  replaceAll: (s: CopSnapshot) => void; // load from persistence
}

export const useCop = create<CopState>((set) => ({
  ...seed(),
  addUnit: (u) => {
    const id = uid('u');
    set((s) => ({ units: [...s.units, { ...u, id }] }));
    return id;
  },
  moveUnit: (id, lat, lon) =>
    set((s) => ({ units: s.units.map((u) => (u.id === id ? { ...u, lat, lon } : u)) })),
  removeUnit: (id) => set((s) => ({ units: s.units.filter((u) => u.id !== id) })),
  addLine: (l) => {
    const id = uid('l');
    set((s) => ({ lines: [...s.lines, { ...l, id }] }));
    return id;
  },
  removeLine: (id) => set((s) => ({ lines: s.lines.filter((l) => l.id !== id) })),
  addRing: (r) => {
    const id = uid('r');
    set((s) => ({ rings: [...s.rings, { ...r, id }] }));
    return id;
  },
  removeRing: (id) => set((s) => ({ rings: s.rings.filter((r) => r.id !== id) })),
  reset: () => set(seed()),
  clearAll: () => set({ units: [], lines: [], rings: [] }),
  replaceAll: (s) => set({ units: s.units, lines: s.lines, rings: s.rings }),
}));

// ── best-effort ontology persistence (requires login; degrades silently) ──────
// Stored as a single ontology object keyed by id; kind defaults to "object"
// server-side (the backend's ObjectKind literal has no "cop", so we don't force
// one). Returns the HTTP status so the UI can report honestly.
const COP_OBJ_ID = 'cop:workspace';

export async function saveCopToOntology(): Promise<{ ok: boolean; status: number }> {
  const s = useCop.getState();
  const body = {
    id: COP_OBJ_ID,
    props: {
      units: s.units,
      lines: s.lines,
      rings: s.rings,
      saved_at: new Date().toISOString(),
    },
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

export async function loadCopFromOntology(): Promise<boolean> {
  try {
    const r = await apiFetch(`/api/ontology/object/${encodeURIComponent(COP_OBJ_ID)}`);
    if (!r.ok) return false;
    const o = (await r.json()) as { props?: Partial<CopSnapshot> };
    const p = o.props ?? {};
    if (!Array.isArray(p.units)) return false;
    useCop.getState().replaceAll({
      units: p.units,
      lines: Array.isArray(p.lines) ? p.lines : [],
      rings: Array.isArray(p.rings) ? p.rings : [],
    });
    return true;
  } catch {
    return false;
  }
}
