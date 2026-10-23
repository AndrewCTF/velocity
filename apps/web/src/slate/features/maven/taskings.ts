// Taskings and assessments for watch items on the target board. In memory for
// the session, like the board itself without a signed-in user: the board API
// has no tasking table, so nothing here pretends to be shared or kept. (A
// persisted copy needs its key classified in auth/userData.ts first, so
// sign-out clears it.)

import { create } from "zustand";
import type { Asset, Weights } from "./recommend.js";

export type TaskStatus = "proposed" | "approved" | "rejected" | "executed";

export interface Tasking {
  id: string;
  targetId: string;
  targetLabel: string;
  /** The asset as recommended when the tasking was made. */
  asset: Asset;
  taskType: string;
  security: string;
  plan: string;
  planCount: number;
  startMs: number;
  totMs: number;
  createdMs: number;
  status: TaskStatus;
  decidedMs?: number;
}

export const OUTCOMES = [
  "Class confirmed",
  "Position confirmed",
  "No false positive",
  "AIS correlated",
  "Match",
] as const;
export const CONFIDENCE = [
  "Confirmed (>95%)",
  "Probable (70-95%)",
  "Possible (<70%)",
] as const;
/** Outcomes the reference draws in green (the rest are red tags). */
export const GOOD_OUTCOME = new Set<string>(["No false positive"]);

export interface Assessment {
  key: string;
  outcome: string | null;
  confidence: string | null;
}
export interface LogLine {
  t: number;
  text: string;
}
export interface TargetAssess {
  rows: Assessment[];
  log: LogLine[];
  recollect: boolean;
}

const DEFAULT_ROWS = ["CLS", "POS", "FPA", "COR"];

export const DEFAULT_WEIGHTS: Weights = {
  sensor: 30,
  ttt: 50,
  dist: 10,
  station: 20,
  fuel: 10,
  passes: 10,
};

interface State {
  taskings: Tasking[];
  assess: Record<string, TargetAssess>;
  weights: Weights;
  continuous: boolean;
  starred: string[];
  create: (t: Omit<Tasking, "id" | "createdMs" | "status">) => Tasking;
  decide: (id: string, status: TaskStatus) => void;
  setWeight: (m: keyof Weights, v: number) => void;
  setContinuous: (on: boolean) => void;
  toggleStar: (targetId: string) => void;
  assessOf: (targetId: string) => TargetAssess;
  setRow: (targetId: string, key: string, patch: Partial<Assessment>) => void;
  addRow: (targetId: string, key: string) => void;
  setRecollect: (targetId: string, on: boolean) => void;
}

const empty = (): TargetAssess => ({
  rows: DEFAULT_ROWS.map((key) => ({ key, outcome: null, confidence: null })),
  log: [],
  recollect: false,
});

export const useWatchTaskings = create<State>((set, get) => {
  const put = (fn: (s: State) => Partial<State>): void => set(fn);
  const withAssess = (
    s: State,
    id: string,
    fn: (a: TargetAssess) => TargetAssess,
  ): Partial<State> => ({
    assess: { ...s.assess, [id]: fn(s.assess[id] ?? empty()) },
  });
  return {
    taskings: [],
    assess: {},
    weights: { ...DEFAULT_WEIGHTS },
    continuous: true,
    starred: [],
    create: (t) => {
      const full: Tasking = {
        ...t,
        id: `tk_${Math.random().toString(36).slice(2, 10)}`,
        createdMs: Date.now(),
        status: "proposed",
      };
      put((s) => ({ taskings: [full, ...s.taskings] }));
      return full;
    },
    decide: (id, status) =>
      put((s) => ({
        taskings: s.taskings.map((t) =>
          t.id === id ? { ...t, status, decidedMs: Date.now() } : t,
        ),
      })),
    setWeight: (m, v) =>
      put((s) => ({
        weights: { ...s.weights, [m]: Math.max(0, Math.min(100, v)) },
      })),
    setContinuous: (on) => put(() => ({ continuous: on })),
    toggleStar: (id) =>
      put((s) => ({
        starred: s.starred.includes(id)
          ? s.starred.filter((x) => x !== id)
          : [...s.starred, id],
      })),
    assessOf: (id) => get().assess[id] ?? empty(),
    setRow: (id, key, patch) =>
      put((s) =>
        withAssess(s, id, (a) => ({
          ...a,
          rows: a.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
          log: [
            {
              t: Date.now(),
              text: `${key}: ${patch.outcome ?? patch.confidence ?? "cleared"}`,
            },
            ...a.log,
          ],
        })),
      ),
    addRow: (id, key) =>
      put((s) =>
        withAssess(s, id, (a) =>
          a.rows.some((r) => r.key === key)
            ? a
            : {
                ...a,
                rows: [...a.rows, { key, outcome: null, confidence: null }],
                log: [{ t: Date.now(), text: `Row ${key} added` }, ...a.log],
              },
        ),
      ),
    setRecollect: (id, on) =>
      put((s) =>
        withAssess(s, id, (a) => ({
          ...a,
          recollect: on,
          log: [
            {
              t: Date.now(),
              text: on
                ? "Re-collect recommended"
                : "Re-collect recommendation cleared",
            },
            ...a.log,
          ],
        })),
      ),
  };
});

/** The reference's 10-line tasking message, filled from the tasking. */
export function tenLine(
  t: Tasking,
  grid: string | null,
  totText: string,
): string[] {
  return [
    `1. ${t.asset.label}`,
    `2. ${t.taskType}`,
    `3. No Serial / ${t.targetLabel} / No Link ID`,
    `4. ${grid ?? "No position"}, UNK HAE, UNK MSL,`,
    `5. ${t.asset.label}`,
    "6. N/A",
    "7. N/A",
    "8. N/A",
    "9. N/A",
    `10. Time on Target: ${totText}`,
  ];
}
