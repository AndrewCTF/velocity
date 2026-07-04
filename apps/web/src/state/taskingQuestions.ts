// Tasking question queue (design §8 MetaConstellation) — the operator asks a
// question ("can a sensor answer at place X over the next N hours?") and it goes on
// a standing queue. Each entry loads back into the collection planner (TaskingPanel),
// which runs the real SGP4 feasibility pass over the CelesTrak constellation.
//
// ponytail: persisted list of {place, window}; the feasibility engine is the
// existing planner — the queue just holds the questions and re-loads them.
import { create } from 'zustand';

export interface TaskingQuestion {
  id: string;
  label: string;
  lat: number;
  lon: number;
  hours: number;
}

const LS_KEY = 'velocity.taskingQuestions';

function read(): TaskingQuestion[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as TaskingQuestion[]) : [];
  } catch {
    return [];
  }
}
function persist(list: TaskingQuestion[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* ignore */
  }
}

interface State {
  questions: TaskingQuestion[];
  add: (q: Omit<TaskingQuestion, 'id'>) => void;
  remove: (id: string) => void;
}

export const useTaskingQuestions = create<State>((set, get) => ({
  questions: read(),
  add: (q) => {
    const list = get().questions;
    const id = `tq_${list.length}_${q.lat.toFixed(2)}_${q.lon.toFixed(2)}`;
    const next = [{ ...q, id }, ...list.filter((x) => x.id !== id)];
    persist(next);
    set({ questions: next });
  },
  remove: (id) => {
    const next = get().questions.filter((q) => q.id !== id);
    persist(next);
    set({ questions: next });
  },
}));
