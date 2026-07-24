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
  const [companyMode, setCompanyMode] = useState(false);

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
        // 400 = bad target; 503 = recon sidecar not configured (or, on a
        // configured-but-unauthenticated deployment, the compute-path gate).
        // Investigate/recon degrade to a local identity when keyless, so a
        // 401 here means a real Supabase deployment needs sign-in — no
        // special-cased copy, just the server's own detail.
        setError(
          r.status === 503 && detail.toLowerCase().includes('recon')
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

  const run = () =>
    post(
      '/api/osint/investigate',
      companyMode ? { target: target.trim(), kind: 'company' } : { target: target.trim() },
    );
  const runRecon = () => post('/api/osint/recon', { target: target.trim(), tool });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontSize: 13 }}>
      <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>Investigate</div>
      <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
        Domain / IP: DNS · WHOIS · certs · subdomains · ASN/BGP · Tor/C2 threat feeds. Email /
        username: Gravatar · GitHub/GitLab · handle presence · breaches · reputation · Reddit
        history. Also: url · file hash · btc/eth wallet · ASN. Toggle Company for a
        free-text org/sanctions/registry search.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder="example.com · 8.8.8.8 · jane@example.com · torvalds · http://evil.test/x · AS15169 · 1A1zP…"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button
          type="button"
          aria-pressed={companyMode}
          title="Search a free-text company/org name (SEC, sanctions, registries, ownership) instead of classifying the target"
          onClick={() => setCompanyMode((v) => !v)}
          style={{ ...btnStyle, background: companyMode ? 'var(--accent)' : btnStyle.background }}
        >
          Company
        </button>
        <button disabled={busy || !target.trim()} onClick={() => void run()} style={btnStyle}>
          {busy ? '…' : 'Run'}
        </button>
      </div>
      {companyMode && (
        <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
          Company mode: searches SEC EDGAR, OpenSanctions, OpenCorporates, OpenOwnership, Aleph,
          Wikidata by name: mints an <code>org</code> node with officers/sanctions linked in.
        </div>
      )}
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
          {typeof result.summary?.['cik'] === 'string' && result.summary['cik'] && (
            <div>SEC CIK: {String(result.summary['cik'])}</div>
          )}
          {/* Company screening counts: a 0 is "checked, clean" — the whole point
              of a due-diligence record — so render it as a real zero, not hide it. */}
          {typeof result.summary?.['sanctions_matches'] === 'number' && (
            <div
              style={
                (result.summary['sanctions_matches'] as number) > 0
                  ? { color: 'var(--alert)' }
                  : undefined
              }
            >
              Sanctions matches: {String(result.summary['sanctions_matches'])}
            </div>
          )}
          {typeof result.summary?.['opencorporates_matches'] === 'number' && (
            <div>OpenCorporates matches: {String(result.summary['opencorporates_matches'])}</div>
          )}
          {typeof result.summary?.['aleph_matches'] === 'number' && (
            <div>Aleph matches: {String(result.summary['aleph_matches'])}</div>
          )}
          {typeof result.summary?.['wikidata_matches'] === 'number' && (
            <div>Wikidata matches: {String(result.summary['wikidata_matches'])}</div>
          )}
          {typeof result.summary?.['officers'] === 'number' && (
            <div>Officers found: {String(result.summary['officers'])}</div>
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
