// Watch Officer — the autonomous standing agent, surfaced as a first-class
// panel (not a flat alert list). It fuses live cross-domain signals every cycle,
// files a finished brief when a convergence escalates into high/elevated, runs a
// playbook (SAR tip-and-cue on dark vessels; mints a tracked incident object),
// and hands the operator a triage queue. This panel shows it is ALIVE (status +
// cadence + sweep/brief counts), what it WILL do (playbook roster), and the full
// brief (evidence chain, actions taken, follow-ups) — with fly-to, triage, a
// one-click hand-off to the analyst agent, per-brief AI elaboration, and an
// "auto-elaborate everything" mode that writes a deeper assessment on every open
// brief. The whole panel and its queue collapse.
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import {
  Shield,
  Radio,
  ChevronRight,
  ChevronDown,
  Crosshair,
  Bot,
  Check,
  X,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { flyToPosition } from '../globe/camera.js';
import { Markdown } from '../shell/Markdown.js';
import { useAgent } from '../state/agent.js';
import { useAppView } from '../state/appView.js';
import {
  useWatchOfficerBriefs,
  useWatchOfficerStatus,
  elaborateBrief,
  type WatchOfficerBrief,
} from '../state/watchOfficer.js';

const THREAT_TONE: Record<string, string> = {
  high: 'text-alert border-alert-line',
  elevated: 'text-warn border-warn-line',
  low: 'text-txt-2 border-line',
};

interface Elab {
  loading: boolean;
  text?: string;
  error?: string;
  disabled?: boolean;
}

function ago(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function WatchOfficerPanel({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const { briefs, dismiss, ack } = useWatchOfficerBriefs();
  const status = useWatchOfficerStatus();
  const setApp = useAppView((s) => s.setApp);
  const ask = useAgent((s) => s.ask);

  const [panelOpen, setPanelOpen] = useState(true);
  const [autoElaborate, setAutoElaborate] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [elabs, setElabs] = useState<Record<string, Elab>>({});
  // Ids we've already kicked off an elaboration for — guards the auto loop from
  // re-requesting the same brief every render / poll.
  const requested = useRef<Set<string>>(new Set());

  const setElab = (id: string, e: Elab): void => setElabs((m) => ({ ...m, [id]: e }));

  const runElaborate = async (id: string): Promise<void> => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setElab(id, { loading: true });
    const res = await elaborateBrief(id);
    if (res === 'disabled') setElab(id, { loading: false, disabled: true });
    else if (res && res.ok) setElab(id, { loading: false, text: res.text });
    else setElab(id, { loading: false, error: 'elaboration unavailable' });
  };

  // Auto-elaborate everything: expand all open briefs and, one at a time (gentle
  // on the model), fetch a deeper write-up for each that doesn't have one yet.
  useEffect(() => {
    if (!autoElaborate) return;
    setExpanded(new Set(briefs.map((b) => b.id)));
    let cancelled = false;
    void (async () => {
      for (const b of briefs) {
        if (cancelled) break;
        if (requested.current.has(b.id)) continue;
        await runElaborate(b.id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoElaborate, briefs]);

  const allExpanded = briefs.length > 0 && briefs.every((b) => expanded.has(b.id));
  const toggleAll = (): void =>
    setExpanded(allExpanded ? new Set() : new Set(briefs.map((b) => b.id)));
  const toggleOne = (id: string): void =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const flyTo = (b: WatchOfficerBrief): void => {
    if (!viewer || b.centroid.lon == null || b.centroid.lat == null) return;
    setApp('map');
    flyToPosition(viewer, b.centroid.lon, b.centroid.lat, 320_000, 1.2);
  };

  const investigate = (b: WatchOfficerBrief): void => {
    const where =
      b.centroid.lat != null && b.centroid.lon != null
        ? ` near ${b.centroid.lat.toFixed(2)},${b.centroid.lon.toFixed(2)}`
        : '';
    setApp('map');
    ask(
      `Investigate this ${b.threat_level} ${b.domains.join(' + ')} convergence${where}: ` +
        `${b.title}. Confirm the evidence, assess intent, and recommend a detection.`,
    );
  };

  const running = status?.running ?? false;

  return (
    <section className="rounded-md border border-line bg-bg-1 p-4 space-y-3">
      {/* Named header + liveness + collapse */}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setPanelOpen((v) => !v)}
          className="flex items-center gap-2 min-w-0"
          aria-expanded={panelOpen}
        >
          {panelOpen ? (
            <ChevronDown className="h-4 w-4 text-txt-3" strokeWidth={1.75} aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 text-txt-3" strokeWidth={1.75} aria-hidden />
          )}
          <Shield className="h-4 w-4 text-accent" strokeWidth={1.75} aria-hidden />
          <h2 className="text-[13px] font-semibold text-txt-0">Watch Officer</h2>
          <span
            className={`flex items-center gap-1 mono text-[10px] px-1.5 py-0.5 rounded-sm border ${
              running ? 'border-ok-line text-ok' : 'border-line text-txt-3'
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${running ? 'bg-ok animate-pulse' : 'bg-txt-4'}`}
            />
            {running ? 'autonomous · running' : 'idle'}
          </span>
        </button>
        <span className="mono text-[10px] text-txt-3 shrink-0">
          {panelOpen
            ? status
              ? `sweep every ${Math.round(status.cycle_s)}s`
              : ''
            : `${briefs.length} briefs`}
        </span>
      </div>

      {panelOpen && (
        <>
          <p className="text-[11px] text-txt-3">
            Fuses live ADS-B/AIS/SAR/jamming/event signals every cycle and files a finished brief
            when a convergence escalates — behavioural detection (AIS/ADS-B gaps, loiter, proximity),
            no query needed. It also acts: tasks SAR on dark vessels and mints a tracked incident.
          </p>

          {/* Live telemetry chips */}
          {status && (
            <div className="flex flex-wrap gap-1.5">
              <Chip label={`${status.sweeps} sweeps`} />
              <Chip label={`last sweep ${ago(status.last_sweep_at)}`} />
              <Chip label={`${status.open} open`} on={status.open > 0} />
              {Object.entries(status.by_level).map(([lvl, n]) => (
                <Chip key={lvl} label={`${n} ${lvl}`} tone={THREAT_TONE[lvl] ?? 'border-line text-txt-2'} />
              ))}
              <Chip label={`${status.total_filed} filed this session`} />
            </div>
          )}

          {/* Playbook roster */}
          {status && status.playbooks.length > 0 && (
            <div className="rounded-sm border border-line-2 bg-bg-2/40 p-2 space-y-1">
              <div className="flex items-center gap-1.5 mono text-[10px] text-txt-3 uppercase tracking-wide">
                <Radio className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                Playbooks
              </div>
              {status.playbooks.map((p) => (
                <div key={p.id} className="mono text-[10px] text-txt-2">
                  <span className="text-txt-3">on</span> {p.trigger}{' '}
                  <ChevronRight className="inline h-3 w-3 -mt-0.5" strokeWidth={2} aria-hidden />{' '}
                  {p.action}
                </div>
              ))}
            </div>
          )}

          {/* Queue controls */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[12px] font-semibold text-txt-1">
              Triage queue{' '}
              <span className="mono text-[11px] text-txt-3 tabular-nums">{briefs.length}</span>
            </span>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 mono text-[10px] text-txt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoElaborate}
                  onChange={(e) => setAutoElaborate(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                <Sparkles className="h-3 w-3 text-accent" strokeWidth={1.75} aria-hidden />
                Auto-elaborate everything
              </label>
              {briefs.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="mono text-[10px] px-2 py-0.5 rounded-sm border border-line text-txt-2 hover:border-accent-line hover:text-accent"
                >
                  {allExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
          </div>

          {briefs.length === 0 ? (
            <p className="mono text-[11px] text-txt-3 py-2">
              No open briefs — the officer is on watch and the picture is quiet.
            </p>
          ) : (
            <ul className="space-y-2">
              {briefs.map((b) => {
                const tone = THREAT_TONE[b.threat_level] ?? THREAT_TONE.low;
                const isOpen = expanded.has(b.id);
                const sarStatus =
                  typeof b.playbook?.sar === 'string' ? (b.playbook.sar as string) : null;
                const elab = elabs[b.id];
                return (
                  <li key={b.id} className={`rounded-sm border ${tone} bg-bg-2/50 p-2.5 space-y-2`}>
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => toggleOne(b.id)}
                        className="text-left flex-1 min-w-0"
                        aria-expanded={isOpen}
                      >
                        <span className="mono text-[10px] uppercase tracking-wide">
                          {b.threat_level}
                        </span>
                        <span className="block text-[12px] text-txt-1 truncate">{b.title}</span>
                      </button>
                      <div className="flex gap-1 shrink-0">
                        <IconBtn
                          title="Elaborate with AI"
                          onClick={() => {
                            toggleOne(b.id);
                            if (!expanded.has(b.id)) setExpanded((s) => new Set(s).add(b.id));
                            void runElaborate(b.id);
                          }}
                        >
                          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                        </IconBtn>
                        <IconBtn title="Fly the map here" onClick={() => flyTo(b)}>
                          <Crosshair className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                        </IconBtn>
                        <IconBtn
                          title="Investigate with the analyst agent"
                          onClick={() => investigate(b)}
                        >
                          <Bot className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                        </IconBtn>
                        <IconBtn title="Acknowledge" onClick={() => ack(b.id)}>
                          <Check className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                        </IconBtn>
                        <IconBtn title="Dismiss as noise" onClick={() => dismiss(b.id)}>
                          <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                        </IconBtn>
                      </div>
                    </div>

                    {b.domains.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {b.domains.map((d) => (
                          <span
                            key={d}
                            className="mono text-[9px] text-txt-3 px-1.5 py-0.5 rounded-sm bg-bg-1 border border-line-2"
                          >
                            {d}
                          </span>
                        ))}
                        {sarStatus && (
                          <span className="mono text-[9px] text-accent px-1.5 py-0.5 rounded-sm bg-bg-1 border border-accent-line">
                            ⚡ SAR tasked: {sarStatus}
                          </span>
                        )}
                      </div>
                    )}

                    {b.narrative && <p className="text-[11px] text-txt-2">{b.narrative}</p>}

                    {isOpen && (
                      <div className="space-y-2 pt-1 border-t border-line-2">
                        {/* AI elaboration */}
                        {elab && (
                          <div className="rounded-sm border border-accent-line/60 bg-accent/5 p-2 space-y-1">
                            <div className="flex items-center gap-1.5 mono text-[9px] text-accent uppercase tracking-wide">
                              <Sparkles className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                              AI assessment
                            </div>
                            {elab.loading && (
                              <span className="flex items-center gap-1.5 mono text-[10px] text-txt-3">
                                <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />
                                elaborating…
                              </span>
                            )}
                            {elab.text && (
                              <div className="text-[11px] text-txt-1 leading-snug">
                                <Markdown text={elab.text} />
                              </div>
                            )}
                            {elab.disabled && (
                              <p className="mono text-[10px] text-warn">
                                Enable “Selection AI brief” under Engine &amp; models to elaborate.
                              </p>
                            )}
                            {elab.error && (
                              <p className="mono text-[10px] text-txt-3">{elab.error}</p>
                            )}
                          </div>
                        )}

                        {b.evidence.length > 0 && (
                          <div className="space-y-1">
                            <div className="mono text-[9px] text-txt-3 uppercase tracking-wide">
                              Evidence chain
                            </div>
                            {b.evidence.map((e, i) => (
                              <div key={i} className="mono text-[10px] text-txt-2">
                                <span className="text-txt-3">{e.domain}</span>
                                <span className="text-txt-4"> · {e.severity}</span> — {e.summary}
                                {e.kind && (
                                  <span className="text-txt-4">
                                    {' '}
                                    [{e.kind}
                                    {e.basis ? `: ${e.basis}` : ''}]
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {b.follow_up.length > 0 && (
                          <div className="space-y-1">
                            <div className="mono text-[9px] text-txt-3 uppercase tracking-wide">
                              Recommended follow-up
                            </div>
                            <ul className="list-disc pl-4 space-y-0.5">
                              {b.follow_up.map((f, i) => (
                                <li key={i} className="text-[10px] text-txt-2">
                                  {f}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Chip({ label, on, tone }: { label: string; on?: boolean; tone?: string }): JSX.Element {
  return (
    <span
      className={`mono text-[10px] px-2 py-0.5 rounded-sm border ${
        tone ?? (on ? 'border-accent-line text-accent' : 'border-line text-txt-3')
      }`}
    >
      {label}
    </span>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="p-1 rounded-sm border border-line text-txt-3 hover:border-accent-line hover:text-accent"
    >
      {children}
    </button>
  );
}
