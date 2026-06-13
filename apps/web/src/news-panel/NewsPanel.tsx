import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// News intelligence rail — renders the backend debias / fact-check bundle
// (/api/news/analysis). The reasoning model separates VERIFIED FACTS
// (corroborated by ≥2 independent outlets) from ATTRIBUTED CLAIMS and rhetoric,
// flags per-source bias + propaganda techniques, and never reports a leader's
// promise (e.g. "the war will end soon") as fact.

interface AttributedClaim {
  who?: string;
  claim?: string;
  status?: string; // unverified | disputed | corroborated
}
interface BiasFlag {
  source?: string;
  technique?: string;
  evidence?: string;
}
interface RhetoricFlag {
  who?: string;
  claim?: string;
  note?: string;
}
interface NewsEvent {
  title?: string;
  neutral_summary?: string;
  corroboration?: { source_count?: number; sources?: string[] };
  verified_facts?: string[];
  attributed_claims?: AttributedClaim[];
  bias_flags?: BiasFlag[];
  propaganda_techniques?: string[];
  rhetoric_flags?: RhetoricFlag[];
  confidence?: number;
}
interface Analysis {
  generated?: string | null;
  events?: NewsEvent[];
  method?: string;
  error?: string;
}
interface FactCheck {
  claim?: string;
  verdict?: string;
  reasoning?: string;
  supporting_sources?: string[];
  confidence?: number;
}

const REFRESH_MS = 60_000;

function statusClass(status?: string): string {
  switch ((status ?? '').toLowerCase()) {
    case 'corroborated':
      return 'text-ok';
    case 'disputed':
      return 'text-warn';
    default:
      return 'text-alert';
  }
}

function verdictClass(verdict?: string): string {
  switch ((verdict ?? '').toLowerCase()) {
    case 'true':
      return 'text-ok';
    case 'false':
      return 'text-alert';
    case 'misleading':
      return 'text-warn';
    default:
      return 'text-txt-2';
  }
}

export function NewsPanel(): JSX.Element {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [claim, setClaim] = useState('');
  const [fc, setFc] = useState<FactCheck | null>(null);
  const [fcLoading, setFcLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/news/analysis');
        if (r.ok && !cancelled) setAnalysis((await r.json()) as Analysis);
      } catch {
        /* swallow — keep the last good analysis */
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const runFactCheck = async (): Promise<void> => {
    const q = claim.trim();
    if (!q) return;
    setFcLoading(true);
    setFc(null);
    try {
      const r = await apiFetch(`/api/news/factcheck?claim=${encodeURIComponent(q)}`);
      if (r.ok) setFc((await r.json()) as FactCheck);
    } catch {
      /* swallow */
    } finally {
      setFcLoading(false);
    }
  };

  const events = analysis?.events ?? [];

  return (
    <div className="h-full flex flex-col gap-2 px-3 py-2 overflow-y-auto">
      {/* Fact-check one claim */}
      <div className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-1.5">
        <span className="micro text-txt-2">fact-check a claim</span>
        <div className="flex gap-1">
          <input
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runFactCheck();
            }}
            placeholder='e.g. "the war will end soon"'
            className="flex-1 mono text-[11px] bg-bg-1 border border-line rounded-sm px-1.5 py-0.5 text-txt-1 placeholder:text-txt-2/60"
          />
          <button
            type="button"
            onClick={() => void runFactCheck()}
            disabled={fcLoading || !claim.trim()}
            className="mono text-[10px] px-2 py-0.5 border border-line rounded-sm hover:border-accent-line text-txt-1 disabled:opacity-40"
          >
            {fcLoading ? '…' : 'check'}
          </button>
        </div>
        {fc && (
          <div className="mono text-[11px] leading-snug">
            <span className={`uppercase font-bold ${verdictClass(fc.verdict)}`}>{fc.verdict ?? '—'}</span>
            {typeof fc.confidence === 'number' && (
              <span className="text-txt-2"> · {(fc.confidence * 100).toFixed(0)}%</span>
            )}
            {fc.reasoning && <div className="text-txt-2 mt-0.5">{fc.reasoning}</div>}
          </div>
        )}
      </div>

      {loading && !analysis && <span className="micro">analyzing world news…</span>}
      {analysis?.method === 'llm unavailable' && (
        <span className="micro text-warn">model unavailable — {analysis.error ?? 'retrying'}</span>
      )}
      {!loading && events.length === 0 && analysis?.method !== 'llm unavailable' && (
        <span className="micro text-txt-2">no events yet</span>
      )}

      {events.map((ev, i) => (
        <div key={i} className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="mono text-[12px] text-txt-0 font-bold leading-snug">{ev.title}</span>
            {typeof ev.confidence === 'number' && (
              <span className="micro tabular-nums text-txt-2 shrink-0">
                {(ev.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {ev.neutral_summary && (
            <p className="mono text-[11px] text-txt-1 leading-snug">{ev.neutral_summary}</p>
          )}
          {ev.corroboration?.source_count != null && (
            <span className="micro text-txt-2">
              corroborated by {ev.corroboration.source_count} source
              {ev.corroboration.source_count === 1 ? '' : 's'}
              {ev.corroboration.sources?.length ? ` · ${ev.corroboration.sources.join(', ')}` : ''}
            </span>
          )}

          {!!ev.verified_facts?.length && (
            <div>
              <span className="micro text-ok">verified facts</span>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {ev.verified_facts.map((f, j) => (
                  <li key={j} className="mono text-[11px] text-txt-1 leading-snug pl-2 -indent-2">
                    · {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!ev.attributed_claims?.length && (
            <div>
              <span className="micro text-warn">attributed claims</span>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {ev.attributed_claims.map((c, j) => (
                  <li key={j} className="mono text-[11px] text-txt-1 leading-snug">
                    <span className="text-txt-2">{c.who}:</span> {c.claim}{' '}
                    <span className={`uppercase ${statusClass(c.status)}`}>[{c.status}]</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!ev.rhetoric_flags?.length && (
            <div>
              <span className="micro text-alert">rhetoric / unfulfilled</span>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {ev.rhetoric_flags.map((r, j) => (
                  <li key={j} className="mono text-[11px] text-txt-1 leading-snug">
                    <span className="text-txt-2">{r.who}:</span> {r.claim}
                    {r.note ? <span className="text-alert"> — {r.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!ev.bias_flags?.length && (
            <div>
              <span className="micro text-txt-2">bias flags</span>
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {ev.bias_flags.map((b, j) => (
                  <li key={j} className="mono text-[10px] text-txt-2 leading-snug">
                    {b.source} — {b.technique}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!ev.propaganda_techniques?.length && (
            <div className="flex flex-wrap gap-1">
              {ev.propaganda_techniques.map((p, j) => (
                <span key={j} className="micro px-1 py-px border border-alert/40 text-alert rounded-sm">
                  {p}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
