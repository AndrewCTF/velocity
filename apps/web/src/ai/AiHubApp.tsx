// AI hub (design: single place for every AI tool, 2026-07-14). Before this,
// the AI surfaces were scattered — the Watch Officer's briefs sat unlabelled in
// the Inbox, the analyst agent was a ⌘J overlay, and the model manager +
// selection-inference toggle were buried several clicks deep in Settings. This
// app pulls them together: the autonomous Watch Officer up top (WatchOfficerPanel),
// the interactive analyst agent, and the local engine/models. It reuses the
// existing substrate wholesale (the `useAgent` store + AgentConsole, the
// watch-officer hooks, and LocalAiSection) — one small backend add (the officer's
// status endpoint) so the panel can prove the loop is alive.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as Cesium from 'cesium';
import {
  Sparkles,
  Bell,
  Cpu,
  ArrowRight,
  MessageSquare,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { apiFetch } from '../transport/http.js';
import { useAgent } from '../state/agent.js';
import { useAppView } from '../state/appView.js';
import { LocalAiSection } from '../settings/localAi/LocalAiSection.js';
import { WatchOfficerPanel } from './WatchOfficerPanel.js';

interface LocalStatus {
  engine?: string;
  selection_enabled?: boolean;
  selection_model?: string | null;
  ollama_up?: boolean;
  local_only?: boolean;
  enabled?: boolean;
}

const SUGGESTED: readonly string[] = [
  "What's happening in this area right now?",
  'Any GPS jamming or spoofing footprints?',
  'Assess the top incident and cite the evidence',
  'Any dark vessels or AIS gaps nearby?',
];

export function AiHubApp({ viewer }: { viewer: Cesium.Viewer | null }): JSX.Element {
  const ask = useAgent((s) => s.ask);
  const setApp = useAppView((s) => s.setApp);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [prompt, setPrompt] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const r = await apiFetch('/api/ai/local');
      if (r.ok) setStatus((await r.json()) as LocalStatus);
    } catch {
      /* non-fatal — the strip degrades to "unavailable" */
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Running the agent hands the query to the shared console overlay AND flips to
  // the Map app, so the operator sees the camera fly + entity selection the
  // agent drives. (The console renders over the globe, not this full surface.)
  const runAgent = useCallback(
    (q: string) => {
      const text = q.trim();
      if (text.length < 2) return;
      setApp('map');
      ask(text);
    },
    [ask, setApp],
  );

  return (
    <div className="h-full overflow-auto bg-bg-0">
      <div className="mx-auto max-w-[980px] px-6 py-6 space-y-6">
        {/* Intro + live AI status strip */}
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" strokeWidth={1.75} aria-hidden />
            <h1 className="text-[15px] font-semibold text-txt-0">AI workspace</h1>
          </div>
          <p className="text-[12px] text-txt-2 max-w-[70ch]">
            Your Watch Officer runs autonomously below; ask the analyst agent for anything
            on-demand; models run on your own GPU. The agents reason over live
            ADS-B/AIS/SAR/jamming and the fused incident picture — grounded, cited, nothing invented.
          </p>
          <StatusStrip status={status} />
        </header>

        {/* Watch Officer — the autonomous standing agent, front and centre */}
        <WatchOfficerPanel viewer={viewer} />

        {/* Analyst agent — interactive, on-demand */}
        <CollapsibleSection title="Analyst agent">
          <p className="text-[11px] text-txt-3">
            Ask a question — the agent runs a real tool-calling loop over the live data, flies the
            map to what it finds, and cites incident ids. Nothing is invented.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              runAgent(prompt);
              setPrompt('');
            }}
            className="flex items-center gap-2"
          >
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="investigate · query the snapshot · correlate · locate the emitter"
              aria-label="Ask the analyst agent"
              className="flex-1 mono text-[12px] text-txt-1 placeholder:text-txt-3 bg-bg-2 border border-line rounded-sm px-2.5 py-1.5 outline-none focus:border-accent-line"
            />
            <button
              type="submit"
              disabled={prompt.trim().length < 2}
              className="flex items-center gap-1.5 mono text-[11px] px-3 py-1.5 rounded-sm border border-accent-line text-accent hover:bg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Run <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            </button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => runAgent(s)}
                className="text-left mono text-[10px] text-txt-2 px-2 py-1 rounded-sm border border-line-2 bg-bg-2/40 hover:border-accent-line hover:text-txt-1"
              >
                {s}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              setApp('map');
              useAgent.getState().setOpen(true);
            }}
            className="flex items-center gap-1.5 mono text-[10px] text-txt-3 hover:text-accent"
          >
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Open the full console (⌘J)
          </button>
        </CollapsibleSection>

        {/* Engine & models */}
        <CollapsibleSection title="Engine & models" defaultOpen={false}>
          <p className="text-[11px] text-txt-3">
            Run inference on your own GPU: pick an engine, download and hot-load a model, and turn
            on the selection assessment that briefs whatever you click on the globe.
          </p>
          <LocalAiSection />
        </CollapsibleSection>
      </div>
    </div>
  );
}

// A titled section that collapses. Header chevron toggles the body; the whole
// header is the hit target. Defaults open — pass defaultOpen={false} for heavy
// sections (the model manager) so the hub opens compact.
function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-line bg-bg-1 p-4 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-txt-3" strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 text-txt-3" strokeWidth={1.75} aria-hidden />
        )}
        <span className="text-[12px] font-semibold text-txt-1">{title}</span>
      </button>
      {open && <div className="space-y-3">{children}</div>}
    </section>
  );
}

function StatusStrip({ status }: { status: LocalStatus | null }): JSX.Element {
  if (!status) {
    return <p className="mono text-[10px] text-txt-3">checking AI status…</p>;
  }
  const chips: { icon: JSX.Element; label: string; on: boolean }[] = [
    {
      icon: <Cpu className="h-3 w-3" strokeWidth={1.75} aria-hidden />,
      label: `engine: ${status.engine ?? 'auto'}`,
      on: true,
    },
    {
      icon: <Sparkles className="h-3 w-3" strokeWidth={1.75} aria-hidden />,
      label: status.selection_enabled ? 'selection assess: on' : 'selection assess: off',
      on: Boolean(status.selection_enabled),
    },
    {
      icon: <Bell className="h-3 w-3" strokeWidth={1.75} aria-hidden />,
      label: status.local_only ? 'local-only' : status.enabled ? 'local-first' : 'cloud-first',
      on: Boolean(status.enabled || status.local_only),
    },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`flex items-center gap-1 mono text-[10px] px-2 py-0.5 rounded-sm border ${
            c.on ? 'border-accent-line text-accent' : 'border-line text-txt-3'
          }`}
        >
          {c.icon}
          {c.label}
        </span>
      ))}
    </div>
  );
}
