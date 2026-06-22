// Geofence / watchbox store. Each watchbox is a circular AOI with an enter /
// exit / loiter rule. A client-side evaluator (WatchboxLayer) checks live
// entities against each AOI and pushes a real Alert into useAlerts on a trigger.
// (Server-side rule registration via /api/alerts is plumbed but needs login.)

import { create } from 'zustand';

export type WatchRule = 'enter' | 'exit' | 'loiter';

export interface Watchbox {
  id: string;
  label: string;
  center: { lat: number; lon: number };
  radiusKm: number;
  rule: WatchRule;
}

let _seq = 0;
const uid = (): string => `wb-${Date.now().toString(36)}-${(_seq++).toString(36)}`;

interface WatchboxState {
  watchboxes: Watchbox[];
  add: (w: Omit<Watchbox, 'id'>) => string;
  remove: (id: string) => void;
  clear: () => void;
}

export const useWatchboxes = create<WatchboxState>((set) => ({
  watchboxes: [],
  add: (w) => {
    const id = uid();
    set((s) => ({ watchboxes: [...s.watchboxes, { ...w, id }] }));
    return id;
  },
  remove: (id) => set((s) => ({ watchboxes: s.watchboxes.filter((w) => w.id !== id) })),
  clear: () => set({ watchboxes: [] }),
}));
