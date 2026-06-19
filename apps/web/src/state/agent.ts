import { create } from 'zustand';

// Shared state for the Velocity analyst console (the "AI bar"). The command-bar
// AGENT indicator and the floating console talk through this store: the
// indicator opens the console; a search/slash submit anywhere can hand it a
// query to run. Kept tiny — the console owns its own request lifecycle.

interface AgentState {
  open: boolean;
  // A query handed in from elsewhere (command bar indicator, search). The
  // console consumes it (runs it) and clears pending back to null. `seq`
  // bumps so the same text submitted twice still re-triggers.
  pending: { q: string; seq: number } | null;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  // Open the console and run an investigation for `q`.
  ask: (q: string) => void;
  clearPending: () => void;
}

export const useAgent = create<AgentState>((set) => ({
  open: false,
  pending: null,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
  ask: (q) => set((s) => ({ open: true, pending: { q, seq: (s.pending?.seq ?? 0) + 1 } })),
  clearPending: () => set({ pending: null }),
}));
