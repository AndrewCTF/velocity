// Target lifecycle board (F2T2EA Kanban) store.
//
// Holds the working set of targeted entities and the stage each sits in. It is
// IN-MEMORY FIRST: every mutation updates local state immediately (optimistic),
// then best-effort mirrors to the per-user Supabase board via apiFetch. When the
// request is rejected — 401 (no signed-in user, the keyless-local case), 503
// (Supabase unconfigured), or any unreachable/error — the local state simply
// stands; the board stays fully usable for keyless local dev, like the other
// stores in this app hold UI state without a round-trip.

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

// The kill-chain stages, in board order. MUST match the backend STAGES tuple in
// apps/api/app/routes/targets.py.
export const TARGET_STAGES = [
  'confirm',
  'attach_intel',
  'approvals',
  'weaponeer',
  'execute',
  'assess',
  'complete',
] as const;

export type TargetStage = (typeof TARGET_STAGES)[number];

export function isTargetStage(s: string): s is TargetStage {
  return (TARGET_STAGES as readonly string[]).includes(s);
}

// F2T2EA confirmation checklist — MUST match apps/api/app/routes/targets.py
// (REQUIREMENT_KEYS + STAGE_REQUIREMENTS) so the in-memory gate and the server
// gate agree. A stage may not be entered until its gating requirements are met.
export const REQUIREMENT_KEYS = [
  'target_identity',
  'location_verified',
  'collateral_estimate',
  'authority_signoff',
] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export const REQUIREMENT_LABEL: Record<RequirementKey, string> = {
  target_identity: 'Target identity confirmed',
  location_verified: 'Location verified',
  collateral_estimate: 'Collateral estimate',
  authority_signoff: 'Authority sign-off',
};

const STAGE_REQUIREMENTS: Partial<Record<TargetStage, RequirementKey[]>> = {
  approvals: ['target_identity', 'location_verified'],
  weaponeer: ['target_identity', 'location_verified'],
  execute: ['target_identity', 'location_verified', 'collateral_estimate', 'authority_signoff'],
};

export function nextStage(stage: TargetStage): TargetStage | null {
  const i = TARGET_STAGES.indexOf(stage);
  return i >= 0 && i + 1 < TARGET_STAGES.length ? TARGET_STAGES[i + 1]! : null;
}

// Requirement keys still unmet to ENTER `stage`, in order.
export function unmetFor(stage: TargetStage, requirements: Record<string, boolean>): RequirementKey[] {
  return (STAGE_REQUIREMENTS[stage] ?? []).filter((k) => !requirements[k]);
}

// Locked = advancing to the NEXT stage is currently blocked. Drives the badge +
// drag refusal (mirrors the backend `locked`).
export function isLocked(stage: TargetStage, requirements: Record<string, boolean>): boolean {
  const nxt = nextStage(stage);
  return nxt != null && unmetFor(nxt, requirements).length > 0;
}

function emptyRequirements(): Record<string, boolean> {
  return Object.fromEntries(REQUIREMENT_KEYS.map((k) => [k, false]));
}

export interface TargetEntry {
  // Local id. When persisted, this is replaced by the Supabase row id so a
  // later PATCH/DELETE addresses the right row; until then it's a client uid.
  id: string;
  entityId: string;
  stage: TargetStage;
  priority: number; // 1..5, 1 = highest
  note: string;
  // F2T2EA confirmation checklist (requirement key → met) + per-target caveat.
  requirements: Record<string, boolean>;
  classification: string;
  // Selected weaponeering solution — a catalog system id (sim/catalog.ts). Local
  // (in-memory) for now; not yet a persisted column.
  weaponeering?: string;
  // Display hints captured at add-time from the live entity, so a card can
  // render an icon + label even when the entity scrolls out of the viewport.
  label?: string;
  kind?: string;
}

