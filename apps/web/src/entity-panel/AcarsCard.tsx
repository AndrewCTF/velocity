import { useEffect, useState } from 'react';
import { SectionLabel } from '../shell/instruments.js';
import { fetchAcars, originOf, systemOf, type AcarsMsg } from '../acars/acars.js';

// ACARS / datalink messages for the selected aircraft. The keyless airframes.io
// feed has NO per-aircraft query (filter params ignored, /search 404s) — it only
// serves the recent global firehose (≤100 msgs, community-station-shaped). So we
// pull that recent window (backend-cached 15s) and match it to THIS aircraft by
// ICAO24 hex (reliable), registration (tail), or callsign. A miss is normal and
// honest: most aircraft aren't in the last 100 messages, so we say exactly that
// rather than implying the aircraft has no datalink.

export function AcarsCard({
  kind,
  icao24,
  callsign,
  registration,
}: {
  kind: string;
  icao24?: string | null;
  callsign?: string | null;
  registration?: string | null;
}): JSX.Element | null {
  const [msgs, setMsgs] = useState<AcarsMsg[] | null>(null);
  const [err, setErr] = useState(false);

  const hex = icao24?.toLowerCase().trim() || null;
  const cs = callsign?.replace(/\s+/g, '').toUpperCase() || null;
  const reg = registration?.toUpperCase().trim() || null;

  useEffect(() => {
    if (kind !== 'aircraft') return;
    setMsgs(null);
    setErr(false);
    if (!hex && !cs && !reg) {
      setMsgs([]);
      return;
    }
    const ab = new AbortController();
    fetchAcars(100, ab.signal)
      .then((j) => {
        const match = (j.messages ?? [])
          .filter((m) => {
            if (hex && m.icao?.toLowerCase() === hex) return true;
            if (reg && m.tail?.toUpperCase() === reg) return true;
            if (cs && m.flight?.replace(/\s+/g, '').toUpperCase() === cs) return true;
            return false;
          })
          .sort((a, b) => Date.parse(b.t ?? '') - Date.parse(a.t ?? ''));
        setMsgs(match);
      })
      .catch(() => {
        if (!ab.signal.aborted) setErr(true);
      });
    return () => ab.abort();
  }, [kind, hex, cs, reg]);

  if (kind !== 'aircraft') return null;

  return (
    <section>
      <SectionLabel title="ACARS / datalink" {...(msgs && msgs.length ? { count: msgs.length } : {})} />
      {msgs === null && !err && (
        <p className="mono text-[10px] tracking-[0.7px] uppercase text-txt-3 mt-1.5">resolving…</p>
      )}
      {err && <p className="text-[11px] text-txt-3 mt-1.5">datalink feed unavailable</p>}
      {msgs && msgs.length === 0 && (
        <p className="text-[11px] text-txt-3 mt-1.5 leading-snug">
          No ACARS in the recent feed (last 100 msgs, airframes.io community coverage — dense over
          NA/EU/oceanic tracks). This aircraft hasn’t broadcast a datalink message in that window.
        </p>
      )}
      {msgs && msgs.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {msgs.slice(0, 12).map((m, i) => (
            <li key={m.id ?? i} className="border border-line rounded-sm p-2 bg-bg-2/60">
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="mono text-[10px] tracking-[0.5px] uppercase text-accent shrink-0">
                    {systemOf(m)}
                  </span>
                  <span
                    className={`mono text-[10px] uppercase px-1 rounded-sm shrink-0 ${
                      originOf(m) === 'pilot'
                        ? 'text-warn border border-[rgba(245,158,11,0.4)]'
                        : 'text-txt-3 border border-line'
                    }`}
                  >
                    {originOf(m) === 'pilot' ? 'pilot' : 'system'}
                  </span>
                  {m.label && <span className="mono text-[10px] text-txt-3 shrink-0">{m.label}</span>}
                </span>
                <span className="mono text-[10px] text-txt-3 tabular-nums shrink-0">
                  {m.t ? new Date(m.t).toISOString().slice(11, 19) + 'Z' : '—'}
                </span>
              </div>
              {m.text ? (
                <pre className="mono text-[10px] text-txt-1 leading-tight mt-1 whitespace-pre-wrap break-words">
                  {m.text}
                </pre>
              ) : (
                <p className="mono text-[10px] text-txt-3 mt-1">no free-text payload (control/position frame)</p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-1.5 mono text-[10px] text-txt-3 tabular-nums">
                {m.flight && <span>{m.flight}</span>}
                {m.tail && <span>{m.tail}</span>}
                {m.station && <span>rx {m.station}</span>}
                {typeof m.freq === 'number' && <span>{m.freq.toFixed(3)} MHz</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
