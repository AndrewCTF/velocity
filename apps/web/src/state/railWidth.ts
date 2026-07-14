// Right-rail (inspector) width — lifted out of ConsoleShell-local useState so a
// header control INSIDE the rail (Wide toggle) and the drag/keyboard resizer can
// both drive it, and so the value survives remounts within a session. Persists
// to the same localStorage key ConsoleShell has always used (`csl.rightW`) so a
// user's existing width carries over. ConsoleShell still publishes it as the
// `--rail-right-w` CSS var (guard-tested) — this store is only the source value.
import { create } from 'zustand';

const LS_RIGHT = 'csl.rightW';
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 680;
const DEFAULT = 360;
// The "Wide" reading width — enough for the EntityPanel card stack to reflow to
// two columns (see theme/reflow.css `@container` breakpoint at 500px content).
export const RIGHT_WIDE = 560;

const clamp = (n: number): number => Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, n));

function read(): number {
  try {
    const v = Number(localStorage.getItem(LS_RIGHT));
    return Number.isFinite(v) && v > 0 ? clamp(v) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function persist(w: number): void {
  try {
    localStorage.setItem(LS_RIGHT, String(w));
  } catch {
    /* ignore */
  }
}

interface RailWidthState {
  rightW: number;
  /** Set an explicit width (clamped + persisted). */
  setRightW: (w: number) => void;
  /** Snap between the default and the wide reading width. */
  toggleWide: () => void;
  /** Whether the rail is currently at/above the wide reading width. */
  isWide: () => boolean;
}

export const useRailWidth = create<RailWidthState>((set, get) => ({
  rightW: read(),
  setRightW: (w) => {
    const next = clamp(w);
    persist(next);
    set({ rightW: next });
  },
  toggleWide: () => {
    // Anything within ~40px of wide counts as "already wide" → collapse back.
    const next = get().rightW >= RIGHT_WIDE - 40 ? DEFAULT : RIGHT_WIDE;
    persist(next);
    set({ rightW: next });
  },
  isWide: () => get().rightW >= RIGHT_WIDE - 40,
}));