// Server row shape (apps/api/app/routes/targets.py → Target).
interface ServerTarget {
  id: string;
  entity_id: string;
  stage: string;
  priority: number;
  note?: string;
  requirements?: Record<string, boolean>;
  classification?: string;
  locked?: boolean;
}

interface TargetBoardState {
  entries: TargetEntry[];
  loaded: boolean;
  // Add the entity to the board (dedup by entityId). Optimistic + mirrored.
  add: (entityId: string, opts?: { label?: string; kind?: string; stage?: TargetStage; priority?: number }) => void;
  // Move an entity to a new stage. Refused (returns false) when advancing into a
  // stage whose checklist is unmet, UNLESS `force` (audited override). Same-stage
  // / legal moves return true.
  move: (entityId: string, stage: TargetStage, force?: boolean) => boolean;
  // Re-prioritise an entry (1..5).
  setPriority: (entityId: string, priority: number) => void;
  // Toggle one confirmation-checklist requirement (optimistic + mirrored).
  toggleRequirement: (entityId: string, key: RequirementKey) => void;
  // Set the per-target classification caveat.
  setClassification: (entityId: string, classification: string) => void;
  // Select a weaponeering solution (catalog system id). In-memory for now.
  setWeaponeering: (entityId: string, systemId: string) => void;
  // Remove an entity from the board.
  remove: (entityId: string) => void;
  // Hydrate from the per-user Supabase board. No-op-safe on 503/error.
  load: () => Promise<void>;
}

function uid(): string {
  return `tb_${Math.random().toString(36).slice(2, 10)}`;
}

const clampPriority = (p: number): number => Math.min(5, Math.max(1, Math.round(p)));

