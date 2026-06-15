import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';

// News intelligence rail — renders the backend debias / fact-check bundle
// (/api/news/analysis). A small multi-step agent on the backend (1) clusters
// headlines into events, (2) debiases + corroborates each, and (3) self-critiques
// so VERIFIED FACTS rest on ≥2 independent outlets while ATTRIBUTED CLAIMS and a
// leader's promise (e.g. "the war will end soon") stay flagged as rhetoric, never
// fact. This panel surfaces that structure with corroboration up front.

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
  agent_steps?: number;
  backend?: string | null;
  source_count?: number;
  article_count?: number;
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

// "3m ago" style relative time from an ISO timestamp.
function relativeTime(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// A confidence chip whose tint tracks the value — green/amber/grey.
function confidenceClass(c: number): string {
  if (c >= 0.66) return 'border-ok/40 text-ok';
  if (c >= 0.33) return 'border-warn/40 text-warn';
  return 'border-line text-txt-2';
}

// Loading skeleton — three faint event cards while the first analysis lands.
function Skeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-2 animate-pulse"
        >
          <div className="h-3 w-2/3 rounded-sm bg-line/60" />
          <div className="h-2 w-full rounded-sm bg-line/40" />
          <div className="h-2 w-4/5 rounded-sm bg-line/40" />
          <div className="h-2 w-1/3 rounded-sm bg-line/30" />
        </div>
      ))}
    </div>
  );
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
  const unavailable = analysis?.method === 'llm unavailable';
  const isAgent = (analysis?.method ?? '').startsWith('agent');

  return (
    <div className="h-full flex flex-col gap-2 px-3 py-2 overflow-y-auto">
      {/* Header — what this is + freshness + how many agent steps produced it */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="micro text-txt-2">debias · corroboration · fact-check</span>
        {analysis && !unavailable && (
          <span className="micro tabular-nums text-txt-3 shrink-0">
            {relativeTime(analysis.generated)}
          </span>
        )}
      </div>
      {analysis && !unavailable && (analysis.agent_steps || analysis.source_count) && (
        <div className="flex flex-wrap items-center gap-1 -mt-1">
          {isAgent && analysis.agent_steps != null && (
            <span className="micro px-1 py-px border border-accent-line text-accent rounded-sm">
              agent · {analysis.agent_steps} step{analysis.agent_steps === 1 ? '' : 's'}
            </span>
          )}
          {analysis.source_count != null && (
            <span className="micro text-txt-3">
              {analysis.source_count} sources · {analysis.article_count ?? 0} headlines
            </span>
          )}
        </div>
      )}

      {/* Fact-check one claim */}
      <div className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="micro text-txt-2">fact-check a claim</span>
          <span className="micro text-txt-3">⏎ to check</span>
        </div>
        <div className="flex gap-1">
          <input
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runFactCheck();
            }}
            placeholder='e.g. "the war will end soon"'
            className="flex-1 min-w-0 mono text-[11px] bg-bg-1 border border-line rounded-sm px-1.5 py-1 text-txt-1 placeholder:text-txt-2/60 focus:outline-none focus:border-accent-line"
          />
          <button
            type="button"
            onClick={() => void runFactCheck()}
            disabled={fcLoading || !claim.trim()}
            className="mono text-[10px] px-2.5 py-1 border border-line rounded-sm hover:border-accent-line hover:text-accent text-txt-1 disabled:opacity-40 disabled:hover:border-line disabled:hover:text-txt-1 transition-colors"
          >
            {fcLoading ? 'checking…' : 'check'}
          </button>
        </div>
        {fcLoading && (
          <div className="h-2 w-1/2 rounded-sm bg-line/40 animate-pulse" aria-hidden />
        )}
        {fc && !fcLoading && (
          <div className="mono text-[11px] leading-snug border-t border-line/60 pt-1.5">
            <div className="flex items-center gap-1.5">
              <span className={`uppercase font-bold tracking-wide ${verdictClass(fc.verdict)}`}>
                {fc.verdict ?? '—'}
              </span>
              {typeof fc.confidence === 'number' && (
                <span
                  className={`micro px-1 py-px border rounded-sm tabular-nums ${confidenceClass(fc.confidence)}`}
                >
                  {(fc.confidence * 100).toFixed(0)}% conf
                </span>
              )}
            </div>
            {fc.reasoning && <p className="text-txt-2 mt-1 leading-snug">{fc.reasoning}</p>}
            {!!fc.supporting_sources?.length && (
              <div className="mt-1 flex flex-wrap gap-1">
                {fc.supporting_sources.map((s, j) => (
                  <span key={j} className="micro px-1 py-px border border-line text-txt-3 rounded-sm">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading && !analysis && <Skeleton />}
      {unavailable && (
        <div className="border border-warn/40 bg-warn-bg rounded-sm p-2 flex flex-col gap-0.5">
          <span className="micro text-warn">model unavailable</span>
          <span className="mono text-[11px] text-txt-2 leading-snug">
            {analysis?.error ?? 'retrying on the next refresh…'}
          </span>
        </div>
      )}
      {!loading && events.length === 0 && !unavailable && (
        <span className="micro text-txt-2">no events yet</span>
      )}

      {events.map((ev, i) => {
        const sc = ev.corroboration?.source_count ?? 0;
        const corroborated = sc >= 2;
        return (
          <div key={i} className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <span className="mono text-[12px] text-txt-0 font-bold leading-snug">{ev.title}</span>
              {typeof ev.confidence === 'number' && (
                <span
                  className={`micro px-1 py-px border rounded-sm tabular-nums shrink-0 ${confidenceClass(ev.confidence)}`}
                >
                  {(ev.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>

            {/* Corroboration up front — the headline trust signal */}
            {ev.corroboration?.source_count != null && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`micro px-1 py-px rounded-sm border ${
                    corroborated ? 'border-ok/40 text-ok' : 'border-warn/40 text-warn'
                  }`}
                >
                  {corroborated ? '✓ corroborated' : 'single source'} · {sc} outlet
                  {sc === 1 ? '' : 's'}
                </span>
                {!!ev.corroboration.sources?.length && (
                  <span className="micro text-txt-3 truncate">
                    {ev.corroboration.sources.join(' · ')}
                  </span>
                )}
              </div>
            )}

            {ev.neutral_summary && (
              <p className="mono text-[11px] text-txt-1 leading-snug">{ev.neutral_summary}</p>
            )}

            {!!ev.verified_facts?.length && (
              <div className="border-l-2 border-ok/50 pl-2">
                <span className="micro text-ok">verified facts · ≥2 sources</span>
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
              <div className="border-l-2 border-warn/50 pl-2">
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
              <div className="border-l-2 border-alert/50 pl-2">
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
                      <span className="text-txt-1">{b.source}</span> — {b.technique}
                      {b.evidence ? <span className="text-txt-3"> · “{b.evidence}”</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!!ev.propaganda_techniques?.length && (
              <div className="flex flex-wrap gap-1">
                {ev.propaganda_techniques.map((p, j) => (
                  <span
                    key={j}
                    className="micro px-1 py-px border border-alert/40 text-alert rounded-sm"
                  >
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer — method line so the operator can see how this was judged */}
      {analysis && !unavailable && analysis.method && (
        <span className="micro text-txt-3 leading-snug pt-0.5">{analysis.method}</span>
      )}
    </div>
  );
}
