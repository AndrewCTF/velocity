import { create } from 'zustand';

// Open state for the ⌘K command palette (command-bar/Omnibar).
//
// It used to be `useState` inside Omnibar, reachable only by the keystroke its
// own window listener owned. Nothing else in the app could open it — including
// the File menu, whose whole job is to name the commands a keystroke hides.
// A palette only a shortcut can reach is the "reachable but invisible" finding
// applied to the one surface meant to fix it.

interface PaletteState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const usePalette = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
