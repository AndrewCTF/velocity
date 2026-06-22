// Pattern-of-life replay intent — the small shared contract between the producer
// (EntityPanel "Pattern of life" button) and the consumer (Timeline, which owns
// the HistoryPlayback controller). Mirrors investigationStore: producer and
// consumer live in sibling subtrees, so a tiny store decouples them. `seq` is a
// monotonic counter so re-playing the SAME entity still re-triggers.

import { create } from 'zustand';

interface PolReplayState {
  targetId: string | null;
  windowSec: number;
  seq: number;
  play: (id: string, windowSec?: number) => void;
  stop: () => void;
}

export const usePolReplay = create<PolReplayState>((set) => ({
  targetId: null,
  windowSec: 6 * 3600, // default 6 h pattern-of-life window
  seq: 0,
  play: (id, windowSec) =>
    set((s) => ({ targetId: id, windowSec: windowSec ?? s.windowSec, seq: s.seq + 1 })),
  stop: () => set((s) => ({ targetId: null, seq: s.seq + 1 })),
}));
