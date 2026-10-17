import { create } from "zustand";

// Which bottom sheet the phone layout has up, and the two things outside the
// console that need to reach it: the title bar's search pill and status chip
// open sheets, and notices that live elsewhere in the tree (AppRouter's banners,
// App's open-mode banner) are counted for the chip and drawn into the Notices
// sheet instead of stacking over the map.
//
// Sheet ids are the console's panel ids ("layers", "find", "selection", ...)
// plus "time", "more" and "notices". One sheet at a time, like every phone map.

interface PhoneSheetState {
  open: string | null;
  show: (id: string | null) => void;
  toggle: (id: string) => void;
  /** The desktop map tools (measure, area, draw), shown on a phone only when
   *  asked for from More. They are a rail of 13 buttons; on a 412px map they were
   *  a permanent wall down its right side. */
  tools: boolean;
  setTools: (on: boolean) => void;
  /** Notices currently mounted; the title bar's chip shows the count. */
  notices: number;
  addNotice: () => () => void;
  /** Where a notice draws itself on a phone: the Notices sheet's body. */
  noticeHost: HTMLElement | null;
  setNoticeHost: (el: HTMLElement | null) => void;
  /** The map well, for sheets owned outside the console (Menu, Alerts) to
   *  portal into, so they stack and size like the console's own. */
  mapWell: HTMLElement | null;
  setMapWell: (el: HTMLElement | null) => void;
  /** Height of the open sheet, so the map's buttons can ride above it. */
  sheetPx: number;
  setSheetPx: (px: number) => void;
}

export const usePhoneSheet = create<PhoneSheetState>((set) => ({
  open: null,
  show: (id) => set({ open: id }),
  toggle: (id) => set((s) => ({ open: s.open === id ? null : id })),
  tools: false,
  setTools: (on) => set({ tools: on }),
  notices: 0,
  addNotice: () => {
    set((s) => ({ notices: s.notices + 1 }));
    return () =>
      set((s) => ({
        notices: Math.max(0, s.notices - 1),
        // The last notice dismissed from inside the sheet leaves it empty.
        open: s.open === "notices" && s.notices <= 1 ? null : s.open,
      }));
  },
  noticeHost: null,
  setNoticeHost: (el) => set({ noticeHost: el }),
  mapWell: null,
  setMapWell: (el) => set({ mapWell: el }),
  sheetPx: 0,
  setSheetPx: (px) => set({ sheetPx: px }),
}));
