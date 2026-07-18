import { useEffect, useRef, useState } from 'react';
import { Widget, Btn, Badge, Caveat } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

// Grounded analytic narrative for a tracked entity (the Gotham "Dossier" prose).
// On-demand ONLY (a button, not auto-fetch) so the reasoning tier isn't hit on
// every selection. The model reasons over the deterministic dossier; each claim
// shows the field it is GROUNDED IN, and the whole thing is labelled an ANALYTIC
// ASSESSMENT — never asserted fact. No model configured ⇒ honest message, no fake.

interface Observation {
  claim: string;
  grounded_in?: string;
}
interface Narrative {
  ok?: boolean;
  error?: string;
  assessment?: string;
  observations?: Observation[];
  confidence?: string;
  caveats?: string[];
}

interface Props {
  id: string;
  kind?: string;
}

export function DossierNarrativeCard({ id, kind }: Props): JSX.Element | null {
  const [data, setData] = useState<Narrative | null>(null);
  const [busy, setBusy] = useState(false);
  const inflightRef = useRef<AbortController | null>(null);

  // Reset when the selection changes. This card instance persists across
  // selections (EntityPanel is toggled by display, never re-keyed), so without
  // this it would keep showing the previous contact's assessment with the button
  // reading "↻ Regenerate" — every sibling card already resets on id. Also abort
  // an in-flight Generate so a late response for the prior contact can't paint
  // under the new one (matches AiAssessmentCard's inflightRef).
  useEffect(() => {
    setData(null);
    setBusy(false);
    return () => inflightRef.current?.abort();
  }, [id, kind]);

  // Only aircraft / vessels have a pattern-of-life dossier to narrate.
  if (kind !== 'aircraft' && kind !== 'vessel') return null;
  const entityId = id.includes(':') ? id : `${kind}:${id}`;

  const generate = async (): Promise<void> => {
    inflightRef.current?.abort();
    const aborter = new AbortController();
    inflightRef.current = aborter;
    setBusy(true);
    try {
      const r = await apiFetch(
        `/api/intel/dossier/narrative?entity_id=${encodeURIComponent(entityId)}`,
        { method: 'POST', signal: aborter.signal },
      );
      const body = (await r.json().catch(() => null)) as Narrative | null;
      if (aborter.signal.aborted) return;
      setData(body ?? { ok: false, error: 'Could not load the assessment.' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setData({ ok: false, error: 'Could not load the assessment.' });
    } finally {
      if (!aborter.signal.aborted) setBusy(false);
    }
  };

  return (
    <Widget
      title="Analytic assessment"
      action={
        <Btn size="sm" tone="accent" disabled={busy} onClick={() => void generate()}>
          {busy ? 'Generating…' : data ? '↻ Regenerate' : '⚙ Generate'}
        </Btn>
      }
    >
      <div className="space-y-2">
        <Caveat level="ANALYTIC ASSESSMENT" note="grounded" tone="warn" />
        {!data && (
          <p className="text-[10.5px] text-txt-3">
            Reasoning model summarises this entity's observed pattern-of-life. Every claim cites the
            dossier field it came from.
          </p>
        )}
        {data && data.ok === false && (
          <p className="text-[10.5px] text-warn">
            {data.error === 'model unavailable' || !data.error
              ? 'Assessment unavailable. No reasoning model configured.'
              : data.error}
          </p>
        )}
        {data && data.ok && (
          <div className="space-y-2">
            {data.assessment && (
              <div
                className="relative rounded-sm border border-line bg-bg-1/60 pl-3 pr-2.5 py-2 overflow-hidden"
                style={{ boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.4)' }}
              >
                <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-warn/60" />
                <p className="text-[11px] text-txt-1 leading-relaxed">{data.assessment}</p>
              </div>
            )}
            {data.confidence && (
              <Badge tone={data.confidence === 'high' ? 'accent' : data.confidence === 'low' ? 'neutral' : 'warn'}>
                confidence: {data.confidence}
              </Badge>
            )}
            {data.observations && data.observations.length > 0 && (
              <ul className="space-y-1.5">
                {data.observations.map((o, i) => (
                  <li key={i} className="text-[10.5px] text-txt-2">
                    <span>{o.claim}</span>
                    {o.grounded_in && (
                      <span className="ml-1.5 mono text-[10px] text-txt-3 align-middle">
                        ⟵ {o.grounded_in}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {data.caveats && data.caveats.length > 0 && (
              <ul className="mt-1 list-disc list-inside text-[10px] text-txt-3">
                {data.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Widget>
  );
}
