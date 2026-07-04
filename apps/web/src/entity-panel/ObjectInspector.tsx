import { useEffect, useMemo, useState } from 'react';
import * as Cesium from 'cesium';
import { useSelection } from '../state/stores.js';
import { EntityPanel } from './EntityPanel.js';
import { tracks } from '../intel/tracks.js';
import { apiFetch } from '../transport/http.js';

// Object inspector (design §6.3) — a tabbed ObjectCard over the selected object.
// OVERVIEW reuses the rich EntityPanel (profile/kinematics/ACARS/actions) unchanged;
// PROPERTIES adds the full property table with record-level provenance (source feed +
// last-seen); HISTORY shows the object's observed track. Selecting a new object resets
// to Overview. When nothing is selected, EntityPanel owns the empty state.
//
// ponytail: wraps EntityPanel rather than decomposing its 1,436 LOC — Overview is
// already the right card; the new value is the Properties + History tabs.

type Tab = 'overview' | 'properties' | 'history' | 'dossier';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'properties', label: 'Properties' },
  { id: 'history', label: 'History' },
  { id: 'dossier', label: 'Dossier' },
];

function useEntityProps(
  viewer: Cesium.Viewer | null,
  id: string | null,
): Record<string, unknown> | null {
  const [props, setProps] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!viewer || !id) {
      setProps(null);
      return;
    }
    const read = (): void => {
      if (viewer.isDestroyed()) return;
      for (let i = 0; i < viewer.dataSources.length; i++) {
        const e = viewer.dataSources.get(i).entities.getById(id);
        if (e?.properties) {
          setProps(e.properties.getValue(viewer.clock.currentTime) as Record<string, unknown>);
          return;
        }
      }
      setProps(null);
    };
    read();
    const t = window.setInterval(read, 2000);
    return () => window.clearInterval(t);
  }, [viewer, id]);
  return props;
}

