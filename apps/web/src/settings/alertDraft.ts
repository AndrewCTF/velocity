// A one-shot handoff from the map to the alert-rule form: the right-click /
// area menu "Alert me…" action drops the spot here, AppRouter opens Settings
// on the seq bump, and AlertRulesSection takes the draft once to prefill its
// form. Server-side rules (not watchboxes) because only the server-side
// evaluator keeps watching with the browser closed and can push to a phone.
import { create } from "zustand";

export interface AlertDraft {
  label: string;
  lat: number;
  lon: number;
  radius_nm: number;
}

interface AlertDraftState {
  draft: AlertDraft | null;
  seq: number;
  open: (d: AlertDraft) => void;
  take: () => AlertDraft | null;
}

export const useAlertDraft = create<AlertDraftState>((set, get) => ({
  draft: null,
  seq: 0,
  open: (d) => set((s) => ({ draft: d, seq: s.seq + 1 })),
  take: () => {
    const d = get().draft;
    if (d) set({ draft: null });
    return d;
  },
}));
