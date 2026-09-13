// Positionless-identifier entry point for the digital-OSINT layer. The omnibox /
// ExplorerApp / globe are all location-first (mandatory lon/lat, camera fly-to),
// so a domain / IP has no home there. This flyout takes a target, runs the
// keyless investigate fan-out (POST /api/osint/investigate — DNS/WHOIS/certs/
// IP/Shodan/threat minted into the ontology), then centres the existing
// InvestigationCanvas on the new root via the shared investigation store.
//
// The Pivots list under it is the other half, added in the 2026-08-29 wave from
// OSINT Techniques 11th ed.: the places a human has to open by hand because
// they are captcha'd, paywalled or JS-only. Nothing is fetched to build it, so
// it answers for selectors the fan-out cannot touch at all (a phone number) as
// readily as for the ones it can.

import { type CSSProperties, useEffect, useState } from 'react';
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

interface PivotLink {
  id: string;
  name: string;
  url: string;
  note?: string;
}

interface PivotGroup {
  category: string;
  links: PivotLink[];
}

interface PivotResult {
  target: string;
  kind: string;
  groups: PivotGroup[];
  count: number;
}

/** The selectors the caller has to name, because a bare string cannot be
 *  classified into them. `null` means let the backend detect the kind. */
type Mode = null | 'company' | 'person' | 'phone';

const MODES: { readonly id: Exclude<Mode, null>; readonly label: string; readonly title: string }[] = [
  {
    id: 'company',
    label: 'Company',
    title: 'Search a free-text company or org name (SEC, sanctions, registries, ownership) instead of classifying the target',
  },
  {
    id: 'person',
    label: 'Person',
    title: 'Search a free-text person name (sanctions, LittleSis affiliations, Aleph, Wikidata) instead of classifying the target',
  },
  {
    id: 'phone',
    label: 'Phone',
    title: 'A telephone number. No keyless source returns data for one, so this is pivot links only',
  },
];

export function InvestigatePanel(): JSX.Element {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvestigateResult | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [pivots, setPivots] = useState<PivotResult | null>(null);

  const [tool, setTool] = useState('amass');

  // Phone is the one mode with no fan-out: every source in the book's phone
  // chapter is captcha'd, so minting an empty node would be a lie. The pivot
  // list below is the whole answer, and Run says so by being off.
  const runnable = mode !== 'phone';

  // Pivots are pure string formatting server-side, so this can follow the box
  // as it is typed. Debounced only to keep the request count sane.
  useEffect(() => {
    const t = target.trim();
    if (!t) {
      setPivots(null);
      return;
    }
    const aborter = new AbortController();
    const timer = setTimeout(() => {
      const kindArg = mode ? `&kind=${mode}` : '';
      apiFetch(`/api/osint/pivots?target=${encodeURIComponent(t)}${kindArg}`, {
        signal: aborter.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<PivotResult>) : null))
        .then(setPivots)
        .catch(() => undefined);
    }, 350);
    return () => {
      clearTimeout(timer);
      aborter.abort();
    };
  }, [target, mode]);

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
      mode && mode !== 'phone'
        ? { target: target.trim(), kind: mode }
        : { target: target.trim() },
    );
  const runRecon = () => post('/api/osint/recon', { target: target.trim(), tool });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, fontSize: 13 }}>
      <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>Investigate</div>
      <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
        Domain / IP: DNS · WHOIS · certs · subdomains · ASN/BGP · Tor/C2 threat feeds. Email /
        username: Gravatar · GitHub/GitLab · handle presence · breaches · reputation · Reddit
        history · infostealer logs. Also: url · file hash · btc/eth wallet · ASN. Toggle Company
        or Person for a free-text org or name search, Phone for pivot links.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder="example.com · 8.8.8.8 · jane@example.com · torvalds · AS15169 · 618-462-0000"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && runnable) void run();
          }}
          style={{ ...inputStyle, flex: 1 }}
        />
        <button disabled={busy || !target.trim() || !runnable} onClick={() => void run()} style={btnStyle}>
          {busy ? '…' : 'Run'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={mode === m.id}
            title={m.title}
            onClick={() => setMode((v) => (v === m.id ? null : m.id))}
            style={{ ...btnStyle, background: mode === m.id ? 'var(--accent)' : btnStyle.background }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === 'company' && (
        <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
          Company mode: searches SEC EDGAR, OpenSanctions, OpenCorporates, OpenOwnership, Aleph,
          Wikidata by name: mints an <code>org</code> node with officers/sanctions linked in.
        </div>
      )}
      {mode === 'person' && (
        <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
          Person mode: searches OpenSanctions, LittleSis, Aleph and Wikidata by name: mints a{' '}
          <code>person</code> node with sanctions and affiliations linked in. An exact name match
          is required before LittleSis ties are adopted, so a namesake's network is not attributed
          here.
        </div>
      )}
      {mode === 'phone' && (
        <div style={{ fontSize: 11, color: 'var(--txt-3)' }}>
          Phone mode is pivot links only. No keyless source answers for a number, so nothing is
          fetched and nothing is minted: open the lookups below by hand.
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
          {typeof result.summary?.['littlesis_matches'] === 'number' && (
            <div>LittleSis matches: {String(result.summary['littlesis_matches'])}</div>
          )}
          {typeof result.summary?.['affiliates'] === 'number' && (
            <div>Affiliations linked: {String(result.summary['affiliates'])}</div>
          )}
          {typeof result.summary?.['officers'] === 'number' && (
            <div>Officers found: {String(result.summary['officers'])}</div>
          )}
          {/* A 0 next to stealer_checked true reads "checked, clean", which is
              a finding. Hiding it would make clean and unchecked look alike. */}
          {result.summary?.['stealer_checked'] === true && (
            <div
              style={
                (result.summary['stealer_machines'] as number) > 0 ||
                (result.summary['stealer_credentials'] as number) > 0
                  ? { color: 'var(--alert)' }
                  : undefined
              }
            >
              Infostealer logs:{' '}
              {typeof result.summary['stealer_credentials'] === 'number'
                ? `${String(result.summary['stealer_credentials'])} credentials`
                : `${String(result.summary['stealer_machines'] ?? 0)} machines`}
            </div>
          )}
        </div>
      )}
      {pivots && pivots.count > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
          <div style={{ fontSize: 11, color: 'var(--txt-2)', fontWeight: 600 }}>
            Pivots · {pivots.kind} · {pivots.count} lookups
          </div>
          <div style={{ fontSize: 10, color: 'var(--txt-3)' }}>
            Opened by hand. These sources cannot be fetched: captcha, paywall or JavaScript.
          </div>
          {pivots.groups.map((g) => (
            <div key={g.category}>
              <div style={{ fontSize: 10, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>
                {g.category}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                {g.links.map((l) => (
                  <a
                    key={l.id}
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={l.note ?? l.url}
                    style={pivotStyle}
                  >
                    {l.name}
                  </a>
                ))}
              </div>
            </div>
          ))}
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

const pivotStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 3,
  color: 'var(--txt-2)',
  padding: '2px 6px',
  fontSize: 11,
  textDecoration: 'none',
};
