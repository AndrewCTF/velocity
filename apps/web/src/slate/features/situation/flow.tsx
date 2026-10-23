import { useEffect, type CSSProperties } from "react";
import { create } from "zustand";
import "./actions.css";
import { BpIcon } from "../../../shell/BpIcon.js";
import { useAppView } from "../../../state/appView.js";
import {
  useSituations,
  type Situation,
} from "../../../situations/situationStore.js";
import type { HypState } from "./ActionCards.js";

// The live situation's decision state (features-b): the selected action
// (G54), explanation statuses (G45/G46), compare mode (G50), and resolving
// (G55 blue status toast with Cancel, then G56 "review this situation"
// prompt). Resolving saves the detection as a situation with status
// "resolved" through the situations store (POST /api/situations, kept
// locally when not signed in, as that store already does).

const RESOLVE_MS = 3000;

export const useSitFlow = create<{
  selected: string | null;
  hyps: Record<string, HypState>;
  compare: boolean;
  resolving: { name: string; patch: Partial<Situation>; at: number } | null;
  resolved: { id: string; name: string } | null;
  prompt: boolean;
  select: (id: string | null) => void;
  setHyp: (k: string, s: HypState) => void;
  toggleCompare: () => void;
  startResolve: (name: string, patch: Partial<Situation>) => void;
  cancelResolve: () => void;
  finish: (id: string, name: string) => void;
  closePrompt: () => void;
}>((set) => ({
  selected: null,
  hyps: {},
  compare: false,
  resolving: null,
  resolved: null,
  prompt: false,
  select: (selected) => set({ selected }),
  setHyp: (k, s) => set((st) => ({ hyps: { ...st.hyps, [k]: s } })),
  toggleCompare: () => set((st) => ({ compare: !st.compare })),
  startResolve: (name, patch) =>
    set({ resolving: { name, patch, at: Date.now() } }),
  cancelResolve: () => set({ resolving: null }),
  finish: (id, name) =>
    set({ resolving: null, resolved: { id, name }, prompt: true }),
  closePrompt: () => set({ prompt: false }),
}));

const box = (
  left: number,
  top: number,
  width?: number,
  height?: number,
  extra: CSSProperties = {},
): CSSProperties => ({
  position: "absolute",
  left,
  top,
  width,
  height,
  ...extra,
});

/** G55: "Updating <name> status to Resolved..." with Cancel; saves on expiry. */
export function ResolveToast(): JSX.Element | null {
  const r = useSitFlow((s) => s.resolving);
  const create = useSituations((s) => s.create);
  useEffect(() => {
    if (!r) return;
    const t = window.setTimeout(() => {
      void create({ ...r.patch, name: r.name, status: "resolved" }).then((id) =>
        useSitFlow.getState().finish(id, r.name),
      );
    }, RESOLVE_MS);
    return () => window.clearTimeout(t);
  }, [r, create]);
  if (!r) return null;
  return (
    <div className="sl-g55" role="status" aria-live="polite">
      <span className="sl-spin" style={box(17, 15, 18, 18)} />
      <span className="sl-g55t" style={box(49, 13)}>
        Updating <b>{r.name}</b> status to <b>Resolved</b>...
      </span>
      <button
        type="button"
        className="sl-g55c"
        style={box(497, 13)}
        onClick={() => useSitFlow.getState().cancelResolve()}
      >
        Cancel
      </button>
      <button
        type="button"
        className="sl-g55x"
        style={box(569, 15, 17, 17)}
        aria-label="Cancel"
        onClick={() => useSitFlow.getState().cancelResolve()}
      >
        <BpIcon name="cross" size={15} />
      </button>
    </div>
  );
}

/** G56: "Would you like to review this situation?" after resolving. */
export function ReviewPrompt(): JSX.Element | null {
  const on = useSitFlow((s) => s.prompt);
  if (!on) return null;
  return (
    <div className="sl-g56" role="dialog" aria-label="Review this situation">
      <span className="sl-g56t" style={box(23, 13)}>
        Would you like to review this situation?
      </span>
      <button
        type="button"
        className="sl-g56b"
        style={box(340, 10, 249, 28)}
        onClick={() => {
          useSitFlow.getState().closePrompt();
          useAppView.getState().setApp("reports");
        }}
      >
        Complete After Action Report <BpIcon name="arrow-right" size={16} />
      </button>
      <button
        type="button"
        className="sl-g56x"
        style={box(607, 15, 16, 16)}
        aria-label="Dismiss"
        onClick={() => useSitFlow.getState().closePrompt()}
      >
        <BpIcon name="cross" size={16} />
      </button>
    </div>
  );
}
