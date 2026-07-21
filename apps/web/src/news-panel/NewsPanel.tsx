import { useEffect, useState } from 'react';
import { apiFetch } from '../transport/http.js';
import { SectionLabel, MicroLabel, Badge, Btn, type BadgeTone } from '../shell/instruments.js';

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
// Second-pass verifier review (apps/api/app/news/verify.py) — only present
// when a story was flagged by exactly one local verifier and repaired. Not
// every analysis event carries this; render is a no-op when absent.
interface BiasReview {
  original?: { title?: string; neutral_summary?: string };
  flags?: unknown;
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
  bias_review?: BiasReview;
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

// Attributed-claim status → badge tone.
function statusTone(status?: string): BadgeTone {
  switch ((status ?? '').toLowerCase()) {
    case 'corroborated':
      return 'ok';
    case 'disputed':
      return 'warn';
    default:
      return 'alert';
  }
}

// Fact-check verdict → badge tone.
function verdictTone(verdict?: string): BadgeTone {
  switch ((verdict ?? '').toLowerCase()) {
    case 'true':
      return 'ok';
    case 'false':
      return 'alert';
    case 'misleading':
      return 'warn';
    default:
      return 'neutral';
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

// A confidence value → badge tone tracking the magnitude.
function confidenceTone(c: number): BadgeTone {
  if (c >= 0.66) return 'ok';
  if (c >= 0.33) return 'warn';
  return 'neutral';
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
    <div className="h-full flex flex-col gap-2.5 px-3 py-2 overflow-y-auto">
      {/* Header — what this is + freshness + how many agent steps produced it */}
      <SectionLabel
        title="debias · corroboration · fact-check"
        {...(analysis && !unavailable ? { count: relativeTime(analysis.generated) } : {})}
      />
      {analysis && !unavailable && (analysis.agent_steps || analysis.source_count) && (
        <div className="flex flex-wrap items-center gap-1.5 -mt-1">
          {isAgent && analysis.agent_steps != null && (
            <Badge tone="accent">
              agent · {analysis.agent_steps} step{analysis.agent_steps === 1 ? '' : 's'}
            </Badge>
          )}
          {analysis.source_count != null && (
            <span className="mono text-[10px] text-txt-3 tabular-nums">
              {analysis.source_count} sources · {analysis.article_count ?? 0} headlines
            </span>
          )}
        </div>
      )}

      {/* Fact-check one claim */}
      <div className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <MicroLabel>fact-check a claim</MicroLabel>
          <MicroLabel>⏎ to check</MicroLabel>
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
          <Btn
            tone="accent"
            onClick={() => void runFactCheck()}
            disabled={fcLoading || !claim.trim()}
          >
            {fcLoading ? 'checking…' : 'check'}
          </Btn>
        </div>
        {fcLoading && (
          <div className="h-2 w-1/2 rounded-sm bg-line/40 animate-pulse" aria-hidden />
        )}
        {fc && !fcLoading && (
          <div className="mono text-[11px] leading-snug border-t border-line/60 pt-1.5">
            <div className="flex items-center gap-1.5">
              <Badge tone={verdictTone(fc.verdict)}>{fc.verdict ?? '—'}</Badge>
              {typeof fc.confidence === 'number' && (
                <Badge tone={confidenceTone(fc.confidence)}>
                  {(fc.confidence * 100).toFixed(0)}% conf
                </Badge>
              )}
            </div>
            {fc.reasoning && <p className="text-txt-2 mt-1.5 leading-snug">{fc.reasoning}</p>}
            {!!fc.supporting_sources?.length && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {fc.supporting_sources.map((s, j) => (
                  <Badge key={j} tone="neutral">
                    {s}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading && !analysis && <Skeleton />}
      {unavailable && (
        <div className="border border-warn/40 bg-warn-bg rounded-sm p-2 flex flex-col gap-1">
          <MicroLabel className="text-warn">model unavailable</MicroLabel>
          <span className="mono text-[11px] text-txt-2 leading-snug">
            {analysis?.error ?? 'retrying on the next refresh…'}
          </span>
        </div>
      )}
      {!loading && events.length === 0 && !unavailable && (
        <MicroLabel>no events yet</MicroLabel>
      )}

      {events.map((ev, i) => {
        const sc = ev.corroboration?.source_count ?? 0;
        const corroborated = sc >= 2;
        return (
          <div key={i} className="border border-line rounded-sm bg-bg-2 p-2 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-2">
              <span className="mono text-[12px] text-txt-0 font-bold leading-snug">{ev.title}</span>
              {typeof ev.confidence === 'number' && (
                <Badge tone={confidenceTone(ev.confidence)} className="shrink-0">
                  {(ev.confidence * 100).toFixed(0)}%
                </Badge>
              )}
            </div>

            {/* Corroboration up front — the headline trust signal */}
            {ev.corroboration?.source_count != null && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone={corroborated ? 'ok' : 'warn'}>
                  {corroborated ? '✓ corroborated' : 'single source'} · {sc} outlet
                  {sc === 1 ? '' : 's'}
                </Badge>
                {!!ev.corroboration.sources?.length && (
                  <span className="mono text-[10px] text-txt-3 truncate">
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
                <MicroLabel className="text-ok">verified facts · ≥2 sources</MicroLabel>
                <ul className="mt-1 flex flex-col gap-0.5">
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
                <MicroLabel className="text-warn">attributed claims</MicroLabel>
                <ul className="mt-1 flex flex-col gap-1">
                  {ev.attributed_claims.map((c, j) => (
                    <li key={j} className="mono text-[11px] text-txt-1 leading-snug flex flex-wrap items-baseline gap-1">
                      <span className="text-txt-2">{c.who}:</span> {c.claim}{' '}
                      <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!!ev.rhetoric_flags?.length && (
              <div className="border-l-2 border-alert/50 pl-2">
                <MicroLabel className="text-alert">rhetoric / unfulfilled</MicroLabel>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {ev.rhetoric_flags.map((r, j) => (
                    <li key={j} className="mono text-[11px] text-txt-1 leading-snug">
                      <span className="text-txt-2">{r.who}:</span> {r.claim}
                      {r.note ? <span className="text-alert"> ({r.note})</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!!ev.bias_flags?.length && (
              <div>
                <MicroLabel>bias flags</MicroLabel>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {ev.bias_flags.map((b, j) => (
                    <li key={j} className="mono text-[10px] text-txt-2 leading-snug">
                      <span className="text-txt-1">{b.source}</span> · {b.technique}
                      {b.evidence ? <span className="text-txt-3"> · “{b.evidence}”</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {ev.bias_review?.original && (
              <div className="border-l-2 border-warn/50 pl-2">
                <MicroLabel className="text-warn">verifier revision</MicroLabel>
                <p className="mono text-[10px] text-txt-3 leading-snug mt-1">
                  Originally: {ev.bias_review.original.title ?? ev.bias_review.original.neutral_summary ?? '—'}
                </p>
              </div>
            )}

            {!!ev.propaganda_techniques?.length && (
              <div className="flex flex-wrap gap-1">
                {ev.propaganda_techniques.map((p, j) => (
                  <Badge key={j} tone="alert">
                    {p}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer — method line so the operator can see how this was judged */}
      {analysis && !unavailable && analysis.method && (
        <span className="mono text-[10px] text-txt-3 leading-snug pt-0.5">{analysis.method}</span>
      )}
    </div>
  );
}
