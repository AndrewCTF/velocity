import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Cesium from 'cesium';
import { useAlerts, useFeeds } from '../state/stores.js';
import { useAoi } from '../state/aoi.js';
import { useAgent } from '../state/agent.js';
import { apiFetch } from '../transport/http.js';
import { flyToPosition } from '../globe/camera.js';
import { useIsMobile } from '../shell/useIsMobile.js';
import { Badge, Btn, StatusDot, type BadgeTone } from '../shell/instruments.js';

// ── Velocity analyst console (the "AI bar") ─────────────────────────────────
// A real, streaming tool-calling agent. The operator types a prompt; the
// backend runs a genuine loop — seed the fused brief, let the model call live
// intel tools (query_vessels, gps_jamming, locate_emitter, …) step by step,
// then MiniMax-M3 reasons over the gathered evidence — and STREAMS every step
// over SSE so the console renders the loop live, the way Claude Code shows its
// work. Every tool call hits real data; findings fly to real incident centroids.

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface Finding {
  id: string;
  label?: string;
  threat?: string;
  why?: string;
  centroid?: { lon: number; lat: number } | null;
  domains?: string[];
}
interface FinalResult {
  assessment?: string;
  findings?: Finding[];
  recommended_detection?: { rule?: string; scope?: string } | null;
  follow_up?: string[];
  derived?: boolean;
}
interface DoneMeta {
  backend?: string | null;
  model?: string | null;
  usage?: Usage;
  latency_ms?: number;
  incident_count?: number;
  signals_considered?: number;
  scope?: string;
}
// A row in the live trace (a tool call with its result, or a note/thought).
interface TraceRow {
  id: number;
  tool?: string;
  args?: Record<string, unknown>;
  thought?: string;
  summary?: string;
  ms?: number;
  status: 'run' | 'ok';
  note?: string;
  narration?: string;
}

type Phase = 'idle' | 'gathering' | 'synthesizing' | 'done' | 'error';

const SLASH = ['/investigate', '/correlate', '/detect', '/factcheck', '/scene'] as const;

function threatTone(t?: string): BadgeTone {
  const s = (t || '').toLowerCase();
  if (s === 'high' || s === 'critical') return 'alert';
  if (s === 'elevated' || s === 'medium') return 'warn';
  if (s === 'low') return 'accent';
  return 'neutral';
}

function argStr(args?: Record<string, unknown>): string {
  if (!args) return '';
  const parts = Object.entries(args)
    .filter(([k]) => k !== 'scope')
    .map(([k, v]) => `${k}:${typeof v === 'number' ? (v as number).toFixed(2).replace(/\.00$/, '') : v}`);
  return parts.join(' ');
}

