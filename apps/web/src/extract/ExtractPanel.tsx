// Document entity-extraction panel — paste text, an LLM pulls entities +
// relationships into the ontology (POST /api/extract). Preview first (commit=false),
// then commit to the per-user graph. Every committed row carries the chosen
// classification marking; the backend caps it at the caller's clearance.

import { type CSSProperties, useState } from 'react';

import { apiFetch } from '../transport/http.js';
import { LEVELS } from '../security/classification.js';
import { MarkingBadge } from '../security/MarkingBadge.js';

interface ExtractedEntity {
  id: string;
  entity_type: string;
  name: string;
  props: Record<string, unknown>;
}
interface ExtractedLink {
  src: string;
  dst: string;
  rel: string;
}
interface ExtractResponse {
  document_id: string;
  marking: string;
  entities: ExtractedEntity[];
  links: ExtractedLink[];
  committed: boolean;
}

export function ExtractPanel({ situationId }: { situationId?: string }) {
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState(0);
  const [comps, setComps] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);

  async function run(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          title,
          situation_id: situationId ?? null,
          classification: level,
          compartments: comps
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean),
          shared,
          commit,
        }),
      });
      if (!r.ok) {
        const detail = await r.text();
        setError(`${r.status}: ${detail.slice(0, 200)}`);
        return;
      }
      setResult((await r.json()) as ExtractResponse);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontSize: 13 }}>
      <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>Document extraction</div>
      <input
        placeholder="Document title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        style={inputStyle}
      />
      <textarea
        placeholder="Paste report / cable / article text…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          Classify
          <select value={level} onChange={(e) => setLevel(Number(e.target.value))} style={inputStyle}>
            {LEVELS.map((name, i) => (
              <option key={i} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <input
          placeholder="compartments (e.g. FVEY,NOFORN)"
          value={comps}
          onChange={(e) => setComps(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        />
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          share
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={busy || !text.trim()} onClick={() => void run(false)} style={btnStyle}>
          Preview
        </button>
        <button
          disabled={busy || !text.trim()}
          onClick={() => void run(true)}
          style={{ ...btnStyle, fontWeight: 700 }}
        >
          Commit to graph
        </button>
      </div>
      {error && <div style={{ color: '#ef4444' }}>{error}</div>}
      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <MarkingBadge level={level} compartments={comps.split(',').map((c) => c.trim()).filter(Boolean)} />
            <span>
              {result.committed ? 'Committed' : 'Preview'}: {result.entities.length} entities,{' '}
              {result.links.length} links
            </span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {result.entities.map((e) => (
              <li key={e.id}>
                <span style={{ opacity: 0.6 }}>{e.entity_type}</span> {e.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const inputStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 4,
  color: 'inherit',
  padding: '4px 6px',
};
const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 4,
  color: 'inherit',
  padding: '5px 10px',
  cursor: 'pointer',
};
