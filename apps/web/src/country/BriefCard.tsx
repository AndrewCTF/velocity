// AI country brief card — /api/country/{iso3}/brief is an LLM call that can
// take up to 90 s (server budget), so it fires ONLY on an explicit button
// click (never on selection). While generating we show an elapsed-seconds
// progress line; the result renders through the shared <Markdown>
// (token-styled, HTML-stripped).
// ok:false (no LLM backend / no model pinned) degrades to a plain explanation
// with a pointer at Settings → Local AI — successful briefs are cached per
// iso3 in a module map, failures are not (so fixing the model config retries).

import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../shell/Markdown.js';
import { apiFetch } from '../transport/http.js';
import { Card, type BriefResponse } from './shared.js';

const briefCache = new Map<string, BriefResponse>();

interface BriefState {
  busy: boolean;
  error: string | null;
  data: BriefResponse | null;
}

export function BriefCard({ iso3 }: { iso3: string }): JSX.Element {
  const [state, setState] = useState<BriefState>(() => ({
    busy: false,
    error: null,
    data: briefCache.get(iso3) ?? null,
  }));
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Country switch remounts this card (keyed by iso3 in the shell), so unmount
  // cleanup is the abort path for in-flight generations.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!state.busy) return;
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [state.busy]);

  async function generate(): Promise<void> {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ busy: true, error: null, data: null });
    try {
      const r = await apiFetch(`/api/country/${iso3}/brief`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`Country brief unavailable (HTTP ${r.status})`);
      const body = (await r.json()) as BriefResponse;
      if (body.ok) briefCache.set(iso3, body);
      if (!ctrl.signal.aborted) setState({ busy: false, error: null, data: body });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setState({ busy: false, error: e instanceof Error ? e.message : String(e), data: null });
    }
  }

  const meta =
    state.data?.ok === true
      ? [state.data.backend, state.data.model].filter(Boolean).join(' · ') || undefined
      : undefined;

  return (
    <Card title="AI country brief" meta={meta}>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={state.busy}
          onClick={() => void generate()}
          className="px-2.5 py-1.5 text-[11px] rounded-sm border border-line-2 bg-bg-2 text-txt-1 hover:text-txt-0 hover:border-accent disabled:opacity-50"
        >
          {state.busy ? 'Generating…' : state.data?.ok === true ? 'Regenerate brief' : 'Generate brief'}
        </button>
        {state.busy && (
          <span className="mono text-[10px] text-txt-3">
            fusing indicators + leadership + security… {elapsed} s (local model, up to ~90 s)
          </span>
        )}
        {!state.busy && !state.data && !state.error && (
          <span className="mono text-[10px] text-txt-4">
            All-source markdown assessment grounded only in this page&#39;s data.
          </span>
        )}
      </div>
      {state.error && (
        <div className="mono text-[10px] text-alert-fg mt-2">Brief failed: {state.error}</div>
      )}
      {state.data && state.data.ok === false && (
        <div className="mt-2 border border-warn-line bg-warn-bg rounded-sm p-2">
          <div className="text-[11px] text-warn-fg">
            Brief unavailable: {state.data.reason || 'no LLM backend answered'}.
          </div>
          <div className="text-[10px] text-txt-3 mt-0.5">
            Configure a local model in Settings → Local AI, then retry.
          </div>
        </div>
      )}
      {state.data?.ok === true && (
        <div className="mt-2 border-t border-line pt-2">
          <Markdown text={state.data.markdown} />
        </div>
      )}
    </Card>
  );
}
