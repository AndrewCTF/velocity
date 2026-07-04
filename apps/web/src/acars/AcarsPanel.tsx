import { useEffect, useMemo, useState } from 'react';
import { SectionLabel } from '../shell/instruments.js';
import {
  fetchAcars,
  originOf,
  systemOf,
  ACARS_SYSTEMS,
  type AcarsMsg,
  type AcarsResponse,
} from './acars.js';

// All-aircraft ACARS feed browser. Pulls the recent airframes.io firehose
// (≤100, backend-cached 15s) and lets the operator filter by SYSTEM (datalink
// carrier: ACARS/VDL/HFDL/SATCOM) and ORIGIN (pilot/crew free-text vs automatic
// system message — inferred, see originOf). Coverage is community-station-shaped
// (dense NA/EU/oceanic), reported as measured, never asserted "global".

const ORIGINS = ['all', 'pilot', 'system'] as const;
type OriginFilter = (typeof ORIGINS)[number];
type SystemFilter = 'all' | (typeof ACARS_SYSTEMS)[number];

export function AcarsPanel(): JSX.Element {
  const [resp, setResp] = useState<AcarsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sys, setSys] = useState<SystemFilter>('all');
  const [origin, setOrigin] = useState<OriginFilter>('all');

  // Poll the firehose on a 20s grid (backend caches 15s, so this is cheap).
  useEffect(() => {
    let alive = true;
    const ab = new AbortController();
    const load = () => {
      fetchAcars(100, ab.signal)
        .then((r) => {
          if (alive) {
            setResp(r);
            setErr(null);
          }
        })
        .catch(() => {
          if (alive && !ab.signal.aborted) setErr('datalink feed unavailable');
        });
    };
    load();
    const t = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      ab.abort();
      window.clearInterval(t);
    };
  }, []);

  const all = resp?.messages ?? [];

  // Per-system / per-origin counts for the filter chips (computed over the full
  // pull so the chip badges reflect the whole feed, not the current filter).
  const counts = useMemo(() => {
    const bySys: Record<string, number> = {};
    let pilot = 0;
    let system = 0;
    for (const m of all) {
      const s = m.system ?? 'other';
      bySys[s] = (bySys[s] ?? 0) + 1;
      if (originOf(m) === 'pilot') pilot += 1;
      else system += 1;
    }
    return { bySys, pilot, system };
  }, [all]);

  const filtered = useMemo(
    () =>
      all
        .filter((m) => (sys === 'all' ? true : m.system === sys))
        .filter((m) => (origin === 'all' ? true : originOf(m) === origin))
        .sort((a, b) => Date.parse(b.t ?? '') - Date.parse(a.t ?? '')),
    [all, sys, origin],
  );

  return (
    <div className="p-4 space-y-4">
      <SectionLabel title="ACARS / datalink" count={resp ? `${filtered.length}/${all.length}` : ''} />
      <p className="mono text-[10px] text-txt-3 leading-snug -mt-2">
        airframes.io keyless firehose · last {all.length} msgs · community coverage (dense NA/EU/oceanic)
      </p>

      <div className="space-y-2">
        <FacetRow
          label="System"
          options={['all', ...ACARS_SYSTEMS]}
          value={sys}
          onChange={(v) => setSys(v as SystemFilter)}
          countFor={(v) =>
            v === 'all' ? all.length : counts.bySys[v] ?? 0
          }
        />
        <FacetRow
          label="Origin"
          options={ORIGINS as readonly string[]}
          value={origin}
          onChange={(v) => setOrigin(v as OriginFilter)}
          countFor={(v) =>
            v === 'all' ? all.length : v === 'pilot' ? counts.pilot : counts.system
          }
        />
      </div>
      <p className="mono text-[10px] text-txt-3 -mt-1">origin (pilot vs system) inferred from ACARS label + payload</p>

      {err && <p className="text-[11px] text-alert">{err}</p>}
      {!resp && !err && (
        <p className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3">resolving…</p>
      )}
      {resp && filtered.length === 0 && !err && (
        <p className="text-[11px] text-txt-3">no messages match this filter in the recent feed</p>
      )}

      <ul className="space-y-1.5">
        {filtered.map((m, i) => (
          <AcarsRow key={m.id ?? i} m={m} />
        ))}
      </ul>
    </div>
  );
}

function FacetRow({
  label,
  options,
  value,
  onChange,
  countFor,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  countFor: (v: string) => number;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="mono text-[10px] uppercase tracking-[0.08em] text-txt-3 w-12 shrink-0">{label}</span>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            type="button"
            onClick={() => onChange(o)}
            className={`mono text-[10px] uppercase px-1.5 py-0.5 rounded-sm border ${
              active
                ? 'border-accent-line text-accent bg-bg-2'
                : 'border-line text-txt-3 hover:text-txt-1'
            }`}
          >
            {o === 'all' ? 'all' : o}
            <span className="ml-1 tabular-nums opacity-70">{countFor(o)}</span>
          </button>
        );
      })}
    </div>
  );
}

function AcarsRow({ m }: { m: AcarsMsg }): JSX.Element {
  const isPilot = originOf(m) === 'pilot';
  return (
    <li className="border border-line rounded-sm p-2 bg-bg-2/60">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="mono text-[10px] uppercase tracking-[0.5px] text-accent shrink-0">{systemOf(m)}</span>
          <span
            className={`mono text-[10px] uppercase px-1 rounded-sm shrink-0 ${
              isPilot ? 'text-warn border border-[rgba(245,158,11,0.4)]' : 'text-txt-3 border border-line'
            }`}
          >
            {isPilot ? 'pilot' : 'system'}
          </span>
          {m.label && <span className="mono text-[10px] text-txt-3 shrink-0">{m.label}</span>}
        </span>
        <span className="mono text-[10px] text-txt-3 tabular-nums shrink-0">
          {m.t ? new Date(m.t).toISOString().slice(11, 19) + 'Z' : '—'}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-1 mono text-[10px] text-txt-2 tabular-nums">
        {m.flight && <span className="text-txt-1">{m.flight}</span>}
        {m.tail && <span>{m.tail}</span>}
        {m.icao && <span className="text-txt-3">{m.icao.toUpperCase()}</span>}
        {m.station && <span className="text-txt-3">rx {m.station}</span>}
        {typeof m.freq === 'number' && <span className="text-txt-3">{m.freq.toFixed(3)}</span>}
      </div>
      {m.text && (
        <pre className="mono text-[10px] text-txt-1 leading-tight mt-1 whitespace-pre-wrap break-words">
          {m.text}
        </pre>
      )}
    </li>
  );
}
