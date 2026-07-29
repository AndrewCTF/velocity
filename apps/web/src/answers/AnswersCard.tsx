// Answers card — named questions with a one-word verdict, the rule that
// produced it, and the age of the evidence underneath.
//
// This is the one surface in the console that is not a map. Everything else
// shows data and leaves the conclusion to the operator; this states a
// conclusion and shows its working.
//
// The layout rule is deliberate and comes straight from the research
// (docs/research-last30days-2026-07-29.md §3): verdict large, and the RULE and
// the LAG directly beneath it, never behind a tooltip. The first question the
// technical audience asked of the highest-scoring project in this space was
// "what's the threshold function?", and the same author led with a four-day
// data lag and was rewarded for it. Hiding either is how a verdict stops being
// believed.
import { useEffect, useState } from 'react';
import { Widget, ErrorLine } from '../markets/primitives.js';
import { apiFetch } from '../transport/http.js';

export interface AnswerItem {
  id: string;
  question: string;
  verdict: 'open' | 'reduced' | 'closed' | 'unknown';
  threshold: string;
  as_of: number;
  // null means NO EVIDENCE WAS OBSERVED. It never means fresh - see the
  // backend contract in app/intel/answers.py.
  data_lag_s: number | null;
  confidence: string;
  detail: string;
  stale: boolean;
  observed: number | null;
  baseline: number | null;
}

const VERDICT_TONE: Record<string, string> = {
  open: 'text-ok-fg',
  reduced: 'text-warn-fg',
  closed: 'text-alert-fg',
  unknown: 'text-txt-3',
};

/** Coarse on purpose: second precision on a six-hour-old fix implies certainty
 *  we do not have. Mirrors agoText in globe/adapters/freshness.ts. */
export function lagText(seconds: number | null): string {
  if (seconds == null) return 'no evidence recorded';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s old`;
  if (s < 3600) return `${Math.floor(s / 60)}m old`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h old`;
  return `${Math.floor(s / 86_400)}d old`;
}

function AnswerRow({ item }: { item: AnswerItem }): JSX.Element {
  const tone = VERDICT_TONE[item.verdict] ?? 'text-txt-3';
  return (
    <div className="py-2 border-b border-line/60 last:border-b-0 min-w-0">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[11px] text-txt-1 flex-1 min-w-0 truncate" title={item.question}>
          {item.question}
        </span>
        <span className={`mono text-[13px] uppercase tracking-[0.5px] shrink-0 ${tone}`}>
          {item.verdict}
        </span>
      </div>

      {/* Evidence age sits with the verdict, not in a tooltip. A verdict whose
          staleness you have to hunt for is a verdict that gets believed too long. */}
      <div className="mt-0.5 flex items-center gap-2 min-w-0">
        <span
          className={`mono text-[10px] tabular-nums ${item.stale ? 'text-warn-fg' : 'text-txt-4'}`}
        >
          {lagText(item.data_lag_s)}
        </span>
        <span className="mono text-[10px] text-txt-4">· confidence {item.confidence}</span>
      </div>

      <div className="mt-1 text-[10px] text-txt-3 leading-snug">{item.detail}</div>

      {/* The rule, in full. Not truncated and not hidden: it is the difference
          between a verdict and an assertion. */}
      <div className="mt-1 text-[10px] text-txt-4 leading-snug border-l border-line pl-2">
        {item.threshold}
      </div>
    </div>
  );
}

export function AnswersCard(): JSX.Element {
  const [items, setItems] = useState<AnswerItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const r = await apiFetch('/api/answers');
        if (!r.ok) {
          if (!cancelled) setError(`HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as { answers?: AnswerItem[] };
        if (!cancelled) {
          setItems(body.answers ?? []);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('unreachable');
      }
    };
    void load();
    // Verdicts move on the scale of hours, not seconds; polling faster would
    // spend the snapshot walk for a number that cannot have changed.
    const t = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <Widget title="Answers">
      {items == null && !error && <div className="mono text-[10px] text-txt-4">Loading…</div>}
      {error && <ErrorLine>Answers unavailable ({error}).</ErrorLine>}
      {items != null && items.length === 0 && (
        <div className="mono text-[10px] text-txt-4">No questions registered.</div>
      )}
      {items != null && items.length > 0 && (
        <div className="flex flex-col">
          {items.map((it) => (
            <AnswerRow key={it.id} item={it} />
          ))}
        </div>
      )}
    </Widget>
  );
}
