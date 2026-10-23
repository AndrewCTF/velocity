// Per-layer style overrides set in the Layer editor, persisted in localStorage.
// The globe reads these: LayerCompositor multiplies the descriptor opacity by
// `opacity`, PrimitiveEntityLayer multiplies icon scale by `scale` and replaces
// the billboard tint with `color`. Missing key = no override.
import { create } from "zustand";

export interface LayerStyleOverride {
  color?: string;
  scale?: number;
  opacity?: number;
}

type Overrides = Record<string, LayerStyleOverride>;

const LS_KEY = "velocity.layerStyles.v1";

function read(): Overrides {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Overrides)
      : {};
  } catch {
    return {};
  }
}

function persist(o: Overrides): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(o));
  } catch {
    /* private mode / storage disabled: in-memory only */
  }
}

interface LayerStyleState {
  overrides: Overrides;
  setOverride: (id: string, patch: LayerStyleOverride) => void;
  reset: (id: string) => void;
}

export const useLayerStyles = create<LayerStyleState>((set, get) => ({
  overrides: read(),
  setOverride: (id, patch) => {
    const overrides = {
      ...get().overrides,
      [id]: { ...get().overrides[id], ...patch },
    };
    set({ overrides });
    persist(overrides);
  },
  reset: (id) => {
    const { [id]: _drop, ...overrides } = get().overrides;
    set({ overrides });
    persist(overrides);
  },
}));

/** Override for one layer, or an empty object. Safe on a hostile key. */
export function layerOverride(id: string): LayerStyleOverride {
  const o = useLayerStyles.getState().overrides;
  return Object.prototype.hasOwnProperty.call(o, id) ? (o[id] ?? {}) : {};
}

/** Opacity multiplier in [0, 1]; 1 when unset or malformed. */
export function opacityMul(id: string): number {
  const v = layerOverride(id).opacity;
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : 1;
}

/** Scale multiplier clamped to the editor's 0.5-2x range; 1 when unset. */
export function scaleMul(id: string): number {
  const v = layerOverride(id).scale;
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(2, Math.max(0.5, v))
    : 1;
}

/** Tint colour string (#rrggbb) or null when unset or malformed. */
export function tintOf(id: string): string | null {
  const v = layerOverride(id).color;
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}
