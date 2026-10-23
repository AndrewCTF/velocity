import { create } from "zustand";

// The map-workspace mode (the reference's Maven map page). The Slate shell
// turns it on while its Data tab is open; the globe then answers an empty-map
// click with the coordinate popover and draws the workspace's map graphics.
export interface CoordPop {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

export const useMaven = create<{
  on: boolean;
  setOn: (v: boolean) => void;
  pop: CoordPop | null;
  setPop: (p: CoordPop | null) => void;
}>((set) => ({
  on: false,
  setOn: (on) => set(on ? { on } : { on, pop: null }),
  pop: null,
  setPop: (pop) => set({ pop }),
}));
