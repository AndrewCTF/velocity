import { useEffect, useState } from 'react';
import { Widget, Caveat } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

// One organisation across four registries, from `/api/org/resolve`.
//
// The sanctions card answers "is this hull designated". This is the question
// straight after it, and no single free source answers it: who is this legal
// entity, where is it registered, what has it been compelled to file, and who
// pays it. GLEIF, SEC EDGAR, USAspending and the designation lists each hold one
// quarter of that, and joining them is what a commercial product charges for.
//
// The rule this card renders faithfully: a source that ANSWERED with nothing and
// a source that did not answer look different. `reached` and `failed` come back
// on every response and both appear here, because "no filings" from a live EDGAR
// is a result and "no filings" from a dead one is a lie.

interface Lei {
  lei: string;
  legal_name: string | null;
  jurisdiction: string | null;
  country: string | null;
  city: string | null;
  registration_status: string | null;
}
interface Filing {
  filed: string | null;
  forms: string[] | string | null;
  filer: string | null;
  adsh: string | null;
}
interface Award {
  award_id: string | null;
  recipient: string | null;
  amount_usd: number | null;
  agency: string | null;
  start: string | null;
}
interface Resolution {
  query: string;
  lei: Lei[];
  filings: Filing[];
  awards: Award[];
  sanctions: { lists: string[]; programs: string[] } | null;
  reached: string[];
  failed: Record<string, string>;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; code: number }
  | { status: 'done'; data: Resolution };

function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
}

export function OrgCard({ name }: { name: string | null | undefined }): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !name) return;
    setState({ status: 'loading' });
    const ab = new AbortController();
    apiFetch(`/api/org/resolve?name=${encodeURIComponent(name)}`, { signal: ab.signal })
      .then(async (r) => {
        if (ab.signal.aborted) return;
        if (!r.ok) {
          setState({ status: 'error', code: r.status });
          return;
        }
        setState({ status: 'done', data: (await r.json()) as Resolution });
      })
      .catch(() => {
        if (!ab.signal.aborted) setState({ status: 'error', code: 0 });
      });
    return () => ab.abort();
  }, [open, name]);

  if (!name) return null;

  if (!open) {
    return (
      <Widget title="Organisation">
        <div className="flex items-center gap-2 px-[14px] py-[6px]">
          <span className="min-w-0 flex-1 truncate text-[12px] text-txt-1">{name}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="mono h-[20px] shrink-0 rounded-sm px-[7px] text-[12px] text-txt-2 hover:bg-[var(--hover)]"
          >
            resolve
          </button>
        </div>
        <Caveat note="Queries GLEIF, SEC EDGAR, USAspending and the designation lists. Four requests, so it runs when you ask." />
      </Widget>
    );
  }

  if (!state || state.status === 'loading') {
    return (
      <Widget title="Organisation">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-3">resolving…</div>
      </Widget>
    );
  }
  if (state.status === 'error') {
    return (
      <Widget title="Organisation">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-2">
          {state.code ? `Resolution unavailable (HTTP ${state.code})` : 'Resolution unavailable'}
        </div>
      </Widget>
    );
  }

  const d = state.data;
  const missing = Object.keys(d.failed);

  return (
    <Widget title="Organisation">
      <div className="px-[14px] pb-[4px] pt-[6px] text-[12px] text-txt-1">{d.query}</div>

      {d.sanctions && (
        <Sect label="Designated">
          <Line
            k={d.sanctions.lists.join(' · ')}
            v={d.sanctions.programs.slice(0, 3).join(' · ') || '—'}
          />
        </Sect>
      )}

      <Sect label={`Legal entity (${d.lei.length})`}>
        {d.lei.length === 0 ? (
          <Empty ok={d.reached.includes('GLEIF')} what="LEI register" />
        ) : (
          d.lei.slice(0, 4).map((l) => (
            <div key={l.lei} className="px-[14px] py-[2px]">
              <div className="flex items-baseline gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate text-txt-1">{l.legal_name ?? '—'}</span>
                <span className="mono shrink-0 text-txt-3">{l.country ?? '—'}</span>
              </div>
              <div className="mono text-[12px] text-txt-3">
                {l.lei} · {l.registration_status ?? '—'}
              </div>
            </div>
          ))
        )}
      </Sect>

      <Sect label={`Filings (${d.filings.length})`}>
        {d.filings.length === 0 ? (
          <Empty ok={d.reached.includes('SEC EDGAR')} what="SEC EDGAR" />
        ) : (
          d.filings.slice(0, 5).map((f, i) => (
            <Line
              key={`${f.adsh ?? i}`}
              k={f.filer ?? '—'}
              v={`${Array.isArray(f.forms) ? f.forms.join('/') : (f.forms ?? '—')} · ${f.filed ?? '—'}`}
            />
          ))
        )}
      </Sect>

      <Sect label={`Federal awards (${d.awards.length})`}>
        {d.awards.length === 0 ? (
          <Empty ok={d.reached.includes('USAspending')} what="USAspending" />
        ) : (
          d.awards.slice(0, 5).map((a, i) => (
            <Line key={a.award_id ?? i} k={a.agency ?? '—'} v={usd(a.amount_usd)} />
          ))
        )}
      </Sect>

      <Caveat
        tone={missing.length ? 'warn' : 'neutral'}
        note={
          missing.length
            ? `${d.reached.length} of ${d.reached.length + missing.length} registries answered. ${missing.join(' · ')} did not, so those sections are not zeroes. Joined on the name only.`
            : 'All four registries answered. Joined on the name only, so treat every row as a candidate until an LEI, a CIK or a hull number agrees.'
        }
      />
    </Widget>
  );
}

function Sect({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="px-[14px] pb-[2px] pt-[6px] text-[12px] font-semibold uppercase tracking-[0.6px] text-txt-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }): JSX.Element {
  return (
    <div className="flex min-h-[20px] items-baseline gap-2 px-[14px] py-[1px] text-[12px]">
      <span className="min-w-0 flex-1 truncate text-txt-1">{k}</span>
      <span className="mono shrink-0 tabular-nums text-txt-2">{v}</span>
    </div>
  );
}

/** The distinction the whole card exists to preserve. */
function Empty({ ok, what }: { ok: boolean; what: string }): JSX.Element {
  return (
    <p className="px-[14px] py-[2px] text-[12px] leading-relaxed text-txt-3">
      {ok ? `${what} answered and had nothing.` : `${what} did not answer, so this is not a zero.`}
    </p>
  );
}
