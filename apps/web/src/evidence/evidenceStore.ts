// Evidence locker store — chain-of-custody capture (roadmap P1).
// Backed by /api/evidence (content-addressed ontology objects; SHA-256 at
// ingest, custody on the append-only assertions table). Works keyless: none of
// these routes is a compute path, so a bare `docker compose up` can preserve
// evidence without ALLOW_UNAUTHENTICATED.

import { create } from 'zustand';
import { apiFetch } from '../transport/http.js';

export interface EvidenceProps {
  kind: 'evidence';
  sha256: string;
  size_bytes: number;
  media_type: string;
  capture_method: 'url' | 'file_upload' | 'screenshot' | 'feed_freeze';
  source_url?: string | null;
  source_context?: string | null;
  filename?: string | null;
  title?: string | null;
  captured_by?: string;
  captured_at?: string;
  http_status?: number;
  final_url?: string;
  entity_id?: string;
  [k: string]: unknown;
}

export interface EvidenceObject {
  id: string;
  kind: string;
  props: EvidenceProps;
  created_at?: string;
}

export interface CustodyEvent {
  action: string;
  at?: string;
  by?: string;
  method?: string;
  sha256?: string;
  source_url?: string | null;
  context?: string | null;
  situation_id?: string;
  rel?: string;
  note?: string | null;
  [k: string]: unknown;
}

interface EvidenceState {
  items: EvidenceObject[];
  loading: boolean;
  error: string | null;
  busy: boolean; // a capture/attach is in flight
  load: () => Promise<void>;
  captureUrl: (url: string, context?: string, situationId?: string) => Promise<EvidenceObject | null>;
  upload: (file: File, context?: string, title?: string, situationId?: string) => Promise<EvidenceObject | null>;
  captureScreenshot: (
    dataBase64: string,
    title?: string,
    context?: string,
    situationId?: string,
  ) => Promise<EvidenceObject | null>;
  captureFeedFreeze: (
    entityId: string,
    snapshot: Record<string, unknown>,
    context?: string,
    situationId?: string,
  ) => Promise<EvidenceObject | null>;
  attach: (sha: string, situationId: string, note?: string) => Promise<boolean>;
  verify: (sha: string) => Promise<boolean>;
  detail: (sha: string) => Promise<{ object: EvidenceObject; custody: CustodyEvent[]; blob_present: boolean } | null>;
}

async function insertFront(
  set: (fn: (s: EvidenceState) => Partial<EvidenceState>) => void,
  obj: EvidenceObject | null,
): Promise<void> {
  if (!obj) return;
  set((s) => ({
    items: [obj, ...s.items.filter((x) => x.id !== obj.id)],
  }));
}

export const useEvidence = create<EvidenceState>((set) => ({
  items: [],
  loading: false,
  error: null,
  busy: false,
  load: async () => {
    set({ loading: true });
    try {
      const r = await apiFetch('/api/evidence');
      if (r.ok) set({ items: (await r.json()) as EvidenceObject[], error: null });
      else set({ error: `load failed (${r.status})` });
    } catch {
      set({ error: 'offline — could not load evidence' });
    } finally {
      set({ loading: false });
    }
  },
  captureUrl: async (url, context, situationId) => {
    set({ busy: true, error: null });
    try {
      const r = await apiFetch('/api/evidence/capture/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, context: context || null, situation_id: situationId || null }),
      });
      if (!r.ok) {
        set({ error: `capture failed (${r.status})` });
        return null;
      }
      const obj = (await r.json()) as EvidenceObject;
      await insertFront(set, obj);
      return obj;
    } catch {
      set({ error: 'capture failed (network)' });
      return null;
    } finally {
      set({ busy: false });
    }
  },
  upload: async (file, context, title, situationId) => {
    set({ busy: true, error: null });
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (context) fd.append('context', context);
      if (title) fd.append('title', title);
      if (situationId) fd.append('situation_id', situationId);
      const r = await apiFetch('/api/evidence/upload', { method: 'POST', body: fd });
      if (!r.ok) {
        set({ error: `upload failed (${r.status})` });
        return null;
      }
      const obj = (await r.json()) as EvidenceObject;
      await insertFront(set, obj);
      return obj;
    } catch {
      set({ error: 'upload failed (network)' });
      return null;
    } finally {
      set({ busy: false });
    }
  },
  captureScreenshot: async (dataBase64, title, context, situationId) => {
    set({ busy: true, error: null });
    try {
      const r = await apiFetch('/api/evidence/capture/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_base64: dataBase64,
          title: title || null,
          context: context || null,
          situation_id: situationId || null,
        }),
      });
      if (!r.ok) {
        set({ error: `screenshot capture failed (${r.status})` });
        return null;
      }
      const obj = (await r.json()) as EvidenceObject;
      await insertFront(set, obj);
      return obj;
    } catch {
      set({ error: 'screenshot capture failed (network)' });
      return null;
    } finally {
      set({ busy: false });
    }
  },
  captureFeedFreeze: async (entityId, snapshot, context, situationId) => {
    set({ busy: true, error: null });
    try {
      const r = await apiFetch('/api/evidence/capture/feed-freeze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_id: entityId,
          snapshot,
          context: context || null,
          situation_id: situationId || null,
        }),
      });
      if (!r.ok) {
        set({ error: `freeze failed (${r.status})` });
        return null;
      }
      const obj = (await r.json()) as EvidenceObject;
      await insertFront(set, obj);
      return obj;
    } catch {
      set({ error: 'freeze failed (network)' });
      return null;
    } finally {
      set({ busy: false });
    }
  },
  attach: async (sha, situationId, note) => {
    try {
      const r = await apiFetch(`/api/evidence/${encodeURIComponent(sha)}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ situation_id: situationId, note: note || null }),
      });
      if (!r.ok) {
        set({ error: `attach failed (${r.status})` });
        return false;
      }
      return true;
    } catch {
      set({ error: 'attach failed (network)' });
      return false;
    }
  },
  verify: async (sha) => {
    try {
      const r = await apiFetch(`/api/evidence/${encodeURIComponent(sha)}/verify`);
      if (!r.ok) return false;
      const j = (await r.json()) as { ok: boolean };
      return Boolean(j.ok);
    } catch {
      return false;
    }
  },
  detail: async (sha) => {
    try {
      const r = await apiFetch(`/api/evidence/${encodeURIComponent(sha)}`);
      if (!r.ok) return null;
      return (await r.json()) as {
        object: EvidenceObject;
        custody: CustodyEvent[];
        blob_present: boolean;
      };
    } catch {
      return null;
    }
  },
}));
