// Real-time collaborative document over Yjs (CRDT). Binds a shared Y.Doc to the
// /ws/collab relay: local updates fan out to peers, remote updates merge in
// conflict-free, and awareness carries presence (who's online + cursors). The
// doc state is loaded from / snapshotted to /api/collab (RLS clearance-gated).
//
// Wire frames are [tag][payload]: 0x00 = Yjs sync update, 0x01 = awareness,
// 0xFF = server heartbeat (ignored). The server is a dumb relay — see
// apps/api/app/routes/collab.py.

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';

import { apiFetch, backendWsUrl, withWsKey } from '../transport/http.js';

const TAG_SYNC = 0x00;
const TAG_AWARE = 0x01;

export interface CollabPeer {
  clientId: number;
  name?: string | undefined;
  color?: string | undefined;
}

export interface CollabUser {
  name?: string;
  color?: string;
}

function wsBase(): string {
  return backendWsUrl('/').replace(/\/$/, '');
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return btoa(s);
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

export interface CollabOpts {
  classification?: number;
  compartments?: string[];
  user?: CollabUser;
}

export interface CollabHandle {
  doc: Y.Doc;
  peers: CollabPeer[];
  online: boolean;
}

export function useCollabDoc(docId: string | null, opts?: CollabOpts): CollabHandle {
  const [doc] = useState(() => new Y.Doc());
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [online, setOnline] = useState(false);
  const optsRef = useRef<CollabOpts | undefined>(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!docId) return;
    const awareness = new Awareness(doc);
    if (opts?.user) awareness.setLocalStateField('user', opts.user);

    let ws: WebSocket | null = null;
    let closed = false;
    let saveTimer: number | undefined;

    const roster = (): CollabPeer[] =>
      Array.from(awareness.getStates().entries()).map(([clientId, st]) => {
        const user = (st as { user?: CollabUser } | undefined)?.user;
        return { clientId, name: user?.name, color: user?.color };
      });

    const send = (tag: number, payload: Uint8Array) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const frame = new Uint8Array(payload.length + 1);
        frame[0] = tag;
        frame.set(payload, 1);
        ws.send(frame);
      }
    };

    const persist = async () => {
      try {
        await apiFetch(`/api/collab/${encodeURIComponent(docId)}/snapshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: bytesToBase64(Y.encodeStateAsUpdate(doc)),
            classification: optsRef.current?.classification ?? 0,
            compartments: optsRef.current?.compartments ?? [],
          }),
        });
      } catch {
        /* best-effort snapshot */
      }
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return; // don't echo merged-in remote updates
      send(TAG_SYNC, update);
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void persist(), 1500);
    };

    const onAwareUpdate = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      setPeers(roster());
      if (origin === 'remote') return;
      const ids = changes.added.concat(changes.updated, changes.removed);
      send(TAG_AWARE, encodeAwarenessUpdate(awareness, ids));
    };

    doc.on('update', onDocUpdate);
    awareness.on('update', onAwareUpdate);

    // Load any persisted snapshot first (RLS hides it if we're not cleared).
    void apiFetch(`/api/collab/${encodeURIComponent(docId)}`).then(async (r) => {
      if (!r.ok) return;
      const j = (await r.json()) as { exists?: boolean; state?: string | null };
      if (j.exists && typeof j.state === 'string') {
        try {
          Y.applyUpdate(doc, base64ToBytes(j.state), 'remote');
        } catch {
          /* ignore corrupt snapshot */
        }
      }
    });

    const connect = () => {
      const sock = new WebSocket(
        withWsKey(`${wsBase()}/ws/collab?doc=${encodeURIComponent(docId)}`),
      );
      sock.binaryType = 'arraybuffer';
      ws = sock;
      sock.onopen = () => {
        setOnline(true);
        send(TAG_SYNC, Y.encodeStateAsUpdate(doc));
        send(TAG_AWARE, encodeAwarenessUpdate(awareness, [doc.clientID]));
      };
      sock.onclose = () => {
        setOnline(false);
        if (!closed) window.setTimeout(connect, 1500);
      };
      sock.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
        const buf = new Uint8Array(ev.data);
        if (buf.length === 0) return;
        const tag = buf[0];
        const payload = buf.subarray(1);
        if (tag === TAG_SYNC) Y.applyUpdate(doc, payload, 'remote');
        else if (tag === TAG_AWARE) applyAwarenessUpdate(awareness, payload, 'remote');
        // 0xFF heartbeat → ignore
      };
    };
    connect();

    return () => {
      closed = true;
      if (saveTimer) window.clearTimeout(saveTimer);
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwareUpdate);
      awareness.destroy();
      ws?.close();
    };
    // doc is stable (useState init); re-subscribe only when the document id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  return { doc, peers, online };
}
