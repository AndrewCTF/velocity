// Inbox subscription/triage state (design §6.5). Consolidates the three alert
// surfaces (command-bar ticker, rail list, slide-over) into one model: the live
// alert buffer (useAlerts) PLUS per-alert read/archived state that persists across
// reloads. Alerts themselves come from the real correlation/geofence/pattern
// pipeline (watchbox evaluator, standing detections, detectors.py) via useAlerts.
//
// ponytail: two persisted id-sets + derived counts, not a message queue. The
// "subscriptions" (object watch, geofence AOIs, saved searches) already exist as
// their own stores; the Inbox is the triage surface over what they emit.
import { create } from 'zustand';

const LS_READ = 'velocity.inbox.read';
const LS_ARCH = 'velocity.inbox.archived';

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function persistSet(key: string, s: Set<string>): void {
  try {
    // Bound the persisted set so it can't grow forever across sessions.
    const arr = [...s].slice(-2000);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

interface InboxState {
  read: Set<string>;
  archived: Set<string>;
  markRead: (id: string) => void;
  markManyRead: (ids: string[]) => void;
  archive: (id: string) => void;
  unarchive: (id: string) => void;
  isRead: (id: string) => boolean;
  isArchived: (id: string) => boolean;
}

export const useInbox = create<InboxState>((set, get) => ({
  read: readSet(LS_READ),
  archived: readSet(LS_ARCH),
  markRead: (id) =>
    set((s) => {
      if (s.read.has(id)) return s;
      const read = new Set(s.read).add(id);
      persistSet(LS_READ, read);
      return { read };
    }),
  markManyRead: (ids) =>
    set((s) => {
      const read = new Set(s.read);
      let changed = false;
      for (const id of ids)
        if (!read.has(id)) {
          read.add(id);
          changed = true;
        }
      if (!changed) return s;
      persistSet(LS_READ, read);
      return { read };
    }),
  archive: (id) =>
    set((s) => {
      const archived = new Set(s.archived).add(id);
      const read = new Set(s.read).add(id);
      persistSet(LS_ARCH, archived);
      persistSet(LS_READ, read);
      return { archived, read };
    }),
  unarchive: (id) =>
    set((s) => {
      if (!s.archived.has(id)) return s;
      const archived = new Set(s.archived);
      archived.delete(id);
      persistSet(LS_ARCH, archived);
      return { archived };
    }),
  isRead: (id) => get().read.has(id),
  isArchived: (id) => get().archived.has(id),
}));
