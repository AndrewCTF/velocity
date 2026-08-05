import { useEffect, useState } from 'react';
import { Widget, Caveat } from '../shell/instruments.js';
import { apiFetch } from '../transport/http.js';

// Sanctions screening for the selected contact, run against the identifiers the
// feed already carries. docs/plan-99-2026-08.md §3.
//
// Three things this card refuses to do, each of which is how a screening tool
// produces a wrong answer that looks confident:
//
//  1. It never renders a designation without saying which identifier matched.
//     An IMO hit and a name hit are not the same claim.
//  2. It never renders "clear" as an absence. A miss is a stated result with
//     the identifiers that were tried, because "we checked and found nothing"
//     and "we did not check" have to look different.
//  3. It never implies the check was exhaustive. Only OFAC is loaded, and the
//     card says so on both the hit and the miss.

interface Match {
  name: string;
  type: string;
  programs: string[];
  imo: number | null;
  mmsi: number | null;
  call_sign: string | null;
  vessel_flag: string | null;
  vessel_owner: string | null;
  remarks: string | null;
  matched_on: string;
  confidence: string;
  list: string;
  lists: string[];
  source_url: string;
}

interface LookupResponse {
  matched: boolean;
  match: Match | null;
  tried: Record<string, string | number>;
  /** Lists that actually loaded for this check. */
  lists: string[];
  /** Lists that did not, keyed by name. A source that dropped out must never
   *  read as a source that found nothing. */
  failed: Record<string, string>;
}

type State = { status: 'loading' } | { status: 'error'; code: number } | { status: 'done'; data: LookupResponse };

export function SanctionsCard({
  imo,
  mmsi,
  callSign,
  name,
  registration,
}: {
  imo?: number | null;
  mmsi?: number | null;
  callSign?: string | null;
  name?: string | null;
  registration?: string | null;
}): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);

  const q = new URLSearchParams();
  if (imo && imo > 0) q.set('imo', String(imo));
  if (mmsi && mmsi > 0) q.set('mmsi', String(mmsi));
  if (callSign) q.set('call_sign', callSign);
  if (name) q.set('name', name);
  if (registration) q.set('registration', registration);
  const qs = q.toString();

  useEffect(() => {
    if (!qs) {
      setState(null);
      return;
    }
    setState({ status: 'loading' });
    const ab = new AbortController();
    apiFetch(`/api/sanctions/lookup?${qs}`, { signal: ab.signal })
      .then(async (r) => {
        if (ab.signal.aborted) return;
        if (!r.ok) {
          setState({ status: 'error', code: r.status });
          return;
        }
        setState({ status: 'done', data: (await r.json()) as LookupResponse });
      })
      .catch(() => {
        if (!ab.signal.aborted) setState({ status: 'error', code: 0 });
      });
    return () => ab.abort();
  }, [qs]);

  if (!qs || !state) return null;

  if (state.status === 'loading') {
    return (
      <Widget title="Sanctions">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-3">checking…</div>
      </Widget>
    );
  }
  if (state.status === 'error') {
    return (
      <Widget title="Sanctions">
        <div className="px-[14px] py-[6px] text-[12px] text-txt-2">
          {state.code
            ? `Sanctions list unavailable (HTTP ${state.code})`
            : 'Sanctions list unavailable'}
        </div>
      </Widget>
    );
  }

  const { matched, match, tried, lists = [], failed = {} } = state.data;
  const triedLabel = Object.keys(tried).join(' · ') || 'nothing';
  const listsLabel = lists.join(' · ') || 'no list';
  const missing = Object.keys(failed);

  if (!matched || !match) {
    return (
      <Widget title="Sanctions">
        <div className="flex items-center gap-2 px-[14px] py-[6px] text-[12px]">
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-ok" aria-hidden="true" />
          <span className="text-txt-1">No OFAC designation</span>
        </div>
        <Caveat
          tone={missing.length ? 'warn' : 'neutral'}
          note={
            missing.length
              ? `Checked on ${triedLabel} against ${listsLabel}. ${missing.join(' · ')} did not load, so this is not a clearance against ${missing.length === 1 ? 'it' : 'them'}.`
              : `Checked on ${triedLabel} against ${listsLabel}. The EU list is not among them, and it publishes no machine-readable vessel export.`
          }
        />
      </Widget>
    );
  }

  const exact = match.confidence === 'exact';
  return (
    <Widget title="Sanctions">
      <div className="flex items-center gap-2 px-[14px] py-[6px]">
        <span
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${exact ? 'bg-alert' : 'bg-warn'}`}
          aria-hidden="true"
        />
        <span className={`text-[12px] font-semibold ${exact ? 'text-alert-fg' : 'text-warn-fg'}`}>
          {exact ? 'Designated' : 'Possible designation'}
        </span>
        <span className="mono ml-auto text-[12px] text-txt-3">
          matched on {match.matched_on}
        </span>
      </div>
      <Row k="Listed by" v={(match.lists ?? [match.list]).join(' · ')} />
      <Row k="Listed as" v={match.name} />
      <Row k="Programs" v={match.programs.join(' · ') || null} />
      <Row k="Flag" v={match.vessel_flag} />
      <Row k="Registered owner" v={match.vessel_owner} />
      <Row k="IMO" v={match.imo ? String(match.imo) : null} />
      <Row k="MMSI" v={match.mmsi ? String(match.mmsi) : null} />
      <Row k="Call sign" v={match.call_sign} />
      {match.remarks && (
        <p className="px-[14px] pb-[6px] pt-[4px] text-[12px] leading-relaxed text-txt-2">
          {match.remarks}
        </p>
      )}
      <Caveat
        tone={exact ? 'alert' : 'warn'}
        note={
          exact
            ? `Matched on ${match.matched_on} against ${listsLabel}.`
            : `Matched on ${match.matched_on} against ${listsLabel}. A name or a call sign is not an identifier, so treat this as a candidate until the hull number agrees.`
        }
      />
    </Widget>
  );
}

function Row({ k, v }: { k: string; v: string | null }): JSX.Element {
  return (
    <div className="flex min-h-[20px] items-baseline gap-2 px-[14px] py-[1px] text-[12px]">
      <span className="min-w-0 flex-1 truncate text-txt-3">{k}</span>
      <span className={`mono shrink-0 tabular-nums ${v ? 'text-txt-1' : 'text-txt-3'}`}>
        {v ?? '—'}
      </span>
    </div>
  );
}
