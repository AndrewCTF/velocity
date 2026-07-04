// Positionless-identifier entry point for the digital-OSINT layer. The omnibox /
// ExplorerApp / globe are all location-first (mandatory lon/lat, camera fly-to),
// so a domain / IP has no home there. This flyout takes a target, runs the
// keyless investigate fan-out (POST /api/osint/investigate — DNS/WHOIS/certs/
// IP/Shodan/threat minted into the ontology), then centres the existing
// InvestigationCanvas on the new root via the shared investigation store.

import { type CSSProperties, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { useInvestigation } from '../graph/investigationStore.js';
import { useSelection } from '../state/stores.js';

interface InvestigateResult {
  root: string;
  kind: string;
  objects: number;
  links: number;
  summary: Record<string, unknown>;
}

export function InvestigatePanel(): JSX.Element {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestigateResult | null>(null);

  const [tool, setTool] = useState('amass');

  async function post(path: string, body: Record<string, unknown>) {
    const t = target.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const detail = await r.text();
        // 401 = not signed in (persistence needs a real user); 400 = bad target;
        // 503 = recon sidecar not configured.
        setError(
          r.status === 401
            ? 'Sign in to persist an investigation'
            : r.status === 503
              ? 'Deep recon needs the OSINT_RECON_SIDECAR_URL sidecar running'
              : `${r.status}: ${detail.slice(0, 200)}`,
        );
        return;
      }
      const res = (await r.json()) as InvestigateResult;
      setResult(res);
      // Centre the graph on the new root AND select it (so the Selection tab's
      // OSINT cards populate). searchAround bumps openSeq → App flips to the graph app.
      useSelection.getState().select(res.root);
      useInvestigation.getState().searchAround(res.root);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const run = () => post('/api/osint/investigate', { target: target.trim() });
  const runRecon = () => post('/api/osint/recon', { target: target.trim(), tool });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontSize: 13 }}>
      <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>Investigate infrastructure</div>
      <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
        Enter a domain or IP. Keyless: DNS · WHOIS/RDAP · certificate transparency · IP-geo · Shodan · threat-intel.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder="example.com  or  8.8.8.8"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button disabled={busy || !target.trim()} onClick={() => void run()} style={btnStyle}>
          {busy ? '…' : 'Run'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>Deep recon (GPL sidecar):</span>
        <select value={tool} onChange={(e) => setTool(e.target.value)} style={inputStyle}>
          <option value="amass">Amass</option>
          <option value="theharvester">theHarvester</option>
          <option value="spiderfoot">SpiderFoot</option>
        </select>
        <button disabled={busy || !target.trim()} onClick={() => void runRecon()} style={btnStyle}>
          Recon
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--alert)' }}>{error}</div>}
      {result && (
        <div style={{ fontSize: 11, color: 'var(--txt-2)', lineHeight: 1.5 }}>
          <div style={{ color: 'var(--txt-1)', fontWeight: 600 }}>{result.root}</div>
          {result.objects} objects · {result.links} links minted into the graph.
          {typeof result.summary?.['subdomains'] === 'number' && (
            <div>subdomains found: {String(result.summary['subdomains'])}</div>
          )}
          {typeof result.summary?.['threat_pulses'] === 'number' &&
            (result.summary['threat_pulses'] as number) > 0 && (
              <div style={{ color: 'var(--alert)' }}>
                threat pulses: {String(result.summary['threat_pulses'])}
              </div>
            )}
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