export const useTargetBoard = create<TargetBoardState>((set, get) => {
  // Fire-and-forget persistence helpers. They NEVER throw into the caller and
  // NEVER block the optimistic UI update — a failed save just leaves the row
  // local-only (works without Supabase). On a successful create we reconcile
  // the local uid to the server id so subsequent PATCH/DELETE hit the row.
  const persistCreate = (entry: TargetEntry): void => {
    void apiFetch('/api/targets/board', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_id: entry.entityId,
        stage: entry.stage,
        priority: entry.priority,
        note: entry.note,
        requirements: entry.requirements,
        classification: entry.classification,
      }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<ServerTarget>) : null))
      .then((srv) => {
        if (!srv) return;
        set((s) => ({
          entries: s.entries.map((e) =>
            e.entityId === entry.entityId ? { ...e, id: srv.id } : e,
          ),
        }));
      })
      .catch(() => undefined);
  };

  const persistPatch = (id: string, patch: Record<string, unknown>): void => {
    // Only persist rows that have a server id (created locally-only rows have a
    // tb_ uid and will be created, not patched).
    if (id.startsWith('tb_')) return;
    void apiFetch(`/api/targets/board/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => undefined);
  };

  const persistDelete = (id: string): void => {
    if (id.startsWith('tb_')) return;
    void apiFetch(`/api/targets/board/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  };

  return {
    entries: [],
    loaded: false,

    add: (entityId, opts = {}) => {
      const existing = get().entries.find((e) => e.entityId === entityId);
      if (existing) return; // dedup by entity — never duplicate a track
      const entry: TargetEntry = {
        id: uid(),
        entityId,
        stage: opts.stage ?? 'confirm',
        priority: clampPriority(opts.priority ?? 3),
        note: '',
        requirements: emptyRequirements(),
        classification: 'UNCLAS//FOUO',
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.kind ? { kind: opts.kind } : {}),
      };
      set((s) => ({ entries: [entry, ...s.entries] }));
      persistCreate(entry);
    },

    move: (entityId, stage, force = false) => {
      const entry = get().entries.find((e) => e.entityId === entityId);
      if (!entry) return false;
      if (entry.stage === stage) return true; // no-op
      // Gate forward moves on the checklist (matches the backend 409). A step
      // back or a legal move with met requirements passes; `force` overrides.
      const advancing = TARGET_STAGES.indexOf(stage) > TARGET_STAGES.indexOf(entry.stage);
      if (advancing && !force && unmetFor(stage, entry.requirements).length > 0) {
        return false; // refused — caller surfaces "checklist incomplete"
      }
      set((s) => ({
        entries: s.entries.map((e) => (e.entityId === entityId ? { ...e, stage } : e)),
      }));
      persistPatch(entry.id, force ? { stage, force: true } : { stage });
      return true;
    },

    toggleRequirement: (entityId, key) => {
      const entry = get().entries.find((e) => e.entityId === entityId);
      if (!entry) return;
      const requirements = { ...entry.requirements, [key]: !entry.requirements[key] };
      set((s) => ({
        entries: s.entries.map((e) => (e.entityId === entityId ? { ...e, requirements } : e)),
      }));
      persistPatch(entry.id, { requirements });
    },

    setClassification: (entityId, classification) => {
      const entry = get().entries.find((e) => e.entityId === entityId);
      if (!entry || entry.classification === classification) return;
      set((s) => ({
        entries: s.entries.map((e) => (e.entityId === entityId ? { ...e, classification } : e)),
      }));
      persistPatch(entry.id, { classification });
    },

    setWeaponeering: (entityId, systemId) => {
      // In-memory only (no persisted column yet) — selection survives the session
      // and drives the Weaponeer tab; it is not mirrored to Supabase.
      set((s) => ({
        entries: s.entries.map((e) => (e.entityId === entityId ? { ...e, weaponeering: systemId } : e)),
      }));
    },

    setPriority: (entityId, priority) => {
      const p = clampPriority(priority);
      const entry = get().entries.find((e) => e.entityId === entityId);
      if (!entry || entry.priority === p) return;
      set((s) => ({
        entries: s.entries.map((e) => (e.entityId === entityId ? { ...e, priority: p } : e)),
      }));
      persistPatch(entry.id, { priority: p });
    },

    remove: (entityId) => {
      const entry = get().entries.find((e) => e.entityId === entityId);
      if (!entry) return;
      set((s) => ({ entries: s.entries.filter((e) => e.entityId !== entityId) }));
      persistDelete(entry.id);
    },

    load: async () => {
      try {
        const r = await apiFetch('/api/targets/board');
        if (!r.ok) return; // 401/503/502 → stay local
        const rows = (await r.json()) as ServerTarget[];
        if (!Array.isArray(rows)) return;
        const server: TargetEntry[] = rows.map((row) => ({
          id: row.id,
          entityId: row.entity_id,
          stage: isTargetStage(row.stage) ? row.stage : 'confirm',
          priority: clampPriority(row.priority ?? 3),
          note: row.note ?? '',
          requirements: { ...emptyRequirements(), ...(row.requirements ?? {}) },
          classification: row.classification ?? 'UNCLAS//FOUO',
        }));
        // Merge: server rows win on identity, but keep any local-only entries
        // (tb_ uid) the user added before this hydrate completed.
        set((s) => {
          const serverIds = new Set(server.map((e) => e.entityId));
          const localOnly = s.entries.filter(
            (e) => e.id.startsWith('tb_') && !serverIds.has(e.entityId),
          );
          // Preserve captured display hints (label/kind) from the local copy,
          // which the server row doesn't carry.
          const hinted = server.map((e) => {
            const prev = s.entries.find((p) => p.entityId === e.entityId);
            return prev?.label || prev?.kind
              ? {
                  ...e,
                  ...(prev?.label ? { label: prev.label } : {}),
                  ...(prev?.kind ? { kind: prev.kind } : {}),
                }
              : e;
          });
          return { entries: [...localOnly, ...hinted], loaded: true };
        });
      } catch {
        /* unreachable backend → stay local */
      }
    },
  };
});

if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __useTargetBoard: typeof useTargetBoard }).__useTargetBoard =
    useTargetBoard;
}
