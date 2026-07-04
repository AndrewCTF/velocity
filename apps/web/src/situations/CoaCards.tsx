import { useState } from 'react';
import { Badge, Btn, Caveat, StatusDot, type BadgeTone } from '../shell/instruments.js';
import { useSituations } from './situationStore.js';
import { apiFetch } from '../transport/http.js';

// Courses of Action for a Situation (Gotham "Possible Enemy / Friendly COAs").
// Proposed by the grounded reasoning model over the situation's linked evidence
// (hypothetical), then the analyst Verifies (persists a coa: ontology node linked
// to the situation) or Rejects. Instrument-grade: each COA is a left-accent-bar
// card (red enemy / blue friendly) with a likelihood badge. All HYPOTHETICAL.

type Side = 'enemy' | 'friendly';
type Likelihood = 'low' | 'med' | 'high';
interface Coa {
  title: string;
  side: Side;
  likelihood: Likelihood;
  rationale: string;
  status: 'hypothetical' | 'confirmed' | 'rejected';
}

const LIK_TONE: Record<Likelihood, BadgeTone> = { high: 'alert', med: 'warn', low: 'neutral' };
const SIDE_BAR: Record<Side, string> = { enemy: 'var(--alert)', friendly: 'var(--accent-line)' };
const SIDE_LABEL: Record<Side, { text: string; cls: string }> = {
  enemy: { text: 'Possible enemy COAs', cls: 'text-[#ffb3ae]' },
  friendly: { text: 'Possible friendly COAs', cls: 'text-[#9cc2ff]' },
};

let _seq = 0;

export function CoaCards({ situationId }: { situationId: string }): JSX.Element {
  const [coas, setCoas] = useState<Coa[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const linkChild = useSituations((s) => s.linkChild);

  const propose = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const r = await apiFetch(`/api/situations/${encodeURIComponent(situationId)}/coa/propose`, {
        method: 'POST',
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.ok) {
        setNote(body?.error ?? (r.status === 401 ? 'sign in to propose COAs' : 'reasoning model unavailable'));
        return;
      }
      const fresh: Coa[] = (body.coas ?? []).map((c: Record<string, unknown>) => ({
        title: String(c.title ?? 'COA'),
        side: c.side === 'friendly' ? 'friendly' : 'enemy',
        likelihood: (['low', 'med', 'high'].includes(String(c.likelihood)) ? c.likelihood : 'med') as Likelihood,
        rationale: String(c.rationale ?? ''),
        status: 'hypothetical' as const,
      }));
      setCoas(fresh);
      if (fresh.length === 0) setNote('evidence too thin to propose COAs');
    } catch {
      setNote('request failed');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (idx: number): Promise<void> => {
    const c = coas[idx];
    if (!c) return;
    setCoas((cs) => cs.map((x, i) => (i === idx ? { ...x, status: 'confirmed' } : x)));
    const coaId = `coa:${Date.now().toString(36)}-${(_seq++).toString(36)}`;
    try {
      await apiFetch('/api/ontology/object', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: coaId,
          props: { kind: 'coa', title: c.title, side: c.side, likelihood: c.likelihood, rationale: c.rationale, status: 'confirmed' },
        }),
      });
      await linkChild(situationId, coaId, 'contains');
    } catch {
      /* kept locally even if persist degrades */
    }
  };

  const reject = (idx: number): void =>
    setCoas((cs) => cs.map((x, i) => (i === idx ? { ...x, status: 'rejected' } : x)));

  const column = (side: Side): JSX.Element => {
    const list = coas.map((c, i) => ({ c, i })).filter(({ c }) => c.side === side && c.status !== 'rejected');
    const meta = SIDE_LABEL[side];
    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1.5">
          <StatusDot tone={side === 'enemy' ? 'alert' : 'accent'} />
          <span className={`mono text-[10px] tracking-[0.6px] uppercase ${meta.cls}`}>{meta.text}</span>
          <span className="mono text-[10px] text-txt-3 tabular-nums">{list.length}</span>
        </div>
        <ul className="space-y-1.5">
          {list.map(({ c, i }) => (
            <li
              key={i}
              className="relative rounded-sm border border-line bg-bg-1/70 pl-3 pr-2.5 py-2 overflow-hidden"
              style={{ boxShadow: '0 1px 0 rgba(0,0,0,0.35)' }}
            >
              <span className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: SIDE_BAR[c.side] }} />
              <div className="flex items-center gap-1.5">
                <Badge tone={LIK_TONE[c.likelihood]}>{c.likelihood}</Badge>
                <span className="text-[11px] text-txt-0 leading-tight flex-1">{c.title}</span>
              </div>
              {c.rationale && <p className="mt-1 text-[10px] text-txt-3 leading-snug">{c.rationale}</p>}
              <div className="mt-1.5 flex items-center gap-1.5">
                {c.status === 'confirmed' ? (
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone="ok" />
                    <Badge tone="accent">confirmed</Badge>
                  </span>
                ) : (
                  <>
                    <Btn size="sm" tone="accent" onClick={() => void confirm(i)}>
                      Verify
                    </Btn>
                    <Btn size="sm" onClick={() => reject(i)}>
                      Reject
                    </Btn>
                  </>
                )}
              </div>
            </li>
          ))}
          {list.length === 0 && <li className="text-[10px] text-txt-4 mono">—</li>}
        </ul>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Caveat level="HYPOTHETICAL" note="model estimate over linked evidence" tone="warn" />
        <span className="flex-1" />
        <Btn size="sm" tone="accent" disabled={busy} onClick={() => void propose()}>
          {busy ? 'Proposing…' : '⚙ Propose COAs'}
        </Btn>
      </div>
      {note && <p className="text-[10px] text-warn">{note}</p>}
      {coas.length > 0 && (
        <div className="flex gap-3 pt-1">
          {column('enemy')}
          {column('friendly')}
        </div>
      )}
    </div>
  );
}