export function ObjectInspector({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const id = useSelection((s) => s.selectedEntityId);
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => setTab('overview'), [id]);

  return (
    <div className="h-full flex flex-col">
      {id && (
        <div className="flex items-stretch shrink-0 border-b border-line-2 bg-bg-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`relative px-3 h-7 font-label uppercase tracking-[0.6px] text-[10px] transition-colors ${
                tab === t.id ? 'text-txt-0' : 'text-txt-3 hover:text-txt-1'
              }`}
            >
              {t.label}
              {tab === t.id && <span className="absolute left-2 right-2 bottom-0 h-[2px] bg-accent" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Overview is always mounted (it owns the empty state + resolves selection). */}
        <div style={{ display: tab === 'overview' || !id ? 'block' : 'none' }}>
          <EntityPanel viewer={viewer} />
        </div>
        {id && tab === 'properties' && <PropertiesTab viewer={viewer} id={id} />}
        {id && tab === 'history' && <HistoryTab id={id} />}
        {id && tab === 'dossier' && <DossierTab id={id} />}
      </div>
    </div>
  );
}

// Dossier (design §8) — the backend intel dossier (/api/intel/dossier/*, keyless):
// fused identity, assessment, last fix, track stats, live-incident links. Exports a
// self-contained HTML dossier (→ Word/PDF via print). "Live-linked": re-fetched per
// selection so it always reflects the current object.
function DossierTab({ id }: { id: string }): JSX.Element {
  const [kind, ident] = id.split(':');
  const [doss, setDoss] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error' | 'unsupported'>('loading');

  useEffect(() => {
    if (kind !== 'aircraft' && kind !== 'vessel') {
      setState('unsupported');
      return;
    }
    let alive = true;
    setState('loading');
    (async () => {
      try {
        const r = await apiFetch(`/api/intel/dossier/${kind}/${encodeURIComponent(ident ?? '')}`, { cache: 'no-store' });
        if (!alive) return;
        if (!r.ok) {
          setState('error');
          return;
        }
        const d = (await r.json()) as Record<string, unknown>;
        setDoss(d);
        setState(d['found'] ? 'ok' : 'error');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, ident]);

  const rows = useMemo(() => {
    if (!doss) return [];
    return Object.entries(doss)
      .filter(([k, v]) => v != null && typeof v !== 'object' && k !== 'found' && k !== 'window_note')
      .map(([k, v]) => [k, String(v)] as [string, string]);
  }, [doss]);

  const exportDossier = (): void => {
    if (!doss) return;
    const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
    const now = new Date().toISOString();
    const kv = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    const inc = Array.isArray(doss['in_incidents']) ? (doss['in_incidents'] as unknown[]).length : 0;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Dossier ${esc(ident ?? id)}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;color:#111;max-width:720px;margin:32px auto;padding:0 16px}
h1{font-size:16px;border-bottom:2px solid #111;padding-bottom:6px}table{width:100%;border-collapse:collapse;font-size:12px}
td{border-bottom:1px solid #ddd;padding:4px 6px}.cls{background:#0c3b1f;color:#86e0a6;text-align:center;font-weight:700;letter-spacing:.1em;padding:4px;text-transform:uppercase;font-size:11px}</style></head>
<body><div class="cls">Unclassified // Open-source intelligence</div>
<h1>Object dossier — ${esc(String(doss['callsign'] ?? doss['identity'] ?? ident ?? id))}</h1>
<p>${esc(kind ?? '')} · generated ${now} · ${inc} live incident link(s)</p>
${doss['assessment'] ? `<p><b>Assessment:</b> ${esc(String(doss['assessment']))}</p>` : ''}
<table>${kv}</table></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dossier-${(ident ?? id).replace(/[^a-z0-9]/gi, '')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (state === 'unsupported')
    return <div className="p-3 mono text-[11px] text-txt-3">Dossiers are available for aircraft + vessels.</div>;
  if (state === 'loading') return <div className="p-3 mono text-[11px] text-txt-3">Compiling dossier…</div>;
  if (state === 'error') return <div className="p-3 mono text-[11px] text-txt-3">No dossier available for this object.</div>;

  return (
    <div className="p-3 text-txt-1">
      <div className="flex items-center justify-between mb-2">
        <span className="font-label uppercase tracking-[0.7px] text-[11px] text-txt-1">Intel dossier</span>
        <button
          type="button"
          onClick={exportDossier}
          className="mono text-[10px] uppercase tracking-[0.4px] px-2 py-0.5 rounded-sm border border-accent-line text-accent bg-accent-dim"
        >
          Export (Word/PDF)
        </button>
      </div>
      {typeof doss?.['assessment'] === 'string' && (
        <p className="text-[11px] text-txt-1 leading-snug mb-2.5 border-l-2 border-accent-line pl-2">
          {String(doss['assessment'])}
        </p>
      )}
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-line/60">
              <td className="mono text-[10px] uppercase tracking-[0.3px] text-txt-3 py-1 pr-2 align-top">{k}</td>
              <td className="mono text-[11px] text-txt-0 py-1 text-right break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PropertiesTab({ viewer, id }: { viewer: Cesium.Viewer | null; id: string }): JSX.Element {
  const props = useEntityProps(viewer, id);
  const rows = useMemo(() => {
    if (!props) return [];
    return Object.entries(props)
      .filter(([, v]) => v != null && typeof v !== 'object')
      .sort(([a], [b]) => a.localeCompare(b));
  }, [props]);

  const source = props?.['source'] ?? props?.['src'];
  const seenAt = typeof props?.['seen_at'] === 'number' ? (props['seen_at'] as number) : null;

  return (
    <div className="p-3 text-txt-1">
      {/* record-level provenance (per-field provenance isn't carried by the merged feeds) */}
      <div className="mb-2.5 rounded-sm border border-line bg-bg-1 px-2.5 py-2">
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1">Provenance</div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-txt-2">source feed</span>
          <span className="mono text-txt-0">{String(source ?? '—')}</span>
        </div>
        {seenAt != null && (
          <div className="flex items-center justify-between text-[11px] mt-0.5">
            <span className="text-txt-2">observation time</span>
            <span className="mono text-txt-0 tabular-nums">{new Date(seenAt * 1000).toISOString().slice(11, 19)}Z</span>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mono text-[11px] text-txt-3">No properties resolved.</p>
      ) : (
        <table className="w-full">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-line/60">
                <td className="mono text-[10px] uppercase tracking-[0.3px] text-txt-3 py-1 pr-2 align-top">{k}</td>
                <td className="mono text-[11px] text-txt-0 py-1 text-right break-all tabular-nums">{formatVal(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function HistoryTab({ id }: { id: string }): JSX.Element {
  // Re-read on a slow tick so the track grows live while History is open.
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, []);
  const pts = tracks.get(id);
  const recent = pts.slice(-60).reverse();

  return (
    <div className="p-3 text-txt-1">
      <div className="mono text-[10px] uppercase tracking-[0.5px] text-txt-3 mb-1.5">
        Observed track · {pts.length} fix{pts.length === 1 ? '' : 'es'}
      </div>
      {recent.length === 0 ? (
        <p className="mono text-[11px] text-txt-3">No track buffered yet — fixes accumulate while selected.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="mono text-[10px] uppercase tracking-[0.3px] text-txt-3">
              <th className="text-left py-1">Time</th>
              <th className="text-right py-1">Lat</th>
              <th className="text-right py-1">Lon</th>
              <th className="text-right py-1">Spd</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((p, i) => (
              <tr key={`${p.t}-${i}`} className="border-t border-line/60">
                <td className="mono text-[11px] text-txt-1 py-1 tabular-nums">{new Date(p.t).toISOString().slice(11, 19)}Z</td>
                <td className="mono text-[11px] text-txt-1 py-1 text-right tabular-nums">{p.lat.toFixed(3)}</td>
                <td className="mono text-[11px] text-txt-1 py-1 text-right tabular-nums">{p.lon.toFixed(3)}</td>
                <td className="mono text-[11px] text-txt-2 py-1 text-right tabular-nums">{p.sog != null ? `${Math.round(p.sog)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatVal(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}
