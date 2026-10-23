import { create } from "zustand";
import type { Pass } from "../sim/tasking.js";
import type { Detection } from "./DetectedSituation.js";

// The last "Detected in view" result. A store, not panel state, because the
// panel lives in Case files (over the globe) and the highlight must survive the
// switch back to the map. Rendered by globe/DetectedLayer.ts.
export type SarState = Pass | null | "none" | "err";

export const useDetected = create<{
  det: Detection | null;
  sar: SarState;
  set: (p: { det?: Detection | null; sar?: SarState }) => void;
}>((set) => ({ det: null, sar: null, set: (p) => set(p) }));
