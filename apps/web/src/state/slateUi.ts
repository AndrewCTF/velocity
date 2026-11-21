// Persisted slate toggles (issue 106): the ported surfaces in slate/features
// hold their panel/overlay state in plain useState, so a close or a layer
// toggle is gone on the next open. This is the classic console pattern
// (state/settings.ts): one zustand store, one localStorage blob, read on
// boot and written on every set, unknown keys ignored.
import { create } from "zustand";
import type { Page as PdfPage } from "../slate/features/pdf/model.js";
import type { Page as FoundryPage } from "../slate/features/foundry/nav.js";
import type { Step } from "../slate/features/pdf/data.js";

export interface SlateUiPrefs {
  foundryPage: FoundryPage | "workbench";
  pdfPage: PdfPage;
  terminalPanel: "handoff" | "graph" | null;
  slateRight: "selection" | "series";
  gaiaHide: string[];
  timelineOff: string[];
  browserMenu: boolean;
  explorerSteps: Step[];
  explorerProp: string;
  dossierSection: number;
  slidesCurrent: number;
}

const DEFAULTS: SlateUiPrefs = {
  foundryPage: "d187",
  pdfPage: "explorer",
  terminalPanel: null,
  slateRight: "selection",
  gaiaHide: [],
  timelineOff: [],
  browserMenu: true,
  explorerSteps: ["box", "radius", "stationary"],
  explorerProp: "Origin",
  dossierSection: 0,
  slidesCurrent: 1,
};

const LS_KEY = "velocity.slateUiPrefs";
const STEPS: readonly Step[] = ["box", "radius", "stationary", "origin"];

function read(): SlateUiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<SlateUiPrefs>;
    const steps = Array.isArray(p.explorerSteps) ? p.explorerSteps.filter((s): s is Step => STEPS.includes(s)) : null;
    return {
      ...DEFAULTS,
      ...p,
      explorerSteps: steps && steps.length ? steps : DEFAULTS.explorerSteps,
      explorerProp: typeof p.explorerProp === "string" && p.explorerProp ? p.explorerProp : DEFAULTS.explorerProp,
      dossierSection: Number.isFinite(p.dossierSection) ? Math.max(0, Math.floor(p.dossierSection as number)) : DEFAULTS.dossierSection,
      slidesCurrent: Number.isFinite(p.slidesCurrent) ? Math.max(0, Math.floor(p.slidesCurrent as number)) : DEFAULTS.slidesCurrent,
      gaiaHide: Array.isArray(p.gaiaHide) ? p.gaiaHide.filter((s): s is string => typeof s === "string") : DEFAULTS.gaiaHide,
      timelineOff: Array.isArray(p.timelineOff) ? p.timelineOff.filter((s): s is string => typeof s === "string") : DEFAULTS.timelineOff,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(s: SlateUiPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage disabled — in-memory only */
  }
}

interface SlateUiState extends SlateUiPrefs {
  set: <K extends keyof SlateUiPrefs>(key: K, value: SlateUiPrefs[K]) => void;
}

export const useSlateUi = create<SlateUiState>((set, get) => ({
  ...read(),
  set: (key, value) => {
    set({ [key]: value } as Pick<SlateUiState, typeof key>);
    persist(get());
  },
}));