export function AgentConsole({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const isMobile = useIsMobile();
  const open = useAgent((s) => s.open);
  const setOpen = useAgent((s) => s.setOpen);
  const pending = useAgent((s) => s.pending);
  const clearPending = useAgent((s) => s.clearPending);

  const alerts = useAlerts((s) => s.alerts);
  const activeAoi = useAoi((s) => s.active);
  const feeds = useFeeds((s) => s.feeds);

  const [q, setQ] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [trace, setTrace] = useState<TraceRow[]>([]);
  const [result, setResult] = useState<FinalResult | null>(null);
  const [meta, setMeta] = useState<DoneMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranQuery, setRanQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastSeq = useRef(0);

  const running = phase === 'gathering' || phase === 'synthesizing';
  const expanded = open || running || result !== null || error !== null;

  // Auto-scroll the trace as it streams.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [trace, result, phase]);

  const handleEvent = (ev: Record<string, unknown>): void => {
    const type = ev['type'] as string;
    switch (type) {
      case 'start':
        setRanQuery(String(ev['query'] ?? ''));
        setPhase('gathering');
        break;
      case 'tool_call':
        setTrace((t) => {
          const row: TraceRow = { id: Number(ev['step'] ?? t.length), tool: String(ev['tool'] ?? ''), status: 'run' };
          if (ev['args']) row.args = ev['args'] as Record<string, unknown>;
          if (ev['thought']) row.thought = String(ev['thought']);
          return [...t, row];
        });
        break;
      case 'tool_result':
        setTrace((t) =>
          t.map((r) =>
            r.id === Number(ev['step']) && r.tool === ev['tool'] && r.status === 'run'
              ? { ...r, status: 'ok', summary: String(ev['summary'] ?? ''), ms: Number(ev['ms'] ?? 0) }
              : r,
          ),
        );
        break;
      case 'note':
        setTrace((t) => [...t, { id: 1000 + t.length, status: 'ok', note: String(ev['text'] ?? '') }]);
        break;
      case 'narration':
        setTrace((t) => [...t, { id: 2000 + t.length, status: 'ok', narration: String(ev['text'] ?? '') }]);
        break;
      case 'synthesizing':
        setPhase('synthesizing');
        break;
      case 'final': {
        const fr: FinalResult = {
          findings: (ev['findings'] as Finding[]) ?? [],
          follow_up: (ev['follow_up'] as string[]) ?? [],
          derived: Boolean(ev['derived']),
        };
        if (ev['assessment'] != null) fr.assessment = String(ev['assessment']);
        if (ev['recommended_detection']) fr.recommended_detection = ev['recommended_detection'] as { rule?: string; scope?: string };
        setResult(fr);
        break;
      }
      case 'done':
        setMeta(ev as DoneMeta);
        setPhase('done');
        break;
      case 'error':
        setError(String(ev['text'] ?? 'agent error'));
        setPhase('error');
        break;
      default:
        break;
    }
  };

  const run = async (raw: string): Promise<void> => {
    const text = raw.trim().replace(/^\/(investigate|correlate|detect|factcheck|scene)\s*/i, '').trim();
    if (!text) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setOpen(true);
    setPhase('gathering');
    setTrace([]);
    setResult(null);
    setMeta(null);
    setError(null);
    setElapsed(0);
    const t0 = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 250);
    const scope = activeAoi ? `&lat=${activeAoi.center[1]}&lon=${activeAoi.center[0]}&radius_nm=300` : '';
    try {
      const r = await apiFetch(`/api/intel/agent?q=${encodeURIComponent(text)}${scope}`, {
        signal: ctrl.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!r.ok || !r.body) throw new Error(`agent failed (${r.status})`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
          } catch {
            /* skip malformed frame */
          }
        }
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    } finally {
      window.clearInterval(timer);
      setPhase((p) => (p === 'done' || p === 'error' ? p : 'done'));
    }
  };

  // Collapse the console back to the resting strip. `expanded` is derived from
  // run state (result/error/running), so clearing open ALONE never collapses it
  // after a query has run — the close button must also drop the result/error or
  // the panel is stuck open. This clears the run so `expanded` goes false.
  const collapse = useCallback((): void => {
    abortRef.current?.abort();
    setOpen(false);
    setPhase('idle');
    setTrace([]);
    setResult(null);
    setMeta(null);
    setError(null);
    setRanQuery('');
    setElapsed(0);
  }, [setOpen]);

  // Consume a query handed in from the AGENT indicator / elsewhere.
  useEffect(() => {
    if (pending && pending.seq !== lastSeq.current) {
      lastSeq.current = pending.seq;
      setQ(pending.q);
      void run(pending.q);
      clearPending();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // ⌘K / Ctrl+K focuses the prompt; Esc collapses (and aborts a run).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      } else if (e.key === 'Escape' && expanded && open) {
        collapse();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, open, setOpen, collapse]);

  const flyToFinding = (f: Finding): void => {
    if (!viewer || !f.centroid) return;
    flyToPosition(viewer, f.centroid.lon, f.centroid.lat, 320_000, 1.2);
    if (isMobile) setOpen(false);
  };

  const greenFeeds = Object.values(feeds).filter((f) => f.status === 'green').length;
  const totalFeeds = Object.values(feeds).length;
  const worstSev = alerts.some((a) => a.severity === 'critical' || a.severity === 'high')
    ? 'red'
    : alerts.some((a) => a.severity === 'medium')
      ? 'amber'
      : 'green';

  // ── mobile: a FAB opens a full-screen console ──
  if (isMobile && !open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        aria-label="Open analyst agent"
        className="fixed bottom-3 right-3 z-40 flex items-center gap-2 mono text-[13px] px-4 py-2.5 rounded-md border border-accent-line text-accent"
        style={{ background: 'rgba(9,12,18,0.95)' }}
      >
        <span className="w-2 h-2 bg-accent rotate-45" /> Agent
      </button>
    );
  }

  const containerCls = isMobile
    ? 'fixed inset-0 z-[1100] flex flex-col'
    : 'absolute left-1/2 -translate-x-1/2 bottom-4 z-[25] flex flex-col';
  const containerStyle = isMobile
    ? { background: 'rgba(9,12,18,0.98)' }
    : {
        width: expanded ? 724 : 600,
        maxHeight: '76vh',
        background: 'rgba(9,12,18,0.96)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-md)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 1px rgba(0,0,0,0.4)',
      };

  return (
    <div className={containerCls} style={containerStyle}>
      {/* ── header (expanded / mobile) ── */}
      {(expanded || isMobile) && (
        <div className="flex items-center gap-2.5 px-2.5 py-2 border-b border-line-2 bg-bg-1 shrink-0">
          <span className="mono text-accent text-[11px]">▸</span>
          <span className="mono text-[11px] tracking-[1px] text-txt-1">ANALYST</span>
          <span className="mono text-[8.5px] tracking-[0.6px] uppercase text-[#9cc2ff] border border-accent-line bg-accent-dim rounded-sm px-1.5 py-px">
            {phase === 'gathering' ? 'tool loop' : phase === 'synthesizing' ? 'reasoning' : phase === 'done' ? 'plan mode' : 'analyst'}
          </span>
          {meta?.model && (
            <span className="mono text-[8.5px] text-txt-3 border border-line rounded-sm px-1.5 py-px" title={`backend: ${meta.backend}`}>
              {String(meta.model).split('/').pop()}
            </span>
          )}
          <div className="flex-1" />
          <span className="flex items-center gap-1.5 mono text-[9px] tracking-[0.4px] text-accent">
            <StatusDot tone={running ? 'amber' : error ? 'red' : 'ok'} />
            {running
              ? `${phase === 'synthesizing' ? 'reasoning' : 'gathering'} · ${elapsed}s`
              : error
                ? 'error'
                : meta
                  ? `done · ${((meta.latency_ms ?? 0) / 1000).toFixed(1)}s`
                  : 'ready'}
          </span>
          <button
            type="button"
            onClick={collapse}
            aria-label="Close analyst console"
            className="mono text-[12px] text-txt-3 border border-line rounded-sm w-[24px] h-[22px] flex items-center justify-center hover:text-txt-1"
          >
            {isMobile ? '✕' : '⤓'}
          </button>
        </div>
      )}

      {/* ── live trace + result ── */}
      {(expanded || isMobile) && (
        <div ref={logRef} className="flex-1 overflow-y-auto px-3 py-3 min-h-0">
          {(running || result || error || ranQuery) && (
            <div className="mono text-[11px] text-txt-1 flex gap-2 leading-[1.5] mb-2">
              <span className="text-txt-3">analyst ▸</span>
              <span>{ranQuery || q}</span>
            </div>
          )}

          {error && (
            <div className="border border-[rgba(255,90,82,0.32)] bg-alert-bg rounded-sm px-3 py-2 text-[11px] text-[#ffc9c5]">
              {error}
            </div>
          )}

          {/* tool-call trace (Claude-Code-style) */}
          {trace.length > 0 && (
            <div className="flex flex-col gap-1 my-1.5">
              {trace.map((r) =>
                r.narration !== undefined ? (
                  <div
                    key={r.id}
                    className="border-l-2 border-accent-line pl-3 my-1 text-[11px] leading-[1.55] text-txt-2"
                  >
                    {r.narration}
                  </div>
                ) : r.note !== undefined ? (
                  <div key={r.id} className="flex gap-2 text-[10px] text-txt-3 leading-[1.4] pl-[22px]">
                    <span>{r.note}</span>
                  </div>
                ) : (
                  <div key={`${r.id}-${r.tool}`} className="text-[10.5px] leading-[1.5]">
                    <div className="grid items-baseline gap-2" style={{ gridTemplateColumns: '14px 1fr auto' }}>
                      <span className={`mono text-center ${r.status === 'ok' ? 'text-ok' : 'text-accent'}`}>
                        {r.status === 'ok' ? '✓' : '⟳'}
                      </span>
                      <span className="mono text-txt-1">
                        {r.tool}
                        <span className="text-txt-4">({argStr(r.args)})</span>
                      </span>
                      <span className="mono text-[9px] text-txt-3 whitespace-nowrap">
                        {r.status === 'ok' ? `${r.summary ?? ''}${r.ms != null ? ` · ${r.ms}ms` : ''}` : '…'}
                      </span>
                    </div>
                    {r.thought && <div className="pl-[22px] text-[9.5px] text-txt-3 italic">{r.thought}</div>}
                  </div>
                ),
              )}
            </div>
          )}

          {phase === 'synthesizing' && (
            <div className="text-[11px] text-accent mt-2">
              MiniMax-M3 reasoning over the gathered evidence… <span className="mono text-txt-3">· {elapsed}s</span>
            </div>
          )}

          {result && (
            <>
              {result.assessment && (
                <div className="border-l-2 border-accent-line pl-3 my-2.5 text-[11.5px] leading-[1.55] text-txt-1">
                  {result.assessment}
                </div>
              )}

              {result.recommended_detection?.rule && (
                <div
                  className="relative rounded-sm my-2.5 px-3 py-2.5 pl-3.5"
                  style={{
                    border: '1px solid rgba(245,165,36,0.35)',
                    background: 'linear-gradient(180deg, rgba(245,165,36,0.06), transparent)',
                  }}
                >
                  <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-warn" />
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="mono text-[9px] tracking-[0.7px] uppercase text-[#fcd9a0]">⚡ Detection proposed</span>
                    {result.recommended_detection.scope && (
                      <span className="mono text-[8px] tracking-[0.5px] uppercase text-txt-3 ml-auto truncate max-w-[55%]" title={result.recommended_detection.scope}>
                        {result.recommended_detection.scope}
                      </span>
                    )}
                  </div>
                  <div
                    className="mono text-[10px] leading-[1.55] text-[#ecd9b2] rounded-sm px-2.5 py-2"
                    style={{ background: '#0b0905', border: '1px solid rgba(245,165,36,0.2)' }}
                  >
                    {result.recommended_detection.rule}
                  </div>
                </div>
              )}

              {result.findings && result.findings.length > 0 && (
                <>
                  <div className="mono text-[8.5px] tracking-[0.7px] uppercase text-txt-4 mt-3 mb-1.5">
                    findings · cited incidents · {result.findings.length}
                  </div>
                  <div className="flex flex-col">
                    {result.findings.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => flyToFinding(f)}
                        disabled={!f.centroid}
                        title={f.centroid ? 'fly to incident' : undefined}
                        className="grid items-baseline gap-2 py-1.5 text-left border-b border-[rgba(255,255,255,0.035)] hover:bg-bg-2/50 disabled:cursor-default"
                        style={{ gridTemplateColumns: 'auto 1fr auto' }}
                      >
                        <span className="mono text-[9px] text-txt-3">{f.id.slice(0, 8)}</span>
                        <span className="text-[10.5px] text-txt-1">
                          <span className="text-txt-0">{f.label}</span>
                          {f.why && <span className="text-txt-3"> — {f.why}</span>}
                        </span>
                        <Badge tone={threatTone(f.threat)}>{f.threat ?? '—'}</Badge>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {result.follow_up && result.follow_up.length > 0 && (
                <>
                  <div className="mono text-[8.5px] tracking-[0.7px] uppercase text-txt-4 mt-3 mb-1.5">next steps</div>
                  <ul className="flex flex-col gap-1">
                    {result.follow_up.map((s, i) => (
                      <li key={i} className="flex gap-2 text-[10.5px] text-txt-1 leading-[1.45]">
                        <span className="text-accent mono">▸</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {result.derived && (
                <div className="mono text-[8.5px] text-txt-4 mt-3">
                  synthesised from the brief (the reasoning model did not return a clean final) — findings are the fused incidents.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── cost / governance bar ── */}
      {(expanded || isMobile) && meta && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-line bg-bg-1 mono text-[8.5px] tracking-[0.3px] text-txt-4 shrink-0 flex-wrap">
          <span>backend <b className="text-txt-2 font-medium">{meta.backend ?? '—'}</b></span>
          {meta.usage?.total_tokens != null && (
            <span>
              tok <b className="text-txt-2 font-medium">{meta.usage.total_tokens.toLocaleString()}</b>
              {meta.usage.prompt_tokens != null && (
                <span className="text-txt-4"> ({meta.usage.prompt_tokens}↑/{meta.usage.completion_tokens ?? 0}↓)</span>
              )}
            </span>
          )}
          <span>scope <b className="text-txt-2 font-medium">{meta.scope}</b></span>
          <span>incidents <b className="text-txt-2 font-medium">{meta.incident_count ?? '—'}</b></span>
          <span>signals <b className="text-txt-2 font-medium">{meta.signals_considered ?? '—'}</b></span>
          <span className="ml-auto">runtime <b className="text-txt-2 font-medium">{((meta.latency_ms ?? 0) / 1000).toFixed(1)}s</b></span>
        </div>
      )}

      {/* ── standing pills (desktop) ── */}
      {!isMobile && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 border-t border-line overflow-hidden shrink-0">
          <span className="mono text-[8px] tracking-[0.6px] uppercase text-txt-4">Standing</span>
          <span className="flex items-center gap-1.5 mono text-[9px] text-txt-2 border border-line rounded-full px-2 py-[3px] whitespace-nowrap">
            <StatusDot tone={worstSev} />alerts <b className="text-txt-1 font-medium">{alerts.length}</b>
          </span>
          <span className="flex items-center gap-1.5 mono text-[9px] text-txt-2 border border-line rounded-full px-2 py-[3px] whitespace-nowrap">
            AOI <b className="text-txt-1 font-medium">{activeAoi ? activeAoi.name : 'global'}</b>
          </span>
          {totalFeeds > 0 && (
            <span className="flex items-center gap-1.5 mono text-[9px] text-txt-2 border border-line rounded-full px-2 py-[3px] whitespace-nowrap">
              <StatusDot tone={greenFeeds === totalFeeds ? 'green' : 'amber'} />feeds{' '}
              <b className="text-txt-1 font-medium">{greenFeeds}/{totalFeeds}</b>
            </span>
          )}
        </div>
      )}

      {/* ── command line ── */}
      <div className="flex items-center gap-2.5 h-10 px-3 shrink-0 border-t border-line">
        <span className="mono text-accent text-[11px]">▸</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !running) void run(q);
          }}
          placeholder="investigate · query the snapshot · correlate · locate the emitter"
          aria-label="Analyst console prompt"
          disabled={running}
          className="flex-1 mono text-[11px] text-txt-1 placeholder:text-txt-3 bg-transparent border-none outline-none disabled:opacity-60"
        />
        {running ? (
          <Btn size="sm" onClick={() => abortRef.current?.abort()}>stop</Btn>
        ) : (
          <Btn size="sm" tone="accent" onClick={() => void run(q)}>↵ run</Btn>
        )}
        <span className="mono text-[9px] text-txt-3 border border-line-2 rounded-sm px-1.5 py-px">⌘K</span>
      </div>

      {/* ── slash hints (resting desktop only) ── */}
      {!expanded && !isMobile && (
        <div className="flex gap-3 px-3 pb-2 -mt-0.5 mono text-[9px] tracking-[0.4px] text-txt-4">
          {SLASH.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQ((cur) => (cur.startsWith('/') ? `${s} ` : `${s} ${cur}`).trimStart());
                inputRef.current?.focus();
              }}
              className="text-txt-2 hover:text-accent"
            >
              {s}
            </button>
          ))}
          <span className="ml-auto text-txt-4">nl · ⌘K palette</span>
        </div>
      )}
    </div>
  );
}
