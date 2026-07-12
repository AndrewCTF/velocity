// Multi-analyst collaboration panel — a live presence roster + a shared-notes
// field bound to a Yjs text. Two analysts with this panel open on the same doc
// see each other online and watch edits sync in real time (CRDT, conflict-free).
// This is the visible mount of useCollabDoc; the graph co-editing binding lands
// on InvestigationCanvas next.

import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';

import { useCollabDoc } from './useCollabDoc.js';

export function CollabPanel({ docId = 'shared-notes' }: { docId?: string }) {
  const { doc, peers, online } = useCollabDoc(docId, {
    user: { name: 'analyst', color: '#38bdf8' },
  });
  const [text, setText] = useState('');
  const ytextRef = useRef<Y.Text | null>(null);

  useEffect(() => {
    const yt = doc.getText('notes');
    ytextRef.current = yt;
    const sync = () => setText(yt.toString());
    sync();
    yt.observe(sync);
    return () => yt.unobserve(sync);
  }, [doc]);

  // ponytail: replace-whole-text per keystroke — simplest binding that still
  // syncs. Char-level merge (true concurrent typing) is a y-textarea binding,
  // add when two people edit the SAME field at once matters.
  const onChange = (value: string) => {
    const yt = ytextRef.current;
    if (!yt) return;
    doc.transact(() => {
      yt.delete(0, yt.length);
      yt.insert(0, value);
    });
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: online ? 'var(--ok)' : 'var(--alert)',
            display: 'inline-block',
          }}
        />
        <span>
          {online ? 'Live' : 'Offline'} · {peers.length} online
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {peers.map((p) => (
          <span
            key={p.clientId}
            style={{
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 10,
              background: p.color ?? '#334155',
              color: '#fff',
            }}
          >
            {p.name ?? `#${p.clientId}`}
          </span>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        placeholder="Shared notes — edits sync live across analysts…"
        style={{
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          color: 'inherit',
          padding: 8,
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />
    </div>
  );
}
