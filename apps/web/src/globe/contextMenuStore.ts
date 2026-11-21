import { create } from "zustand";

// Map right-click context-menu state. GlobeCanvas opens it at the screen point +
// the picked ground lat/lon; ContextMenu renders the action list.

export type CmenuMode = "point" | "area";

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  lat: number;
  lon: number;
  mode: CmenuMode;
  openAt: (x: number, y: number, lat: number, lon: number, mode?: CmenuMode) => void;
  close: () => void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  lat: 0,
  lon: 0,
  mode: "point",
  openAt: (x, y, lat, lon, mode = "point") => set({ open: true, x, y, lat, lon, mode }),
  close: () => set({ open: false }),
}));

// DEV-only handle so an e2e harness can open the menu without synthesising a
// Cesium right-click (Cesium's ScreenSpaceEventHandler ignores synthetic input).
if (typeof window !== "undefined" && import.meta.env?.DEV) {
  (
    window as unknown as { __useContextMenu: typeof useContextMenu }
  ).__useContextMenu = useContextMenu;
}
